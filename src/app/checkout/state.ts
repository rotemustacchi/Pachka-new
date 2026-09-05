/**
 * What the checkout action hands back to its form.
 *
 * A separate module from `actions.ts` for a mechanical reason, and it is worth
 * being precise about it because the failure is silent: a `"use server"` module
 * may export only async functions, and a single exported constant beside them
 * does not raise there — it makes the module export NOTHING AT ALL. Every
 * import of an action from it then fails at build time pointing at the
 * importer rather than at the cause. `_lib/form-state.ts` records the same
 * constraint for the same reason.
 *
 * Types are erased and so could have stayed; `IDLE_CHECKOUT` could not, and
 * splitting half of a pair across two files is worse than splitting both.
 */
import type { FieldErrors } from "@/shared/errors";

/** The money a buyer is shown, already formatted. No `Agorot` crosses to the client. */
export interface CheckoutQuote {
  readonly subtotal: string;
  readonly shipping: string;
  readonly total: string;
  /**
   * Sent back on the confirm as the integrity check.
   *
   * The figure that was DISPLAYED. `beginCheckout` compares it against the
   * total it derives under the lock and aborts on any difference, so it is
   * never used as an amount and tampering with it can only refuse a sale.
   */
  readonly totalAgorot: number;
  readonly zoneDisplayName: string;
  readonly parcelCount: number;
}

export interface CheckoutState {
  readonly status: "idle" | "error" | "quoted";
  readonly message?: string;
  readonly fields?: FieldErrors;
  readonly quote?: CheckoutQuote;
}

export const IDLE_CHECKOUT: CheckoutState = { status: "idle" };
