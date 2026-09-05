/**
 * The estimated shipping range shown on an artwork before anyone has entered an
 * address.
 *
 * `catalog.ArtworkDetailView` takes `shippingRange` as a prop and says why it
 * cannot compute one: catalog may call `artworks` and `accounts` and nothing
 * else, and the rate table belongs to `shipping`. `catalog/index.ts` names this
 * as one of the four things "`src/app` supplies", described as "an estimate
 * derived from `shipping`'s rate table". This is that derivation, and it is
 * composition rather than business logic: every number comes out of
 * `shipping`'s public API and none is invented here.
 *
 * WHY A RANGE AND NOT A FIGURE
 * ----------------------------
 * The flat rate is a function of zone x size tier. The tier is a property of
 * the artwork, so it is known now; the zone depends on the delivery address,
 * which nobody has entered yet. So the tier is fixed and the zone is not, and
 * the honest answer is the cheapest and dearest configured zone for THIS
 * artwork's tier. `ArtworkDetailView` states the same thing in its own header:
 * "quoting one number here and a different one at checkout is worse than
 * quoting a band."
 *
 * WHY THE PACKED DEPTH COMES FROM `orders`
 * ----------------------------------------
 * A flat artwork legitimately stores `depth_mm = null`, and `classifyPackage`
 * needs three positive edges. `orders` already decided what to assume —
 * `DEFAULT_FLAT_ARTWORK_PACKED_DEPTH_MM` — and it is imported rather than
 * restated so that the estimate on the artwork page and the quote at checkout
 * band the same parcel into the same tier. A second constant here would be the
 * copy that stops matching, and the buyer would meet the difference at the one
 * moment they are being asked to pay.
 *
 * SILENCE RATHER THAN A GUESS
 * ---------------------------
 * `undefined` — not a zero, not a placeholder — whenever the estimate cannot be
 * made honestly: an unmeasured piece, one too large for every tier (which
 * `shipping` marks `requiresShippingQuote`), or a tier with no rates configured
 * yet. `ArtworkDetailView` renders no shipping line when the prop is absent,
 * which is the correct thing for a buyer to see. A "₪0" would be a quote, and a
 * wrong one.
 */
import type { Sql } from "@/shared/db";
import { agorot } from "@/shared/money";
import { centimetresToMillimetres, type PublicArtwork } from "@/modules/artworks";
import { classifyPackage, readRateTable } from "@/modules/shipping";
import { DEFAULT_FLAT_ARTWORK_PACKED_DEPTH_MM } from "@/modules/orders";
import type { CatalogShippingRange } from "@/modules/catalog";

export async function shippingRangeFor(
  db: Sql,
  artwork: PublicArtwork,
): Promise<CatalogShippingRange | undefined> {
  const { heightCm, widthCm, depthCm, weightGrams } = artwork;

  // The same three fields `orders.parcelFor` refuses to proceed without. It
  // raises, because a checkout that cannot be priced must stop; this returns
  // nothing, because a catalog page that cannot estimate must still render.
  if (heightCm === null || widthCm === null || weightGrams === null) return undefined;

  // The axis names match `orders.parcelFor` exactly — height becomes the
  // parcel's length, width its width, and the artwork's depth its height — so
  // the estimate and the real quote band the same box.
  const classification = await classifyPackage(db, {
    lengthMm: centimetresToMillimetres(heightCm, "heightCm"),
    widthMm: centimetresToMillimetres(widthCm, "widthCm"),
    heightMm:
      depthCm === null
        ? DEFAULT_FLAT_ARTWORK_PACKED_DEPTH_MM
        : centimetresToMillimetres(depthCm, "depthCm"),
    weightGrams,
  });

  // Fits no tier: `shipping` says this needs a bespoke quote, so there is no
  // band to state.
  if (classification.tierCode === null) return undefined;

  const rates = (await readRateTable(db))
    .filter((entry) => entry.tierCode === classification.tierCode)
    .map((entry) => entry.amountAgorot);

  if (rates.length === 0) return undefined;

  return {
    minAgorot: agorot(Math.min(...rates)),
    maxAgorot: agorot(Math.max(...rates)),
  };
}
