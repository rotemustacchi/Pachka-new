/**
 * Buyer-facing reads.
 *
 * The `catalog` module builds listing, filtering and sorting on top of this;
 * what lives here is the single-artwork read and the visibility rule both
 * surfaces have to agree on, so that "which artworks exist" has one answer
 * rather than one per page.
 *
 * VISIBILITY IS TWO CONDITIONS, ALWAYS TOGETHER
 * ---------------------------------------------
 * An artwork is publicly visible when its status allows it AND its artist is
 * not suspended. SECURITY.md S1-13 item 3 requires the second half to be
 * DERIVED rather than applied by bulk-updating artwork rows at suspension time,
 * because moderation-admin requires lifting a suspension to restore the
 * previous state "excluding any individually removed" -- and a bulk update
 * destroys the information needed to tell those apart.
 *
 * The same pair of conditions is written into the RLS policy on the table, so
 * an anonymous caller hitting the PostgREST data API directly gets the same
 * answer this function gives. Two statements of one rule, and the anon-exposure
 * integration test is what keeps them agreeing.
 */
import { AppError } from "@/shared/errors";
import type { Sql } from "@/shared/db";
import type { ArtworksDeps } from "./deps";
import { imagesFor, toPublicImages } from "./images";
import { availabilityFor } from "./inventory";
import { isBuyerVisible } from "./lifecycle";
import { toPublicArtwork, type PublicArtwork } from "./serialize";
import { ARTWORK_COLUMNS, toArtwork, type Artwork, type ArtworkRow } from "./types";

/**
 * The suspension predicate, as a SQL fragment.
 *
 * Reads `account_status`, which `accounts` owns. That is a cross-module READ,
 * which ARCHITECTURE.md permits -- "Foreign keys across module boundaries are
 * permitted and expected. Writes are not." Doing it as a join rather than an
 * `accounts` call per artwork is what keeps a catalog page one query; the
 * alternative is a suspension lookup per row.
 */
const NOT_SUSPENDED = `
  not exists (
    select 1 from account_status s
     where s.user_id = a.artist_id and s.suspended_at is not null
  )`;

/**
 * One artwork, as a buyer sees it.
 *
 * `not_found` for a draft and for a removed artwork. catalog-browse requires
 * exactly that for removed ones, and the same answer for drafts keeps an
 * artwork id from being a probe for "does this exist yet" (SECURITY.md S3-29).
 *
 * Sold and unlisted artworks DO resolve, and render read-only with no purchase
 * action -- `purchasable` on the returned availability is what the page keys
 * off. A buyer who bookmarked a piece that has since sold deserves the page,
 * not a 404.
 */
export async function findPublicArtwork(
  deps: ArtworksDeps,
  artworkId: string,
): Promise<PublicArtwork> {
  const row = await deps.db.maybeOne<ArtworkRow>(
    `select ${ARTWORK_COLUMNS} from artworks a where a.id = $1 and ${NOT_SUSPENDED}`,
    [artworkId],
  );

  if (row === null) {
    throw AppError.notFound("Artwork not found", { code: "artworks.not_found" });
  }

  const artwork = toArtwork(row);
  if (!isBuyerVisible(artwork.status)) {
    throw AppError.notFound("Artwork not found", { code: "artworks.not_found" });
  }

  const [demand, images] = await Promise.all([
    deps.demand.demandFor(deps.db, artwork.id),
    imagesFor(deps.db, artwork.id),
  ]);

  return toPublicArtwork({
    artwork,
    availability: availabilityFor(artwork, demand),
    images: toPublicImages(images),
  });
}

/**
 * The published artworks, newest first.
 *
 * A deliberately plain read: `catalog` owns filtering, sorting and pagination
 * and will build them on the same visibility predicate. This exists so that the
 * predicate has exactly one implementation, and so that `accounts`'
 * `artist_has_published_artwork` -- which decides whether an artist profile is
 * public at all -- is asking the same question this is.
 */
export async function listPublishedArtworks(
  sql: Sql,
  options: { readonly limit?: number; readonly offset?: number } = {},
): Promise<readonly Artwork[]> {
  const limit = Math.min(Math.max(options.limit ?? 24, 1), 100);
  const offset = Math.max(options.offset ?? 0, 0);

  const { rows } = await sql.query<ArtworkRow>(
    `select ${ARTWORK_COLUMNS}
       from artworks a
      where a.status = 'published' and ${NOT_SUSPENDED}
      order by a.published_at desc nulls last, a.id
      limit $1 offset $2`,
    [limit, offset],
  );

  return rows.map(toArtwork);
}

/** Whether an artwork is on public surfaces right now. The matchmaker's filter. */
export async function isPubliclyVisible(sql: Sql, artworkId: string): Promise<boolean> {
  const row = await sql.maybeOne<{ visible: boolean }>(
    `select true as visible
       from artworks a
      where a.id = $1 and a.status = 'published' and ${NOT_SUSPENDED}`,
    [artworkId],
  );
  return row !== null;
}
