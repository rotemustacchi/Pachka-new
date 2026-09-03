/**
 * The payment interface. One of them, for every provider there will ever be.
 *
 * `checkout-orders`, "Payment provider abstraction": "The system SHALL route all
 * payment operations -- authorise, capture, and refund -- through a single
 * internal payment interface. No provider-specific code SHALL exist outside an
 * adapter implementing that interface."
 *
 * The scenario that decides whether this file is right:
 *
 *   WHEN a payment provider is later integrated
 *   THEN it is added as a new adapter behind the same interface, with no change
 *        required to cart, checkout, or order logic
 *
 * So nothing below names a provider, and nothing below returns a provider's own
 * vocabulary. The three things that leak in practice are shaped out here on
 * purpose:
 *
 *   • **Money.** Amounts are `Agorot`, never a float and never a decimal string
 *     like a card processor's `"12.50"`. Conversion is the adapter's job, at
 *     its own boundary (ARCHITECTURE.md; SECURITY.md S2-27).
 *   • **Status.** The union below is PACHKA's, not Stripe's or Tranzila's. An
 *     adapter maps its provider's states onto it and is the only file that has
 *     ever heard of the provider's names.
 *   • **Failure.** A provider that is down is `external_failure` in the PACHKA
 *     taxonomy, which is a 502 -- not a validation error and not a conflict. An
 *     adapter that lets an HTTP client's error escape has leaked.
 *
 * The interface is deliberately NOT given a database handle. A provider talks to
 * a payment company; recording what it said is `payments.ts`'s job, against a
 * table this module owns. Mixing the two is what makes an adapter untestable
 * without a database and a database call untestable without a network.
 */
import type { Agorot } from "@/shared/money";
import type { PaymentStatus } from "./types";

/**
 * What a provider is asked to do at checkout.
 *
 * Note what is absent: no card number, no token, no billing address. Entering
 * payment credentials is out of scope for the MVP's manual adapter, and a real
 * adapter takes them at the provider's own hosted form rather than through
 * PACHKA -- which is what keeps this codebase out of PCI scope entirely.
 */
export interface AuthorizeRequest {
  readonly orderId: string;
  readonly amountAgorot: Agorot;
  readonly currency: string;
  /** For the provider's own receipt and reconciliation. Never used as an amount. */
  readonly buyerReference?: string;
}

/**
 * What a provider says back.
 *
 * `reference` is the provider's identifier for the attempt and is stored on the
 * payment row. It is what a later webhook, a refund, or an operator's query at
 * the provider's own dashboard is keyed on, so an adapter that does not have one
 * must invent a stable one rather than return an empty string.
 */
export interface PaymentOutcome {
  readonly reference: string;
  readonly status: PaymentStatus;
  /**
   * Present when the buyer has something to do -- for the manual adapter, the
   * bank transfer details. Rendered into the order-placed email.
   */
  readonly instructions?: string;
  /** Set when `status` is `failed`. Safe to show the buyer. */
  readonly failureReason?: string;
}

export interface PaymentProvider {
  /**
   * Stable machine name, stored on every payment row this provider creates.
   * It is how an operator tells a manual payment from a card one six months
   * later, and how a migration to a real provider leaves the old rows legible.
   */
  readonly name: string;

  /**
   * Begin taking payment. Returns without money having moved.
   *
   * For the manual adapter this records the intent to pay by bank transfer;
   * for a card provider it is the authorisation hold.
   */
  authorize(request: AuthorizeRequest): Promise<PaymentOutcome>;

  /** Take the money that `authorize` reserved. */
  capture(reference: string, amountAgorot: Agorot): Promise<PaymentOutcome>;

  /**
   * Give it back. Partial refunds are expressed by passing less than the
   * captured amount, which is what `shipping`'s return flow needs when a
   * cancellation fee is withheld.
   */
  refund(reference: string, amountAgorot: Agorot): Promise<PaymentOutcome>;

  /**
   * What the provider currently believes about this payment.
   *
   * For reconciliation: a webhook that never arrived, an operator asking why an
   * order is stuck. It is the provider's opinion, not PACHKA's -- the `payments`
   * table is the record, and `payments.ts` is what decides whether to believe a
   * disagreement.
   */
  getStatus(reference: string): Promise<PaymentOutcome>;
}
