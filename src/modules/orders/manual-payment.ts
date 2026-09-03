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
 * WHY THIS IS A REAL IMPLEMENTATION AND NOT A TEST DOUBLE
 * ------------------------------------------------------
 * ARCHITECTURE.md's test policy allows a deterministic fake for payment,
 * because payment is a genuine external boundary. This module needs no such
 * fake, because the adapter that ships IS deterministic and reaches no network:
 * the integration tests drive the same object production does. A fake would be
 * a second implementation of an interface with one, and every assertion made
 * against it would be an assertion about the fake.
 *
 * The in-process map exists so `getStatus` can answer honestly. It is a cache of
 * this adapter's own calls, not a store of record — a fresh process starts empty
 * and `payments.ts` neither reads nor needs it, which is why losing it costs
 * nothing.
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

interface ManualPayment {
  status: PaymentOutcome["status"];
  amountAgorot: Agorot;
}

export function createManualPaymentProvider(
  options: ManualPaymentProviderOptions = {},
): PaymentProvider {
  const newReference = options.newReference ?? (() => `manual-${randomUUID()}`);
  const known = new Map<string, ManualPayment>();

  const remember = (reference: string, payment: ManualPayment): void => {
    known.set(reference, payment);
  };

  const requirePayment = (reference: string): ManualPayment => {
    const payment = known.get(reference);
    if (!payment) {
      // Not `not_found`: from the caller's point of view the payment company is
      // an external system that has lost track of a reference we hold, which is
      // an integration failure rather than a missing PACHKA resource.
      throw AppError.externalFailure(
        `The manual payment adapter has no record of reference "${reference}".`,
        { code: "orders.payment_reference_unknown", details: { reference } },
      );
    }
    return payment;
  };

  return {
    name: MANUAL_PROVIDER_NAME,

    /**
     * Records the intent to pay. No money moves and none is promised: the
     * status is `pending`, which is what "pending settlement" is called in the
     * PACHKA payment vocabulary.
     */
    async authorize(request: AuthorizeRequest): Promise<PaymentOutcome> {
      const reference = newReference();
      remember(reference, { status: "pending", amountAgorot: request.amountAgorot });
      return { reference, status: "pending", instructions: INSTRUCTIONS };
    },

    /**
     * The operator has seen the transfer land.
     *
     * Refuses to capture more than was authorised. With a real provider that
     * refusal comes back over the wire; here nothing would stop it, so the
     * adapter stops it — an operator who fat-fingers an extra digit should get
     * an error, not a captured payment for the wrong amount.
     */
    async capture(reference: string, amountAgorot: Agorot): Promise<PaymentOutcome> {
      const payment = requirePayment(reference);

      if (payment.status === "captured") {
        // Idempotent on purpose. An operator who clicks twice, or a retried
        // request, must not produce a second capture — and must not produce an
        // error that reads like the first one failed.
        return { reference, status: "captured" };
      }
      if (payment.status !== "pending") {
        throw AppError.conflict(
          `A payment that is "${payment.status}" cannot be captured.`,
          { code: "orders.payment_not_capturable", details: { reference, status: payment.status } },
        );
      }
      if (amountAgorot > payment.amountAgorot) {
        throw AppError.validation(
          `Cannot capture ${amountAgorot} agorot against an authorisation for ${payment.amountAgorot}.`,
          {
            code: "orders.capture_exceeds_authorisation",
            details: { reference, authorised: payment.amountAgorot, requested: amountAgorot },
          },
        );
      }

      payment.status = "captured";
      return { reference, status: "captured" };
    },

    /**
     * Give the money back. In the manual world this is the operator making a
     * transfer in the other direction; the row is what says it is owed.
     */
    async refund(reference: string, amountAgorot: Agorot): Promise<PaymentOutcome> {
      const payment = requirePayment(reference);

      if (payment.status !== "captured" && payment.status !== "refunded") {
        throw AppError.conflict(
          `A payment that is "${payment.status}" has taken no money and cannot be refunded.`,
          { code: "orders.payment_not_refundable", details: { reference, status: payment.status } },
        );
      }
      if (amountAgorot > payment.amountAgorot) {
        throw AppError.validation(
          `Cannot refund ${amountAgorot} agorot against a payment of ${payment.amountAgorot}.`,
          {
            code: "orders.refund_exceeds_payment",
            details: { reference, paid: payment.amountAgorot, requested: amountAgorot },
          },
        );
      }

      payment.status = "refunded";
      return { reference, status: "refunded" };
    },

    async getStatus(reference: string): Promise<PaymentOutcome> {
      const payment = requirePayment(reference);
      return { reference, status: payment.status };
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
