/**
 * The catalog read.
 *
 * `catalog` owns no tables. It is a read surface over `artworks` and
 * `accounts` (ARCHITECTURE.md's dependency table lets it call exactly those
 * two), and everything below is a SELECT. There is no catalog migration, no
 * materialised view and no denormalised copy of an artwork, because every one
 * of those would be a second answer to "what is published right now" that has
 * to be kept agreeing with the first.
 *
 * WHY THE VISIBILITY PREDICATE IS WRITTEN OUT HERE
 * -----------------------------------------------
 * An artwork is public when its status is `published` AND its artist is not
 * suspended. That rule already exists three times: as the RLS policy on
 * `artworks`, as `artworks.is_publicly_visible(uuid)` in SQL, and as the
 * `NOT_SUSPENDED` fragment inside `artworks/queries.ts`. None of the three is
 * usable here -- the policy does not apply to the server connection, the SQL
 * function costs a correlated lookup per candidate row before the `limit` can
 * apply, and the fragment is module-private.
 *
 * So this file states it a fourth time, as an anti-join Postgres can hash, and
 * pays for that with a test: `catalog-visibility.test.ts` asserts that for the
 * same set of rows this query and `artworks.findPublicArtwork` /
 * `artworks.isPubliclyVisible` agree, including the suspended case. Drift
 * becomes a failing test rather than a suspended artist's work quietly staying
 * on the busiest page in the product. Exporting the fragment from `artworks`
 * would be better and is reported upstream; this is the version that does not
 * require editing another team's module.
 *
 * WHY SOLD-OUT NEEDS NO SEPARATE PREDICATE
 * ----------------------------------------
 * catalog-browse excludes sold-out artworks. It is tempting to filter on
 * derived availability here, and it would be wrong: availability comes from an
 * injected port (`orders` owns reservations), so it is not available to SQL,
 * and filtering it in JavaScript after the `limit` would make every page a
 * different size and the total count a lie.
 *
 * The exclusion is already correct without any of that. `artworks`
 * reconciles a published artwork with zero available units to `sold` inside the
 * transaction that consumed the last unit (`reconcileAvailability`), and `sold`
 * is not `published`. One rule, enforced where the write happens, rather than a
 * second copy of it on the read path that could disagree.
 */
import { AppError } from "@/shared/errors";
import type { Sql } from "@/shared/db";
import {
  ARTWORK_COLUMNS,
  availabilityFor,
  findPublicArtwork,
  toArtwork,
  toPublicArtwork,
  toPublicImages,
  ZERO_DEMAND,
  type ArtworkImage,
  type ArtworkRow,
  type ArtworksDeps,
  type PublicArtwork,
} from "@/modules/artworks";
import {
  PUBLIC_ARTIST_COLUMNS,
  toPublicArtist,
  type ArtistProfileRow,
  type PublicArtist,
} from "@/modules/accounts";
import {
  DEFAULT_QUERY,
  hasActiveFilters,
  type CatalogFilters,
  type CatalogQuery,
  type CatalogSort,
} from "./filters";

/**
 * What `catalog` needs handed to it: exactly what `artworks` needs.
 *
 * Not a new interface with the same three fields. Every read here ultimately
 * runs through an `artworks` function or derives availability the way `artworks`
 * does, so a separate deps type would be a second thing to wire and a second
 * thing to forget to wire -- and the one field that must never be forgotten is
 * `demand`, whose unwired placeholder makes everything look fully available.
 */
export type CatalogDeps = ArtworksDeps;

/**
 * How many artworks a page shows.
 *
 * ARCHITECTURE.md puts every configurable number in `app_config`, and this
 * one belongs there as `catalog.page_size`. That key is not registered yet --
 * `shared/config/registry.ts` is owned elsewhere and this module may not edit
 * it -- so the number lives here as a named constant and `browseCatalog` takes
 * an override, which is the seam the configured value plugs into with no other
 * change. Registering the key is reported upstream.
 *
 * 24 because the approved catalog grid is three columns
 * (design/Catalog.dc.html) and 24 fills eight complete rows.
 */
export const DEFAULT_PAGE_SIZE = 24;

/** Above this a single page could return the whole table; see `resolvePageSize`. */
export const MAX_PAGE_SIZE = 60;

function resolvePageSize(requested: number | undefined): number {
  if (requested === undefined) return DEFAULT_PAGE_SIZE;
  return Math.min(Math.max(Math.trunc(requested), 1), MAX_PAGE_SIZE);
}

/**
 * One card's worth of data.
 *
 * The artist is a whole `PublicArtist` rather than a bare display name because
 * the card in `artworks` wants the name and the artist link wants the id, and
 * threading two loose strings through is how the wrong id ends up under the
 * right name. It arrives through `accounts.toPublicArtist()`, which is the only
 * serializer permitted to shape artist data for a buyer (ARCHITECTURE.md).
 */
export interface CatalogEntry {
  readonly artwork: PublicArtwork;
  readonly artist: PublicArtist;
}

export interface CatalogPage {
  readonly entries: readonly CatalogEntry[];
  /** Matching this query, across all pages. */
  readonly total: number;
  readonly page: number;
  readonly pageSize: number;
  readonly pageCount: number;
  readonly query: CatalogQuery;
  /**
   * Nothing is published at all — as distinct from "these filters matched
   * nothing".
   *
   * catalog-browse asks for two different empty states and they say opposite
   * things: one invites artists to join, the other offers to clear a filter.
   * Telling a visitor to clear filters on a catalog that has no artworks in it
   * sends them round a loop, and PACHKA launches with zero artists, so this is
   * the state the first visitors actually see.
   */
  readonly catalogIsEmpty: boolean;
}

/**
 * The `order by` for each sort, as a frozen lookup.
 *
 * A lookup and not a built string: `sort` originates in a URL, and the one
 * place user input could reach SQL as text rather than as a parameter is an
 * `order by`, which cannot be parameterised. `CatalogSort` is a closed union
 * and this record is total over it, so there is no path from a request to a
 * fragment that is not one of these three literals.
 *
 * Every one ends in `a.id`. Without a unique tiebreak, two artworks published
 * in the same millisecond (a batch import) or priced identically (common) have
 * no defined order between pages, and the same artwork can appear on page 1 and
 * page 2 while another appears on neither.
 */
const ORDER_BY: Readonly<Record<CatalogSort, string>> = {
  newest: "a.published_at desc nulls last, a.id",
  price_asc: "a.price_agorot asc, a.id",
  price_desc: "a.price_agorot desc, a.id",
};

/**
 * The public-visibility predicate. See the file header for why it is here.
 *
 * `not exists` rather than a left join with a null test so that the planner is
 * free to use an anti-join, and so that a second `account_status` row could
 * never duplicate an artwork into the grid.
 */
const VISIBLE = `
      a.status = 'published'
  and not exists (
        select 1
          from account_status s
         where s.user_id = a.artist_id
           and s.suspended_at is not null
      )`;

/**
 * The filter clauses.
 *
 * Every axis is `$n is null or <test>`, which keeps ONE statement for the query
 * whatever combination arrives, so a three-axis filter is not a different code
 * path from a one-axis filter -- the spec's combined-filter scenario and its
 * single-filter scenario exercise the same SQL.
 *
 * `&&` is array overlap: OR within an axis. Combined with the `and` between the
 * clauses, that is exactly "OR within an axis, AND across axes" (see
 * `CatalogFilters`), and it is what the gin indexes on `styles`,
 * `target_spaces` and `moods` are built to answer.
 */
const FILTERS = `
  and ($1::text[] is null or a.medium = any($1::text[]))
  and ($2::text[] is null or a.styles        && $2::text[])
  and ($3::text[] is null or a.target_spaces && $3::text[])
  and ($4::text[] is null or a.moods         && $4::text[])
  and ($5::bigint is null or a.price_agorot >= $5::bigint)
  and ($6::bigint is null or a.price_agorot <= $6::bigint)`;

/** `null` for an empty axis, so the clause above short-circuits rather than testing `&& '{}'`. */
function axisParam(values: readonly string[]): string[] | null {
  return values.length === 0 ? null : [...values];
}

/**
 * The six filter parameters, in the order `FILTERS` numbers them.
 *
 * Built once and used by both the page query and the count, so the two cannot
 * be asking different questions -- which is exactly how a result set and its
 * "N results" heading come to disagree.
 */
function filterParams(filters: CatalogFilters): readonly (string[] | string | null)[] {
  return [
    axisParam(filters.media),
    axisParam(filters.styles),
    axisParam(filters.targetSpaces),
    axisParam(filters.moods),
    priceParam(filters.minPriceAgorot),
    priceParam(filters.maxPriceAgorot),
  ];
}

/**
 * How many artworks match, ignoring pagination.
 *
 * Needed because the page query carries its total in a window function, which
 * only comes back attached to a row. Ask for page nine of a one-page catalog
 * and there are no rows, so there is no total either -- and a total that reads
 * zero whenever a visitor overshoots would blank the result count and remove
 * the "previous page" link that is the only way back. So when the page is
 * empty, the count is asked for separately rather than assumed.
 */
async function countMatching(sql: Sql, filters: CatalogFilters): Promise<number> {
  const row = await sql.one<{ total: string }>(
    `select count(*)::text as total
       from artworks a
      where ${VISIBLE}
        ${FILTERS}`,
    [...filterParams(filters)],
  );
  return Number(row.total);
}

/**
 * A bigint parameter for money.
 *
 * Sent as a string. `price_agorot` is `bigint`, node-postgres round-trips it as
 * text, and passing a JavaScript number here would be the one place in the
 * module where money touched a float representation.
 */
function priceParam(value: number | null): string | null {
  return value === null ? null : String(value);
}

interface CatalogRow extends ArtworkRow {
  readonly total_count: string;
}

interface ImageRow {
  readonly id: string;
  readonly artwork_id: string;
  readonly original_path: string;
  readonly display_path: string | null;
  readonly thumbnail_path: string | null;
  readonly alt_text: string | null;
  readonly width_px: number | null;
  readonly height_px: number | null;
  readonly position: number;
}

/**
 * Primary images for a page of artworks, in one query.
 *
 * Only `position = 0`. A card renders one image, and fetching every image for
 * twenty-four artworks to show twenty-four of them would multiply the row count
 * by the image limit on the highest-traffic page in the product.
 *
 * The row is mapped to `artworks.ArtworkImage` and handed to that module's
 * `toPublicImages`, rather than being shaped into a public image here. The
 * fallback from a missing derivative to the original lives in exactly one
 * place, and a second copy of it in this file would be the copy that stops
 * matching after the upload pipeline changes. `artworks` has no batched image
 * read to call instead; adding one is reported upstream.
 */
async function primaryImagesFor(
  sql: Sql,
  artworkIds: readonly string[],
): Promise<ReadonlyMap<string, ArtworkImage>> {
  if (artworkIds.length === 0) return new Map();

  const { rows } = await sql.query<ImageRow>(
    `select id, artwork_id, original_path, display_path, thumbnail_path,
            alt_text, width_px, height_px, position
       from artwork_images
      where artwork_id = any($1::uuid[]) and position = 0`,
    [[...artworkIds]],
  );

  return new Map(
    rows.map((row) => [
      row.artwork_id,
      {
        id: row.id,
        artworkId: row.artwork_id,
        originalPath: row.original_path,
        displayPath: row.display_path,
        thumbnailPath: row.thumbnail_path,
        altText: row.alt_text,
        widthPx: row.width_px,
        heightPx: row.height_px,
        position: row.position,
        isPrimary: true,
      } satisfies ArtworkImage,
    ]),
  );
}

/**
 * Artists for a page of artworks, in one query.
 *
 * The column list is `accounts.PUBLIC_ARTIST_COLUMNS`, imported rather than
 * typed out, and every row goes through `accounts.toPublicArtist`. Both are
 * exported by that module precisely so a buyer-facing query elsewhere shapes
 * artist data the one sanctioned way: shaping happens AT THE QUERY, because a
 * wide row handed to a component is serialised into the RSC payload in the HTML
 * whatever the JSX renders (SECURITY.md S1-8).
 *
 * Reading `artist_profiles` from here is a cross-module READ, which
 * ARCHITECTURE.md permits ("Foreign keys across module boundaries are permitted
 * and expected. Writes are not."). `accounts.findPublicArtist` is per-artist and
 * a grid of twenty-four would be twenty-four round trips.
 */
async function artistsFor(
  sql: Sql,
  artistIds: readonly string[],
): Promise<ReadonlyMap<string, PublicArtist>> {
  if (artistIds.length === 0) return new Map();

  const { rows } = await sql.query<ArtistProfileRow>(
    `select ${PUBLIC_ARTIST_COLUMNS} from artist_profiles where user_id = any($1::uuid[])`,
    [[...artistIds]],
  );

  return new Map(rows.map((row) => [row.user_id, toPublicArtist(row)]));
}

export interface BrowseOptions {
  /** Overrides `DEFAULT_PAGE_SIZE`. The seam `catalog.page_size` plugs into. */
  readonly pageSize?: number;
}

/**
 * A page of the catalog.
 *
 * Four queries, whatever the filters: the page itself (with its total, from a
 * window function, so there is no separate `count(*)` running the same
 * predicate twice), the primary images, the artists, and the demand batch. The
 * fifth -- the published-artwork count that separates "nothing matched" from
 * "nothing is published" -- runs only when the page came back empty.
 */
export async function browseCatalog(
  deps: CatalogDeps,
  query: CatalogQuery = DEFAULT_QUERY,
  options: BrowseOptions = {},
): Promise<CatalogPage> {
  const pageSize = resolvePageSize(options.pageSize);
  const page = Math.max(1, Math.trunc(query.page));
  const offset = (page - 1) * pageSize;

  const { filters, sort } = query;

  const { rows } = await deps.db.query<CatalogRow>(
    `select ${ARTWORK_COLUMNS}, count(*) over () as total_count
       from artworks a
      where ${VISIBLE}
        ${FILTERS}
      order by ${ORDER_BY[sort]}
      limit $7 offset $8`,
    [...filterParams(filters), pageSize, offset],
  );

  const artworks = rows.map(toArtwork);
  const artworkIds = artworks.map((artwork) => artwork.id);
  const artistIds = [...new Set(artworks.map((artwork) => artwork.artistId))];

  const [images, artists, demand] = await Promise.all([
    primaryImagesFor(deps.db, artworkIds),
    artistsFor(deps.db, artistIds),
    deps.demand.demandForMany(deps.db, artworkIds),
  ]);

  const entries: CatalogEntry[] = [];
  for (const artwork of artworks) {
    const artist = artists.get(artwork.artistId);

    // A published artwork whose artist row is missing is a broken foreign key,
    // not a card to render half of. `artist_id` references `artist_profiles`,
    // so this cannot happen; skipping rather than throwing keeps one corrupt
    // row from taking down the whole catalog page if it ever does.
    if (artist === undefined) continue;

    const image = images.get(artwork.id);

    entries.push({
      artwork: toPublicArtwork({
        artwork,
        availability: availabilityFor(artwork, demand.get(artwork.id) ?? ZERO_DEMAND),
        images: image === undefined ? [] : toPublicImages([image]),
      }),
      artist,
    });
  }

  const first = rows[0];
  const total = first === undefined ? await countMatching(deps.db, filters) : Number(first.total_count);

  return {
    entries,
    total,
    page,
    pageSize,
    pageCount: total === 0 ? 0 : Math.ceil(total / pageSize),
    query: { ...query, page },
    catalogIsEmpty: await resolveCatalogIsEmpty(deps.db, query, total),
  };
}

/**
 * Which of the two empty states applies.
 *
 * Only asked when there is something to decide. A page with results is not
 * empty by either definition, and an empty result with no filters applied
 * already answers the question -- the unfiltered catalog IS the whole catalog,
 * so the extra query would be asking something already known. That leaves one
 * case: filters are on and matched nothing, where the difference between "try
 * clearing the mood filter" and "PACHKA is still gathering its first artists"
 * is the whole message.
 */
async function resolveCatalogIsEmpty(
  sql: Sql,
  query: CatalogQuery,
  total: number,
): Promise<boolean> {
  if (total > 0) return false;
  if (!hasActiveFilters(query.filters)) return true;
  return (await countPublishedArtworks(sql)) === 0;
}

/**
 * How many artworks are publicly visible, ignoring every filter.
 *
 * Exported because the same number decides whether the home page shows a
 * catalog at all, and because `matchmaker` has a configured sparse-catalog
 * threshold to compare against something.
 */
export async function countPublishedArtworks(sql: Sql): Promise<number> {
  const row = await sql.one<{ total: string }>(
    `select count(*)::text as total from artworks a where ${VISIBLE}`,
  );
  return Number(row.total);
}

// ---------------------------------------------------------------------------
// The detail page
// ---------------------------------------------------------------------------

export interface CatalogArtworkDetail {
  readonly artwork: PublicArtwork;
  readonly artist: PublicArtist;
  /**
   * Whether the artist's profile page exists to be linked to.
   *
   * catalog-browse wants the display name "linking to their profile", and
   * `accounts` makes a profile public only for an artist with at least one
   * PUBLISHED artwork. An artist whose single piece has sold therefore has a
   * detail page that must still render (the spec requires sold artworks to
   * resolve read-only) and no profile page behind the link. Rendering the link
   * anyway would send a buyer to a 404, so the view renders the name as plain
   * text instead and this flag is how it knows.
   */
  readonly artistProfileIsPublic: boolean;
}

/**
 * Postgres raises a type error on a malformed uuid, and an error page that
 * differs from the not-found page tells a prober they got the shape right
 * (SECURITY.md S3-29). Same guard, same reasoning, as the artist route.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * One artwork's detail page.
 *
 * The visibility decision is `artworks.findPublicArtwork`'s and is not repeated
 * here: it raises `not_found` for a draft, for a removed artwork and for a
 * suspended artist's work, and resolves sold and unlisted ones so they can
 * render read-only. catalog-browse asks for exactly that split, and it is one
 * rule in one place rather than a second copy on this side of the boundary.
 */
export async function findCatalogArtwork(
  deps: CatalogDeps,
  artworkId: string,
): Promise<CatalogArtworkDetail> {
  if (!UUID.test(artworkId)) {
    throw AppError.notFound("Artwork not found", { code: "artworks.not_found" });
  }

  const artwork = await findPublicArtwork(deps, artworkId);

  const artists = await artistsFor(deps.db, [artwork.artistId]);
  const artist = artists.get(artwork.artistId);
  if (artist === undefined) {
    // `artworks.artist_id` references `artist_profiles`, so the row exists.
    throw AppError.notFound("Artwork not found", { code: "artworks.not_found" });
  }

  return {
    artwork,
    artist,
    artistProfileIsPublic: await artistProfileIsPublic(deps.db, artwork.artistId),
  };
}

/**
 * Whether `/artists/<id>` would resolve.
 *
 * Asks `accounts`' own SQL predicate rather than re-deriving it, so this
 * module's answer and the artist route's answer cannot disagree — a link
 * rendered on the strength of a local copy of the rule is a link to a 404 the
 * moment the two drift.
 */
async function artistProfileIsPublic(sql: Sql, artistId: string): Promise<boolean> {
  const row = await sql.one<{ visible: boolean }>(
    "select accounts.artist_is_publicly_visible($1::uuid) as visible",
    [artistId],
  );
  return row.visible === true;
}
