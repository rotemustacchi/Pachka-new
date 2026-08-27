/**
 * Shaping an artwork for a buyer.
 *
 * Built key by key, never by spreading a row. `accounts/serialize.ts` explains
 * the failure this avoids and it applies here identically: React serialises the
 * ENTIRE prop object of a Client Component into the RSC flight payload embedded
 * in the HTML, whatever the JSX actually renders. A wide artwork row passed to
 * a card component puts the artist's internal identifiers, the draft price
 * history, and anything a later migration adds into the page source, where the
 * rendered output shows none of it (SECURITY.md S1-8).
 *
 * So a `PublicArtwork` is assembled from named fields, and adding a column to
 * the table does not add it to this object.
 */
import { formatAgorot, type Agorot } from "@/shared/money";
import { formatDimensionsCm, formatWeightGrams, millimetresToCentimetres } from "./dimensions";
import type { Availability } from "./inventory";
import { ARTWORK_STATUS_LABELS } from "./lifecycle";
import {
  MEDIUM_LABELS,
  MOOD_LABELS,
  STYLE_LABELS,
  TARGET_SPACE_LABELS,
  type Medium,
  type Mood,
  type Style,
  type TargetSpace,
} from "./taxonomy";
import type { Artwork, ArtworkStatus, InventoryType } from "./types";

/**
 * The AI-assistance label.
 *
 * artwork-listings, "AI-assistance disclosure": where AI assistance is
 * declared, "a visible label SHALL appear on the artwork card and detail page".
 * The text is the approved design's (design/Catalog.dc.html, "נוצר בעזרת AI").
 *
 * A single exported constant, because a label that appears on two surfaces and
 * is typed twice is a label that says two different things after the first copy
 * edit -- and this one is a disclosure, so the two surfaces disagreeing is a
 * disclosure failing on one of them.
 */
export const AI_ASSISTED_LABEL = "נוצר בעזרת AI";

/** The detail page's row: "שימוש ב-AI · לא" (design/Artwork.dc.html). */
export const AI_DISCLOSURE_LABEL = "שימוש ב-AI";
export const AI_DISCLOSURE_YES = "כן, נעשה שימוש משמעותי בבינה מלאכותית";
export const AI_DISCLOSURE_NO = "לא";

/**
 * Whether the AI label is shown.
 *
 * `true` shows it. `false` and `null` do not -- but they are different
 * situations, and only one of them can reach a buyer: `null` means the artist
 * never answered, which blocks publication, so a published artwork always has a
 * real answer. This function returning the same thing for both is safe
 * precisely because of that gate, and would not be without it.
 */
export function showsAiAssistedLabel(aiAssisted: boolean | null): boolean {
  return aiAssisted === true;
}

export interface PublicArtworkImage {
  readonly id: string;
  /** The served derivative, falling back to the original where none exists yet. */
  readonly displayPath: string;
  readonly thumbnailPath: string | null;
  readonly altText: string | null;
  readonly isPrimary: boolean;
}

/** A classification value with its Hebrew label, ready to render as a tag. */
export interface TaxonomyTag {
  readonly value: string;
  readonly label: string;
}

/** Everything, and only everything, a buyer may see about an artwork. */
export interface PublicArtwork {
  readonly id: string;
  readonly artistId: string;
  readonly status: ArtworkStatus;
  readonly statusLabel: string;

  readonly title: string;
  readonly description: string;

  readonly priceAgorot: Agorot;
  /** "₪1,250.00", from shared/money. Never formatted anywhere else. */
  readonly priceFormatted: string;

  // ---- The mandatory specification block. artwork-listings requires all of it
  // on the detail page, because the MVP gives a buyer no way to ask.
  readonly heightCm: number | null;
  readonly widthCm: number | null;
  readonly depthCm: number | null;
  readonly dimensionsFormatted: string | null;
  readonly weightGrams: number | null;
  readonly weightFormatted: string | null;
  readonly materials: string | null;
  /** `null` where framing does not apply to this medium. */
  readonly isFramed: boolean | null;
  readonly leadTimeDays: number | null;
  readonly yearCreated: number | null;

  readonly medium: TaxonomyTag | null;
  readonly styles: readonly TaxonomyTag[];
  readonly targetSpaces: readonly TaxonomyTag[];
  readonly moods: readonly TaxonomyTag[];

  readonly inventoryType: InventoryType;
  /**
   * The declared edition size, which a buyer may see: "מהדורה מתוך 10" is how
   * an edition is described, and artwork-listings makes the quantity a stated
   * fact about the work. Distinct from `availableUnits` below, which is what is
   * left of it.
   */
  readonly stock: number;
  readonly madeToOrder: boolean;
  readonly productionLeadTimeDays: number | null;

  /** Derived. `stock - active_reservations - sold`, never a stored counter. */
  readonly availableUnits: number;
  readonly purchasable: boolean;
  readonly soldOut: boolean;

  /**
   * The disclosure. `aiAssisted` is never `null` on a published artwork,
   * because an unanswered question blocks publication.
   */
  readonly aiAssisted: boolean;
  readonly aiAssistedLabel: string | null;

  readonly images: readonly PublicArtworkImage[];
  readonly publishedAt: string | null;
}

/**
 * Fields that must never reach this function, because their presence means the
 * artwork was joined against an artist row too wide to be here.
 *
 * The same guard `accounts/serialize.ts` applies to artist rows, applied at the
 * other end of the join. An artwork page shows the artist's name and city; the
 * temptation to `select * from artworks join artist_contact_details` to get a
 * dispatch address onto an artist's own view of the page is exactly how the
 * buyer-facing version of that query gets written next.
 */
const FORBIDDEN_FRAGMENTS = [
  "email",
  "phone",
  "address",
  "iban",
  "account_number",
  "branch",
  "bank",
  "instagram",
] as const;

function tags<T extends string>(
  values: readonly T[],
  labels: Readonly<Record<T, string>>,
): readonly TaxonomyTag[] {
  return values.map((value) => ({ value, label: labels[value] }));
}

export interface PublicArtworkInput {
  readonly artwork: Artwork;
  readonly availability: Availability;
  readonly images: readonly PublicArtworkImage[];
}

/**
 * Shape an artwork for a buyer.
 *
 * Throws rather than returning a partial object when the artwork is missing a
 * mandatory field. That cannot happen for a published artwork -- the publish
 * gate and the `artworks_published_is_complete` check constraint both prevent
 * it -- so reaching it means a draft was handed to a buyer-facing renderer, and
 * the useful behaviour is to say so loudly rather than render "undefined ס״מ".
 */
export function toPublicArtwork({
  artwork,
  availability,
  images,
}: PublicArtworkInput): PublicArtwork {
  assertNarrow(artwork as unknown as Record<string, unknown>);

  if (artwork.title === null || artwork.description === null || artwork.priceAgorot === null) {
    throw new Error(
      `Artwork ${artwork.id} is in status "${artwork.status}" and has no title, description or ` +
        "price. Only a published, sold or unlisted artwork can be shaped for a buyer.",
    );
  }

  return {
    id: artwork.id,
    artistId: artwork.artistId,
    status: artwork.status,
    statusLabel: ARTWORK_STATUS_LABELS[artwork.status],

    title: artwork.title,
    description: artwork.description,

    priceAgorot: artwork.priceAgorot,
    priceFormatted: formatAgorot(artwork.priceAgorot),

    heightCm: artwork.heightMm === null ? null : millimetresToCentimetres(artwork.heightMm),
    widthCm: artwork.widthMm === null ? null : millimetresToCentimetres(artwork.widthMm),
    depthCm: artwork.depthMm === null ? null : millimetresToCentimetres(artwork.depthMm),
    dimensionsFormatted: formatDimensionsCm(artwork),
    weightGrams: artwork.weightGrams,
    weightFormatted: formatWeightGrams(artwork.weightGrams),
    materials: artwork.materials,
    isFramed: artwork.isFramed,
    leadTimeDays: artwork.leadTimeDays,
    yearCreated: artwork.yearCreated,

    medium:
      artwork.medium === null
        ? null
        : { value: artwork.medium, label: MEDIUM_LABELS[artwork.medium as Medium] },
    styles: tags(artwork.styles as readonly Style[], STYLE_LABELS),
    targetSpaces: tags(artwork.targetSpaces as readonly TargetSpace[], TARGET_SPACE_LABELS),
    moods: tags(artwork.moods as readonly Mood[], MOOD_LABELS),

    inventoryType: artwork.inventoryType,
    stock: artwork.stock,
    madeToOrder: artwork.madeToOrder,
    productionLeadTimeDays: artwork.productionLeadTimeDays,

    availableUnits: availability.availableUnits,
    purchasable: availability.purchasable,
    soldOut: availability.soldOut,

    aiAssisted: artwork.aiAssisted === true,
    aiAssistedLabel: showsAiAssistedLabel(artwork.aiAssisted) ? AI_ASSISTED_LABEL : null,

    images,
    publishedAt: artwork.publishedAt,
  };
}

function assertNarrow(row: Readonly<Record<string, unknown>>): void {
  const smuggled = Object.keys(row).filter((key) => {
    const lower = key.toLowerCase();
    return FORBIDDEN_FRAGMENTS.some((fragment) => lower.includes(fragment));
  });

  if (smuggled.length > 0) {
    throw new Error(
      `A buyer-facing artwork object arrived carrying ${smuggled.join(", ")}. The query that ` +
        "produced it is too wide: name the columns explicitly. See SECURITY.md S1-8.",
    );
  }
}

/** "יצירה יחידה" / "מהדורה מתוך 10", as the approved artwork page renders it. */
export function inventoryLabel(artwork: {
  readonly inventoryType: InventoryType;
  readonly stock: number;
}): string {
  return artwork.inventoryType === "unique" ? "יצירה יחידה" : `מהדורה מתוך ${artwork.stock}`;
}

/** "נשלח תוך 5 ימי עסקים". */
export function leadTimeLabel(leadTimeDays: number | null): string | null {
  if (leadTimeDays === null) return null;
  if (leadTimeDays === 0) return "נשלח באותו יום עסקים";
  if (leadTimeDays === 1) return "נשלח תוך יום עסקים אחד";
  return `נשלח תוך ${leadTimeDays} ימי עסקים`;
}

/** "ממוסגר, מוכן לתלייה" / "ללא מסגרת". `null` where framing does not apply. */
export function framingLabel(isFramed: boolean | null): string | null {
  if (isFramed === null) return null;
  return isFramed ? "ממוסגר, מוכן לתלייה" : "ללא מסגרת";
}
