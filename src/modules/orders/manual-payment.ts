/**
 * `ManualPaymentProvider` — the adapter PACHKA launches with.
 *
 * `checkout-orders`: "This change SHALL ship a manual adapter that records a
 * payment as pending settlement and marks it paid on operator confirmation; no
 * live payment provider is integrated."
 *
 * WHAT "MANUAL" MEANS HERE
 * -----------------------
 * There is no payment company. A buyer confirms an order, is emailed transfer
 * instructions, and sends money by bank transfer. An operator sees it arrive in
 * the bank and marks the order paid. That operator action is
 * `payments.markPaymentReceived`, which calls `capture` below and then moves the
 * order through `orders.transition()` like every other state change.
 *
 * So this adapter's "provider" is a person and a bank statement. That has one
 * consequence worth stating plainly: **the adapter is not the authority on
 * whether money arrived.** The `payments` table is, because the operator's
 * confirmation is what is being recorded and there is no external system to
 * ask. `getStatus` below therefore reports what this adapter was told through
 * its own methods, and `payments.ts` never consults it to decide anything.
 *
 * WHY THIS ADAPTER HOLDS NO STATE
 * ------------------------------
 * An earlier draft kept an in-process map of references so `getStatus` could
 * answer from memory. That is wrong in the deployment PACHKA actually has.
 * Vercel runs many short-lived lambdas (see `shared/db/instance.ts`), so the
 * instance that authorises a payment in March is not the instance an operator
 * confirms it from in April — the map would be empty and `capture` would refuse
 * a payment that had genuinely arrived. It also fails across an ordinary
 * restart, and the integration suite caught it immediately by constructing the
 * provider twice.
 *
 * So there is no map. The `payments` table is the record — it always was, and
 * the map was a second one that could disagree with it. `capture` and `refund`
 * record what the operator saw; there is no external ledger to check them
 * against, because the external ledger is a bank statement and a human.
 *
 * WHY THIS IS A REAL IMPLEMENTATION AND NOT A TEST DOUBLE
 * ------------------------------------------------------
 * ARCHITECTURE.md's test policy allows a deterministic fake for payment,
 * because payment is a genuine external boundary. This module needs no such
 * fake, because the adapter that ships IS deterministic and reaches no network:
 * the integration tests drive the same object production does. A fake would be
 * a second implementation of an interface with one, and every assertion made
 * against it would be an assertion about the fake.
 */
import { randomUUID } from "node:crypto";
import { AppError } from "@/shared/errors";
import type { Agorot } from "@/shared/money";
import type { AuthorizeRequest, PaymentOutcome, PaymentProvider } from "./payment-provider";

export const MANUAL_PROVIDER_NAME = "manual";

/**
 * What the buyer is told to do. Deliberately not bank account numbers.
 *
 * SECURITY.md S1-11 is about bank details in logs, emails and exports, and the
 * account the buyer transfers to is PACHKA's rather than an artist's — but the
 * habit of pasting account numbers into a template is how an artist's ends up
 * there too. The operator's real transfer details belong in the mail template
 * the operator maintains, keyed off this reference, not in module source.
 */
const INSTRUCTIONS =
  "התשלום יבוצע בהעברה בנקאית. פרטי ההעברה יישלחו אליך בדוא״ל יחד עם מספר ההזמנה. " +
  "ההזמנה תישמר עבורך עד לקבלת התשלום.";

export interface ManualPaymentProviderOptions {
  /**
   * Reference generator. Overridable so a test can assert on a stable string
   * without the adapter having to know it is being tested; production takes the
   * default and gets a UUID.
   */
  readonly newReference?: () => string;
}

export function createManualPaymentProvider(
  options: ManualPaymentProviderOptions = {},
): PaymentProvider {
  const newReference = options.newReference ?? (() => `manual-${randomUUID()}`);

  const assertAmount = (amountAgorot: Agorot, verb: string): void => {
    if (amountAgorot < 0) {
      throw AppError.validation(`Cannot ${verb} a negative amount (${amountAgorot} agorot).`, {
        code: "orders.negative_payment_amount",
        details: { amountAgorot },
      });
    }
  };

  return {
    name: MANUAL_PROVIDER_NAME,

    /**
     * Records the intent to pay. No money moves and none is promised: the
     * status is `pending`, which is what "pending settlement" is called in the
     * PACHKA payment vocabulary.
     */
    async authorize(request: AuthorizeRequest): Promise<PaymentOutcome> {
      assertAmount(request.amountAgorot, "authorise");
      return { reference: newReference(), status: "pending", instructions: INSTRUCTIONS };
    },

    /**
     * The operator has seen the transfer land.
     *
     * Unconditional, and idempotent because of it: there is no payment company
     * to ask and no authorisation hold to release, so the operator's assertion
     * that the money arrived is the whole of the event. Whether the order was in
     * a state to be captured is `payments.ts`'s question, decided against the
     * `payments` row under the order lock — not this adapter's, which would be
     * answering it from a second copy of the truth.
     */
    async capture(reference: string, amountAgorot: Agorot): Promise<PaymentOutcome> {
      assertAmount(amountAgorot, "capture");
      return { reference, status: "captured" };
    },

    /** Give the money back. In the manual world, a transfer in the other direction. */
    async refund(reference: string, amountAgorot: Agorot): Promise<PaymentOutcome> {
      assertAmount(amountAgorot, "refund");
      return { reference, status: "refunded" };
    },

    /**
     * There is no external system to ask, and saying so is the honest answer.
     *
     * A real adapter reconciles against the provider here — a webhook that never
     * arrived, an operator wondering why an order is stuck. The manual adapter
     * has a bank statement and a person instead, and the `payments` table is
     * where what they concluded is written down. Returning `pending` would be a
     * plausible-looking lie about every payment an operator had already
     * confirmed, and a caller that believed it would un-pay real orders.
     *
     * `payments.ts` never calls this. It is here because the interface has it
     * and a real provider will need it.
     */
    async getStatus(reference: string): Promise<PaymentOutcome> {
      throw AppError.externalFailure(
        "The manual payment adapter has no external ledger to query. " +
          "The `payments` table is the record of what the operator confirmed.",
        { code: "orders.manual_status_unavailable", details: { reference } },
      );
    },
  };
}
/**
 * The manual adapter's payment instructions, for the order-placed email.
 *
 * Exported so `notifications.ts` renders the same words the provider returns,
 * without importing the provider or knowing which one is installed.
 */
export const MANUAL_PAYMENT_INSTRUCTIONS = INSTRUCTIONS;
