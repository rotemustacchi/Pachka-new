/**
 * The artwork domain type, and the one place a database row becomes one.
 *
 * Two rules this file exists to keep:
 *
 * 1. `price_agorot` is a `bigint` column, which node-postgres hands back as a
 *    STRING so that values above 2^53 survive the trip (see shared/db/client.ts).
 *    `shared/money`'s `fromDbValue` is the only sanctioned way to turn that
 *    string into money, and it is called here so no other file is tempted to
 *    reach for `Number()`.
 *
 * 2. Mapping is explicit, key by key, with no spread. A spread would make the
 *    shape of a domain object depend on the shape of whatever query produced
 *    it, which is how a column nobody meant to expose reaches a React Server
 *    Component's props and gets serialised into the flight payload embedded in
 *    the HTML (SECURITY.md S1-8). `accounts/serialize.ts` makes the same choice
 *    for the same reason.
 */
import { fromDbValue, type Agorot } from "@/shared/money";
import type { Medium, Mood, Style, TargetSpace } from "./taxonomy";

/** artwork-listings, "Listing lifecycle": exactly one of five. */
export const ARTWORK_STATUSES = ["draft", "published", "sold", "unlisted", "removed"] as const;
export type ArtworkStatus = (typeof ARTWORK_STATUSES)[number];

export const INVENTORY_TYPES = ["unique", "edition"] as const;
export type InventoryType = (typeof INVENTORY_TYPES)[number];

/**
 * The originality declaration, as recorded.
 *
 * artwork-listings requires the system to "record who affirmed it and when", so
 * this is who and when -- not a boolean. Present means affirmed; absent means
 * not affirmed, which blocks publication.
 */
export interface OriginalityDeclaration {
  /** The account that affirmed it. */
  readonly declaredBy: string;
  /** ISO-8601 timestamp of the affirmation. */
  readonly declaredAt: string;
}

/** An artwork as the artworks module works with it. */
export interface Artwork {
  readonly id: string;
  readonly artistId: string;
  readonly status: ArtworkStatus;

  readonly title: string | null;
  readonly description: string | null;
  readonly priceAgorot: Agorot | null;

  readonly heightMm: number | null;
  readonly widthMm: number | null;
  readonly depthMm: number | null;
  readonly weightGrams: number | null;
  readonly materials: string | null;
  /** `null` where framing does not apply to the medium. */
  readonly isFramed: boolean | null;
  readonly leadTimeDays: number | null;
  readonly yearCreated: number | null;

  readonly medium: Medium | null;
  readonly styles: readonly Style[];
  readonly targetSpaces: readonly TargetSpace[];
  readonly moods: readonly Mood[];

  readonly inventoryType: InventoryType;
  /** The DECLARED edition size. Availability is derived from it, never stored. */
  readonly stock: number;
  readonly madeToOrder: boolean;
  readonly productionLeadTimeDays: number | null;

  readonly originality: OriginalityDeclaration | null;
  /** `null` means the artist has not answered, which blocks publication. */
  readonly aiAssisted: boolean | null;

  readonly publishedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** The raw row shape. Every buyer- or artist-facing query selects exactly these. */
export interface ArtworkRow {
  readonly id: string;
  readonly artist_id: string;
  readonly status: string;
  readonly title: string | null;
  readonly description: string | null;
  readonly price_agorot: string | null;
  readonly height_mm: number | null;
  readonly width_mm: number | null;
  readonly depth_mm: number | null;
  readonly weight_grams: number | null;
  readonly materials: string | null;
  readonly is_framed: boolean | null;
  readonly lead_time_days: number | null;
  readonly year_created: number | null;
  readonly medium: string | null;
  readonly styles: string[] | null;
  readonly target_spaces: string[] | null;
  readonly moods: string[] | null;
  readonly inventory_type: string;
  readonly stock: number;
  readonly made_to_order: boolean;
  readonly production_lead_time_days: number | null;
  readonly originality_declared_by: string | null;
  readonly originality_declared_at: Date | string | null;
  readonly ai_assisted: boolean | null;
  readonly published_at: Date | string | null;
  readonly created_at: Date | string;
  readonly updated_at: Date | string;
}

/**
 * The column list every artwork query uses.
 *
 * Exported so the query and the mapper cannot drift, and so that `select *`
 * never appears against this table. A `select *` here is how a column added
 * next quarter by a team that has not read SECURITY.md ends up in a response.
 */
export const ARTWORK_COLUMNS = [
  "id",
  "artist_id",
  "status",
  "title",
  "description",
  "price_agorot",
  "height_mm",
  "width_mm",
  "depth_mm",
  "weight_grams",
  "materials",
  "is_framed",
  "lead_time_days",
  "year_created",
  "medium",
  "styles",
  "target_spaces",
  "moods",
  "inventory_type",
  "stock",
  "made_to_order",
  "production_lead_time_days",
  "originality_declared_by",
  "originality_declared_at",
  "ai_assisted",
  "published_at",
  "created_at",
  "updated_at",
].join(", ");

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function isoOrNull(value: Date | string | null): string | null {
  return value === null ? null : iso(value);
}

/**
 * Turn a row into an `Artwork`.
 *
 * The taxonomy columns are cast rather than re-parsed. They were validated on
 * the way in AND are constrained by the check constraints in the migration, so
 * a value outside the set cannot be in the column; re-running the parser on
 * every read would spend the cost on every catalog page to catch a condition
 * the database already makes impossible. The taxonomy integration test is what
 * proves the constraint and the constant still agree.
 */
export function toArtwork(row: ArtworkRow): Artwork {
  return {
    id: row.id,
    artistId: row.artist_id,
    status: row.status as ArtworkStatus,

    title: row.title,
    description: row.description,
    priceAgorot: row.price_agorot === null ? null : fromDbValue(row.price_agorot),

    heightMm: row.height_mm,
    widthMm: row.width_mm,
    depthMm: row.depth_mm,
    weightGrams: row.weight_grams,
    materials: row.materials,
    isFramed: row.is_framed,
    leadTimeDays: row.lead_time_days,
    yearCreated: row.year_created,

    medium: row.medium as Medium | null,
    styles: (row.styles ?? []) as Style[],
    targetSpaces: (row.target_spaces ?? []) as TargetSpace[],
    moods: (row.moods ?? []) as Mood[],

    inventoryType: row.inventory_type as InventoryType,
    stock: row.stock,
    madeToOrder: row.made_to_order,
    productionLeadTimeDays: row.production_lead_time_days,

    originality:
      row.originality_declared_by === null || row.originality_declared_at === null
        ? null
        : {
            declaredBy: row.originality_declared_by,
            declaredAt: iso(row.originality_declared_at),
          },
    aiAssisted: row.ai_assisted,

    publishedAt: isoOrNull(row.published_at),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}
