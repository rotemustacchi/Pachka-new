/**
 * The artist's own view of their listings.
 *
 * Task 3.10: "state, price, stock, and match impressions". Everything an artist
 * owns, in every state, including the ones no buyer can see -- artwork-listings
 * is explicit that an unlisted artwork "remains visible in the artist's
 * dashboard", and a removed one appears too, because an artist whose work was
 * taken down needs to see that it was rather than find an empty space.
 *
 * WHY THIS IS THREE QUERIES AND NOT FORTY
 * ---------------------------------------
 * Stock is ours. Reserved and sold units belong to `orders`; impressions belong
 * to `matchmaker`; neither is a column we can join to, because the dependency
 * table points those modules at us rather than the reverse (see deps.ts). Both
 * ports therefore take a LIST of artwork ids and answer for all of them at
 * once. Per-artwork ports would have made this a query per row -- the classic
 * N+1 -- and would have made the batching impossible to add later without
 * changing an interface two other teams had already implemented.
 */
import type { Sql } from "@/shared/db";
import { formatAgorot, type Agorot } from "@/shared/money";
import type { ArtworksDeps } from "./deps";
import { availableUnits, oversoldBy, type InventoryDemand } from "./inventory";
import { ARTWORK_STATUS_LABELS, permittedTransitions } from "./lifecycle";
import { asPublishCandidate, missingForPublication, type MissingRequirement } from "./publish-requirements";
import { MEDIUM_LABELS, type Medium } from "./taxonomy";
import { ARTWORK_COLUMNS, toArtwork, type ArtworkRow, type ArtworkStatus, type InventoryType } from "./types";

/** One row of the dashboard table. */
export interface DashboardListing {
  readonly id: string;
  readonly title: string | null;
  readonly status: ArtworkStatus;
  readonly statusLabel: string;

  readonly priceAgorot: Agorot | null;
  /** "₪1,250.00", or `null` for a draft with no price yet. */
  readonly priceFormatted: string | null;

  readonly medium: string | null;
  readonly mediumLabel: string | null;

  readonly inventoryType: InventoryType;
  /** The declared edition size. */
  readonly stock: number;
  readonly reservedUnits: number;
  readonly soldUnits: number;
  /** Derived: `stock - reservedUnits - soldUnits`. Never read from a column. */
  readonly availableUnits: number;

  /**
   * Lifetime match impressions (art-matchmaker: recorded per artwork and
   * "surfaced to artists and admins"). Zero until the matchmaker is wired in.
   */
  readonly matchImpressions: number;

  readonly primaryImagePath: string | null;

  /**
   * What still stands between this artwork and publication. Empty for anything
   * already published. This is what turns the dashboard from a list into
   * something an artist can act on: the draft that has been sitting there for
   * three weeks says which two fields it is waiting for.
   */
  readonly missingForPublication: readonly MissingRequirement[];

  /** Which buttons to render. Asks the state machine rather than re-deriving it. */
  readonly availableActions: readonly ArtworkStatus[];

  /**
   * Committed beyond the declared stock. Always zero in a healthy system; a
   * non-zero value means reservations and sales outran the edition size, which
   * is a reservation bug and is worth surfacing rather than clamping away.
   */
  readonly oversoldBy: number;

  readonly createdAt: string;
  readonly publishedAt: string | null;
}

export interface DashboardSummary {
  readonly total: number;
  readonly byStatus: Readonly<Record<ArtworkStatus, number>>;
  readonly totalMatchImpressions: number;
}

export interface ArtistDashboard {
  readonly listings: readonly DashboardListing[];
  readonly summary: DashboardSummary;
}

interface PrimaryImageRow {
  readonly artwork_id: string;
  readonly path: string;
}

/**
 * Every listing an artist owns.
 *
 * Ordered so the things needing attention are near the top: drafts and unlisted
 * artworks first, then published, then the ones that are done with -- sold and
 * removed. Within a group, newest first.
 */
export async function artistDashboard(
  deps: ArtworksDeps,
  artistId: string,
): Promise<ArtistDashboard> {
  const { rows } = await deps.db.query<ArtworkRow>(
    `select ${ARTWORK_COLUMNS}
       from artworks
      where artist_id = $1
      order by case status
                 when 'draft'     then 0
                 when 'unlisted'  then 1
                 when 'published' then 2
                 when 'sold'      then 3
                 when 'removed'   then 4
               end,
               created_at desc`,
    [artistId],
  );

  const artworks = rows.map(toArtwork);
  const ids = artworks.map((artwork) => artwork.id);

  // Two batched cross-module reads and one image read, whatever the row count.
  const [demand, impressions, primaryImages] = await Promise.all([
    ids.length === 0
      ? Promise.resolve(new Map<string, InventoryDemand>())
      : deps.demand.demandForMany(deps.db, ids),
    ids.length === 0
      ? Promise.resolve(new Map<string, number>())
      : deps.impressions.countsFor(deps.db, ids),
    primaryImagePaths(deps.db, ids),
  ]);

  const listings = artworks.map((artwork): DashboardListing => {
    const artworkDemand = demand.get(artwork.id) ?? { reservedUnits: 0, soldUnits: 0 };

    return {
      id: artwork.id,
      title: artwork.title,
      status: artwork.status,
      statusLabel: ARTWORK_STATUS_LABELS[artwork.status],

      priceAgorot: artwork.priceAgorot,
      priceFormatted: artwork.priceAgorot === null ? null : formatAgorot(artwork.priceAgorot),

      medium: artwork.medium,
      mediumLabel: artwork.medium === null ? null : MEDIUM_LABELS[artwork.medium as Medium],

      inventoryType: artwork.inventoryType,
      stock: artwork.stock,
      reservedUnits: artworkDemand.reservedUnits,
      soldUnits: artworkDemand.soldUnits,
      availableUnits: availableUnits(artwork.stock, artworkDemand),

      matchImpressions: impressions.get(artwork.id) ?? 0,
      primaryImagePath: primaryImages.get(artwork.id) ?? null,

      missingForPublication:
        artwork.status === "published" || artwork.status === "sold"
          ? []
          : missingForPublication(asPublishCandidate(artwork)),

      availableActions: permittedTransitions(artwork.status, "artist"),
      oversoldBy: oversoldBy(artwork.stock, artworkDemand),

      createdAt: artwork.createdAt,
      publishedAt: artwork.publishedAt,
    };
  });

  return { listings, summary: summarise(listings) };
}

function summarise(listings: readonly DashboardListing[]): DashboardSummary {
  const byStatus: Record<ArtworkStatus, number> = {
    draft: 0,
    published: 0,
    sold: 0,
    unlisted: 0,
    removed: 0,
  };

  let totalMatchImpressions = 0;
  for (const listing of listings) {
    byStatus[listing.status] += 1;
    totalMatchImpressions += listing.matchImpressions;
  }

  return { total: listings.length, byStatus, totalMatchImpressions };
}

/**
 * The primary image path for each artwork, in one query.
 *
 * `distinct on` with an ordered scan picks position 0 per artwork -- the
 * position column is the definition of primary, so the thumbnail on the
 * dashboard and the image the embedding was computed from are the same one.
 */
async function primaryImagePaths(
  sql: Sql,
  artworkIds: readonly string[],
): Promise<ReadonlyMap<string, string>> {
  if (artworkIds.length === 0) return new Map();

  const { rows } = await sql.query<PrimaryImageRow>(
    `select distinct on (artwork_id)
            artwork_id,
            coalesce(thumbnail_path, display_path, original_path) as path
       from artwork_images
      where artwork_id = any($1::uuid[])
      order by artwork_id, position`,
    [artworkIds],
  );

  return new Map(rows.map((row) => [row.artwork_id, row.path] as const));
}
