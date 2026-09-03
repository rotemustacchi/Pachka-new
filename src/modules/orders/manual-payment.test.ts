/**
 * The manual payment adapter.
 *
 * The thing worth testing here is not the happy path — it is that the adapter
 * holds no state. An earlier version kept an in-process map of references so
 * `getStatus` could answer from memory, and the integration suite caught it the
 * first time two provider instances existed in one test. In production that map
 * would be empty on every request: Vercel runs short-lived lambdas, so the
 * instance that authorises a payment in March is not the instance an operator
 * confirms it from in April, and `capture` would have refused money that had
 * genuinely arrived.
 *
 * So the first test below constructs a SECOND provider and captures a reference
 * the first one issued. That is the deployment, written down.
 */
import { describe, expect, it } from "vitest";
import { agorot } from "@/shared/money";
import { createManualPaymentProvider, MANUAL_PROVIDER_NAME } from "./manual-payment";

const ORDER = "8f1f0a3e-1c2b-4d5e-8a9b-0c1d2e3f4a5b";

describe("the manual adapter", () => {
  it("records a payment as pending settlement and tells the buyer what to do", async () => {
    // `checkout-orders`: "a manual adapter that records a payment as pending
    // settlement and marks it paid on operator confirmation".
    const provider = createManualPaymentProvider();

    const outcome = await provider.authorize({
      orderId: ORDER,
      amountAgorot: agorot(133_900),
      currency: "ILS",
    });

    expect(outcome.status).toBe("pending");
    expect(outcome.reference).toMatch(/^manual-/);
    expect(outcome.instructions).toBeTruthy();
    expect(provider.name).toBe(MANUAL_PROVIDER_NAME);
  });

  it("issues a distinct reference per authorisation", async () => {
    // The reference is what a refund and an operator's query are keyed on, and
    // the payments table has a unique constraint on (provider, reference).
    const provider = createManualPaymentProvider();
    const first = await provider.authorize({
      orderId: ORDER,
      amountAgorot: agorot(1000),
      currency: "ILS",
    });
    const second = await provider.authorize({
      orderId: ORDER,
      amountAgorot: agorot(1000),
      currency: "ILS",
    });

    expect(first.reference).not.toBe(second.reference);
  });

  it("captures a reference issued by a different instance entirely", async () => {
    // THE REGRESSION TEST. Two providers stand in for two lambda invocations
    // weeks apart. An adapter that remembered its own authorisations would
    // throw here, and would throw in production every single time.
    const authorising = createManualPaymentProvider();
    const { reference } = await authorising.authorize({
      orderId: ORDER,
      amountAgorot: agorot(133_900),
      currency: "ILS",
    });

    const confirming = createManualPaymentProvider();
    const captured = await confirming.capture(reference, agorot(133_900));

    expect(captured).toEqual({ reference, status: "captured" });
  });

  it("is idempotent on capture, because an operator double-click is not an error", async () => {
    const provider = createManualPaymentProvider();
    const { reference } = await provider.authorize({
      orderId: ORDER,
      amountAgorot: agorot(500),
      currency: "ILS",
    });

    expect(await provider.capture(reference, agorot(500))).toEqual({
      reference,
      status: "captured",
    });
    expect(await provider.capture(reference, agorot(500))).toEqual({
      reference,
      status: "captured",
    });
  });

  it("refunds against a reference, in whole or in part", async () => {
    // Partial refunds are what `shipping`'s return flow needs when a
    // cancellation fee is withheld.
    const provider = createManualPaymentProvider();
    const { reference } = await provider.authorize({
      orderId: ORDER,
      amountAgorot: agorot(133_900),
      currency: "ILS",
    });
    await provider.capture(reference, agorot(133_900));

    expect(await provider.refund(reference, agorot(130_000))).toEqual({
      reference,
      status: "refunded",
    });
  });

  it("refuses a negative amount anywhere", async () => {
    const provider = createManualPaymentProvider();

    await expect(
      provider.authorize({ orderId: ORDER, amountAgorot: agorot(-1), currency: "ILS" }),
    ).rejects.toMatchObject({ kind: "validation", code: "orders.negative_payment_amount" });
    await expect(provider.capture("manual-x", agorot(-1))).rejects.toMatchObject({
      code: "orders.negative_payment_amount",
    });
    await expect(provider.refund("manual-x", agorot(-1))).rejects.toMatchObject({
      code: "orders.negative_payment_amount",
    });
  });

  it("says plainly that it cannot report a status rather than guessing one", async () => {
    // There is no external ledger — the ledger is a bank statement and a human,
    // and the `payments` table is where what they concluded is written down.
    // Returning `pending` would be a plausible-looking lie about every payment
    // an operator had already confirmed, and a caller that believed it would
    // un-pay real orders.
    const provider = createManualPaymentProvider();
    const { reference } = await provider.authorize({
      orderId: ORDER,
      amountAgorot: agorot(1000),
      currency: "ILS",
    });

    await expect(provider.getStatus(reference)).rejects.toMatchObject({
      kind: "external_failure",
      code: "orders.manual_status_unavailable",
    });
  });

  it("takes an injected reference generator so a caller can make it deterministic", async () => {
    const provider = createManualPaymentProvider({ newReference: () => "manual-fixed" });
    const outcome = await provider.authorize({
      orderId: ORDER,
      amountAgorot: agorot(1000),
      currency: "ILS",
    });
    expect(outcome.reference).toBe("manual-fixed");
  });
});
