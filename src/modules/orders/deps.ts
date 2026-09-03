/**
 * What the orders module needs handed to it.
 *
 * The database is real everywhere, including in tests -- ARCHITECTURE.md's test
 * policy makes that non-negotiable and the harness gives every test its own
 * PostgreSQL. So `db` is not a seam, it is just a dependency.
 *
 * `payments` IS a seam, and it is the only one. Payment is a genuine external
 * boundary, and `checkout-orders` requires it to sit behind one interface so a
 * real provider can be added later "with no change required to cart, checkout,
 * or order logic". Note that the tests still do not fake it: the adapter that
 * ships, `createManualPaymentProvider`, is deterministic and reaches no network,
 * so the suite drives the same object production does. See manual-payment.ts.
 *
 * Mail is NOT a dependency of this module. Every path that has something to say
 * returns `NotificationRequest[]` for the caller to dispatch after its
 * transaction commits, exactly as `shipping` does — so nobody is told about
 * something that then rolled back, and this module needs no mail fake either.
 */
import {
  noImpressions,
  type ArtworksDeps,
} from "@/modules/artworks";
import type { Database } from "@/shared/db";
import { sqlInventoryDemand } from "./demand";
import type { PaymentProvider } from "./payment-provider";

/**
 * A cap on how many units one buyer may hold at once.
 *
 * SECURITY.md S1-17: "register, script 'begin checkout' against every unique
 * artwork in the catalog, and hold the entire inventory for the reservation
 * TTL... On a catalog of a few hundred works with one operator, this costs the
 * attacker a script and destroys the marketplace." Item 2 asks for "a configured
 * cap on concurrent active reservations per account (a small number -- a buyer
 * buying five pieces at once is the outer bound of legitimate)".
 *
 * "Configured" means `app_config`, read through `shared/config`
 * (ARCHITECTURE.md: "No magic numbers in module code"). The key is not
 * registered yet — `shared/config/registry.ts` belongs to the foundation and
 * adding a key there is their edit, not this module's. So the value arrives as
 * an injectable dependency with the default S1-17 argues for, and the swap to
 * `getConfig(db, "checkout.max_active_reservations_per_buyer")` is one line in
 * `config.ts` the moment the key exists. The key is reported to the lead
 * architect for registration; `shipping/config.ts` records having done exactly
 * this and why.
 */
export const DEFAULT_MAX_ACTIVE_RESERVATIONS_PER_BUYER = 5;

/**
 * The packed depth assumed for an artwork whose medium has none.
 *
 * `artworks` requires a depth only for three-dimensional media
 * (`MEDIA_REQUIRING_DEPTH`), so a painting or a print legitimately stores
 * `depth_mm = null`. `shipping.classifyPackage` needs three positive edges to
 * band a parcel into a size tier, and a flat artwork still travels in a box: a
 * stretched canvas plus its packaging is a few centimetres deep whatever the
 * listing says.
 *
 * Five centimetres is the conservative direction. `shipping`'s rounding rule is
 * that "rounding can only ever push a parcel into a larger tier, never sneak an
 * oversized one into a cheaper rate the platform then subsidises", and this
 * follows it: assuming depth rather than assuming flatness can only make the
 * quote dearer, never cheaper.
 *
 * This too wants to be `app_config`, and the key belongs to `shipping` rather
 * than to this module. Reported alongside the cap.
 */
export const DEFAULT_FLAT_ARTWORK_PACKED_DEPTH_MM = 50;

export interface OrdersDeps {
  readonly db: Database;
  /** The one external boundary. `createManualPaymentProvider()` in the MVP. */
  readonly payments: PaymentProvider;
  /** See `DEFAULT_MAX_ACTIVE_RESERVATIONS_PER_BUYER`. */
  readonly maxActiveReservationsPerBuyer?: number;
  /** See `DEFAULT_FLAT_ARTWORK_PACKED_DEPTH_MM`. */
  readonly flatArtworkPackedDepthMm?: number;
}

export function maxActiveReservationsFor(deps: OrdersDeps): number {
  return deps.maxActiveReservationsPerBuyer ?? DEFAULT_MAX_ACTIVE_RESERVATIONS_PER_BUYER;
}

export function packedDepthMmFor(deps: OrdersDeps): number {
  return deps.flatArtworkPackedDepthMm ?? DEFAULT_FLAT_ARTWORK_PACKED_DEPTH_MM;
}

/**
 * `ArtworksDeps` with the REAL demand source wired in.
 *
 * This function is the whole point of `demand.ts`. `artworks` ships with
 * `noDemand`, a placeholder that reports zero reservations for everything, and
 * `assertDemandSourceIsWired` turns leaving it installed into a hard failure on
 * the first checkout rather than a silent zero — because "assume nothing is
 * reserved" is precisely how a one-of-a-kind painting is sold twice.
 *
 * Anything in this module that calls into `artworks` — `reconcileAvailability`
 * above all — goes through here. The composition root passes the same handle it
 * gives everything else, and `db` is threaded rather than taken from `deps.db`
 * so a caller inside a transaction can hand the transaction down.
 *
 * `impressions` stays `noImpressions`: that is `matchmaker`'s port, not ours,
 * and zero is the honest answer for an artwork nobody has been shown.
 */
export function artworksDepsFor(deps: OrdersDeps, db: Database = deps.db): ArtworksDeps {
  return { db, demand: sqlInventoryDemand, impressions: noImpressions };
}
