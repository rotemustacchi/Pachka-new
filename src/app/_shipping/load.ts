/**
 * Loading the return terms for a route.
 *
 * One line, and it exists so that no route reaches for the wording itself:
 * `shipping.returnTerms` reads the configured window and cancellation fee
 * through `shared/config`, so an operator changing `returns.window_days`
 * changes every surface at once. A page that hard-coded "14 ימים" would be a
 * disclosure that silently stops matching the policy.
 */
import { getDatabase } from "@/shared/db";
import { returnTerms, type ReturnTerms } from "@/modules/shipping";

export function loadReturnTerms(): Promise<ReturnTerms> {
  return returnTerms(getDatabase());
}
