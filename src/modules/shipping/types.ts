/**
 * The vocabulary `shipping` exposes. Everything here is what another module --
 * in practice `orders` -- passes in or gets back.
 */
import type { Agorot } from "@/shared/money";

/**
 * The part of a delivery address that decides a zone.
 *
 * Deliberately not the whole address. `orders` owns the buyer's delivery
 * details and, per SECURITY.md S1-18, keeps them in a table an artist may only
 * read once their own fulfilment is past `awaiting_payment`. Shipping needs the
 * city, the postal code and the country to price a parcel, and has no business
 * holding a street or a phone number to do it.
 */
export interface DeliveryAddress {
  readonly countryCode: string;
  readonly city: string;
  readonly postalCode?: string | null;
}

export interface ShippingZone {
  readonly id: string;
  readonly code: string;
  readonly displayName: string;
  readonly countryCode: string;
}

export interface ShippingTier {
  readonly id: string;
  readonly code: string;
  readonly displayName: string;
  /** Ascending size. The "largest applicable tier" is the greatest ordinal. */
  readonly ordinal: number;
  readonly maxLengthMm: number;
  readonly maxWidthMm: number;
  readonly maxHeightMm: number;
  readonly maxWeightGrams: number;
}

/**
 * A parcel's outer dimensions, in whole millimetres and whole grams.
 *
 * Millimetres rather than the centimetres `artwork-listings` collects from the
 * artist, because a tier boundary compared as a float is a bug waiting for the
 * artwork that is a tenth of a millimetre over. Use
 * `millimetresFromCentimetres()` at the boundary; it rounds up.
 */
export interface PackageDimensions {
  readonly lengthMm: number;
  readonly widthMm: number;
  readonly heightMm: number;
  readonly weightGrams: number;
}

/** What the artist's declared dimensions resolve to at listing time. */
export interface PackageClassification {
  /** The smallest tier the parcel fits in, or `null` when it fits none. */
  readonly tierCode: string | null;
  /**
   * True when nothing fits. `artworks` stores this and `orders` must refuse a
   * standard checkout for the artwork (`shipping-and-returns`, "Artwork exceeds
   * every tier").
   */
  readonly requiresShippingQuote: boolean;
}

/**
 * One artwork in a checkout, as `orders` presents it for quoting.
 *
 * `sizeTierCode` and `requiresShippingQuote` come from the artwork row that
 * `artworks` owns, read server-side. SECURITY.md S0-5: the client supplies
 * artwork ids, quantities and an address, and nothing else -- never a zone,
 * never a tier, never a cost.
 */
export interface QuoteLine {
  readonly artworkId: string;
  readonly artistId: string;
  readonly sizeTierCode: string | null;
  readonly requiresShippingQuote?: boolean;
}

/** What one artist's fulfilment costs to ship. */
export interface FulfilmentQuote {
  readonly artistId: string;
  readonly tierCode: string;
  readonly amountAgorot: Agorot;
}

export interface ShippingQuote {
  readonly zoneCode: string;
  readonly zoneDisplayName: string;
  /** One entry per artist: an order spanning two artists ships as two parcels. */
  readonly fulfilments: readonly FulfilmentQuote[];
  readonly totalAgorot: Agorot;
}

export type NotificationAudience = "buyer" | "artist" | "admin";

/**
 * Something that needs telling, handed back to the caller rather than sent.
 *
 * Shipping does not own a mail transport and does not take one as a dependency.
 * The caller dispatches these. That keeps the one genuinely external boundary
 * -- mail -- out of this module entirely, which is also why not a single test
 * in this module needs a fake.
 */
export interface NotificationRequest {
  readonly audience: NotificationAudience;
  /** Stable template identifier. Callers switch on this, never on prose. */
  readonly template: string;
  /** The account to notify. Absent for `admin`, which is an operator queue. */
  readonly recipientId?: string;
  readonly data: Readonly<Record<string, unknown>>;
}
