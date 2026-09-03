/**
 * The `app_config` keys this module reads, one function per value.
 *
 * Same shape as `shipping/config.ts`, for the same reason: a caller asks for
 * the value, not for the key, so nothing outside this file knows what any of
 * them is called and a rename is one edit.
 *
 * ARCHITECTURE.md: "Every configurable number lives in `app_config`, read
 * through `shared/config`... Commission rate, quality thresholds, ranking
 * weights, reservation TTL... No magic numbers in module code." Two of the
 * three numbers this module needs are registered; the third is not, and
 * `deps.ts` explains what happens to it in the meantime.
 */
import { getConfig } from "@/shared/config";
import type { Sql } from "@/shared/db";

/**
 * How long a checkout holds inventory before the sweep takes it back.
 *
 * `checkout-orders`: "The system SHALL reserve inventory when checkout begins,
 * holding it for a configured reservation window... If payment is not completed
 * within the window, the reservation SHALL be released automatically."
 *
 * The registry bounds it at 5..1440 minutes, which SECURITY.md S1-17 item 4
 * requires: without the `CHECK`, an admin — or anyone who reached `app_config`
 * — could widen the TTL into an inventory-hostage weapon.
 */
export async function reservationTtlMinutes(db: Sql): Promise<number> {
  return getConfig(db, "checkout.reservation_ttl_minutes");
}

/**
 * The platform's commission, in basis points, as it stands right now.
 *
 * Read once at placement and snapshotted onto the order row. SECURITY.md S0-5
 * item 3: "`commission_rate_bp` is read from `app_config` server-side and
 * snapshotted onto the order row at placement. `orders` has no UPDATE policy
 * for `authenticated` — neither buyer nor artist can amend a placed order." A
 * rate read at payout time instead would let a commission change reprice a sale
 * that already happened, in either direction.
 *
 * This module never divides by it. Splitting a subtotal into commission and net
 * is `payouts`' work through `shared/money`; all that happens here is that the
 * number in force at the moment of sale is written down.
 */
export async function commissionRateBp(db: Sql): Promise<number> {
  return getConfig(db, "platform.commission_rate_bp");
}
