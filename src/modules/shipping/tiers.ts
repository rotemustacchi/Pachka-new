/**
 * Size tiers: which one a parcel fits, and what happens when none of them do.
 *
 * `shipping-and-returns`, "Flat-rate shipping tiers": the artist selects the
 * size tier per artwork at listing time from a fixed set, each defined by
 * maximum dimensions and weight. Selecting it by hand would let an artist put a
 * ceramic the size of a door in the small tier and have the platform eat the
 * difference on every sale, so the tier is *derived* from the dimensions
 * `artwork-listings` already requires -- height, width, depth, weight -- and
 * the artist's role is to declare those honestly.
 */
import { AppError } from "@/shared/errors";
import type { Sql } from "@/shared/db";
import type { PackageClassification, PackageDimensions, ShippingTier } from "./types";

interface TierRow {
  readonly id: string;
  readonly code: string;
  readonly display_name: string;
  readonly ordinal: number;
  readonly max_length_mm: number;
  readonly max_width_mm: number;
  readonly max_height_mm: number;
  readonly max_weight_grams: number;
}

function toTier(row: TierRow): ShippingTier {
  return {
    id: row.id,
    code: row.code,
    displayName: row.display_name,
    ordinal: row.ordinal,
    maxLengthMm: row.max_length_mm,
    maxWidthMm: row.max_width_mm,
    maxHeightMm: row.max_height_mm,
    maxWeightGrams: row.max_weight_grams,
  };
}

/**
 * Centimetres, as `artwork-listings` collects them, to whole millimetres.
 *
 * Rounds **up**, always. A 24.05 cm edge becomes 241 mm rather than 240, so
 * rounding can only ever push a parcel into a larger tier, never sneak an
 * oversized one into a cheaper rate the platform then subsidises. The epsilon
 * absorbs binary representation noise -- `24.1 * 10` is 240.99999999999997, and
 * without it every tenth-of-a-centimetre value would gain a millimetre.
 */
export function millimetresFromCentimetres(centimetres: number): number {
  if (typeof centimetres !== "number" || !Number.isFinite(centimetres) || centimetres < 0) {
    throw AppError.validation(`Dimension must be a non-negative number of centimetres, got ${centimetres}`, {
      code: "shipping.invalid_dimension",
    });
  }
  return Math.ceil(Number((centimetres * 10).toFixed(6)));
}

function assertWholePositive(label: string, value: number): void {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw AppError.validation(`${label} must be a whole number greater than zero, got ${value}`, {
      code: "shipping.invalid_dimension",
    });
  }
}

/**
 * Does this parcel fit in this tier?
 *
 * Both triples are sorted descending before comparing, which is what makes the
 * answer independent of which edge the artist called "height". A 300x400 mm
 * print fits a 400x300 mm tier; a rule that compared length to length would say
 * it does not and charge the next tier up for a rotation.
 */
export function fitsTier(parcel: PackageDimensions, tier: ShippingTier): boolean {
  assertWholePositive("Length", parcel.lengthMm);
  assertWholePositive("Width", parcel.widthMm);
  assertWholePositive("Height", parcel.heightMm);
  assertWholePositive("Weight", parcel.weightGrams);

  if (parcel.weightGrams > tier.maxWeightGrams) return false;

  const parcelEdges = [parcel.lengthMm, parcel.widthMm, parcel.heightMm].sort((a, b) => b - a);
  const tierEdges = [tier.maxLengthMm, tier.maxWidthMm, tier.maxHeightMm].sort((a, b) => b - a);

  return parcelEdges.every((edge, index) => edge <= (tierEdges[index] ?? 0));
}

/** Every active tier, smallest first. */
export async function listTiers(db: Sql): Promise<readonly ShippingTier[]> {
  const { rows } = await db.query<TierRow>(
    `select id, code, display_name, ordinal, max_length_mm, max_width_mm, max_height_mm, max_weight_grams
       from shipping_tiers
      where active
      order by ordinal asc`,
  );
  return rows.map(toTier);
}

/**
 * The tier an artwork ships in, or the flag that says it cannot ship at a
 * standard rate at all.
 *
 * Called by `artworks` at listing time. The result is stored on the artwork:
 * re-deriving it at checkout would silently re-price an order when an admin
 * edits a tier boundary mid-checkout, and would put a rate-table read inside
 * the reservation transaction for no benefit.
 */
export async function classifyPackage(
  db: Sql,
  parcel: PackageDimensions,
): Promise<PackageClassification> {
  const tiers = await listTiers(db);
  const smallest = tiers.find((tier) => fitsTier(parcel, tier));

  return smallest
    ? { tierCode: smallest.code, requiresShippingQuote: false }
    : { tierCode: null, requiresShippingQuote: true };
}

/** Look a tier up by code. Unknown codes are a `not_found`, not a silent fallback to the largest. */
export async function tierByCode(db: Sql, code: string): Promise<ShippingTier> {
  const row = await db.maybeOne<TierRow>(
    `select id, code, display_name, ordinal, max_length_mm, max_width_mm, max_height_mm, max_weight_grams
       from shipping_tiers
      where code = $1 and active`,
    [code],
  );
  if (!row) {
    throw AppError.notFound(`No active shipping tier with code "${code}"`, {
      code: "shipping.unknown_tier",
      details: { tierCode: code },
    });
  }
  return toTier(row);
}
