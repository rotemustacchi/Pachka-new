/**
 * Configuration this module reads. ARCHITECTURE.md: "Every configurable number
 * lives in `app_config`, read through `shared/config`. No magic numbers in
 * module code."
 *
 * Both keys are already in the registry and already bounded, so this module
 * adds none. That is worth stating plainly, because "14 days" appears in three
 * specs and would otherwise be typed into this module as a literal by somebody
 * who did not know the key existed.
 */
import { getConfig } from "@/shared/config";
import type { Sql } from "@/shared/db";

/**
 * Days after DELIVERY before a payout becomes eligible.
 *
 * `artist-payouts`: "delivered state for the full 14-day return window without a
 * return request". Bounded [0, 180] by CONFIG_BOUNDS, so a compromised admin
 * session cannot set it to zero and collect immediately -- and cannot push it
 * out far enough to withhold an artist's money indefinitely either.
 */
export async function eligibilityDelayDays(db: Sql): Promise<number> {
  return getConfig(db, "payouts.eligibility_delay_days");
}

/**
 * The platform commission as it stands RIGHT NOW, in basis points.
 *
 * Used for one thing only: telling an artist what rate a future sale would be
 * made at. It is never an input to a ledger entry. Every entry splits at
 * `orders.commission_rate_bp`, snapshotted at placement, so that a rate change
 * cannot reprice a completed sale (`artist-payouts`, *Rate changes later*;
 * SECURITY.md S0-5 item 3). `orders` exposes the same reader for the same
 * reason and neither module divides by it.
 */
export async function currentCommissionRateBp(db: Sql): Promise<number> {
  return getConfig(db, "platform.commission_rate_bp");
}
