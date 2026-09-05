/**
 * /checkout — the cart and the order placement.
 *
 * ARCHITECTURE.md: routes parse input, call a module API, and render. The cart
 * cookie holds artwork ids and quantities; `orders.revalidateCart` turns them
 * into a priced, availability-checked view by re-reading every row. Nothing on
 * this page is believed from the client, and the page sums nothing itself.
 *
 * SIGNING IN IS ASKED FOR HERE AND ENFORCED IN THE ACTION
 * ------------------------------------------------------
 * The cart is browsable anonymously — it reserves nothing and reveals nothing.
 * Placing an order is not: `beginCheckout` gates on email verification at
 * RESERVATION time, because an unverified and therefore disposable account that
 * can lock inventory is the whole of SECURITY.md S1-17.
 *
 * So this page shows a sign-in prompt instead of the delivery form when nobody
 * is signed in, and that is a courtesy, not the control. The control is
 * `requireUserId()` inside the Server Action, which reads the session on the
 * request that places the order. A page's answer to "who is this" must never be
 * what an action trusts.
 *
 * THE PAYMENT STORY IS TOLD BEFORE THE BUYER COMMITS
 * --------------------------------------------------
 * PACHKA launches with the manual payment adapter: an order is recorded as
 * pending settlement, the buyer transfers by bank, and an operator marks it
 * paid. Nothing about that is obvious from a button labelled "confirm", so
 * `MANUAL_PAYMENT_INSTRUCTIONS` — the module's own wording, not a second copy
 * of it — is on the page before the buyer commits rather than only in an email
 * afterwards.
 */
import { revalidateCart, MANUAL_PAYMENT_INSTRUCTIONS } from "@/modules/orders";
import { getDatabase } from "@/shared/db";
import { SectionHeading } from "@/shared/ui";
import { currentUserId, SIGN_IN_PATH } from "@/app/_lib/viewer";
import { readCart } from "@/app/_cart/cart";
import { loadReturnTerms } from "@/app/_shipping/load";
import { ReturnTermsPanel } from "@/app/_shipping/ReturnTermsPanel";
import { CartSummary } from "./CartSummary";
import { CheckoutForm } from "./CheckoutForm";

export const dynamic = "force-dynamic";
export const metadata = { title: "עגלה ותשלום — פאצ׳קה" };

export default async function CheckoutPage() {
  const [lines, signedInId, terms] = await Promise.all([
    readCart(),
    currentUserId(),
    loadReturnTerms(),
  ]);

  const cart = await revalidateCart(getDatabase(), lines);

  return (
    <div className="mx-auto flex max-w-[1100px] flex-col gap-8 px-6 py-12 sm:px-12">
      <SectionHeading as="h1">עגלה ותשלום</SectionHeading>

      <div className="grid gap-8 lg:grid-cols-[1fr_520px]">
        <div className="flex flex-col gap-6">
          <CartSummary cart={cart} />
          <ReturnTermsPanel terms={terms} />
        </div>

        <div className="flex flex-col gap-6">
          {/* Nothing to deliver, so nothing to ask for. */}
          {cart.checkoutable ? (
            signedInId === null ? (
              <section className="border border-rule bg-card p-6">
                <h2 className="m-0 mb-2 text-base font-bold text-ink">כניסה לחשבון</h2>
                <p className="m-0 mb-4 text-[15px] font-light leading-[1.7] text-ink-soft">
                  כדי לשמור עבורכם את היצירה ולשלוח אותה, צריך חשבון מאומת.
                </p>
                <a
                  href={SIGN_IN_PATH}
                  className="inline-flex items-center justify-center rounded-button bg-ink px-10 py-4 text-base font-bold text-paper hover:bg-ink-soft"
                >
                  כניסה
                </a>
              </section>
            ) : (
              <>
                <CheckoutForm />
                <section className="border border-rule bg-card p-5">
                  <h2 className="m-0 mb-2 text-base font-bold text-ink">איך משלמים</h2>
                  <p className="m-0 text-[14px] font-light leading-[1.7] text-ink-soft">
                    {MANUAL_PAYMENT_INSTRUCTIONS}
                  </p>
                </section>
              </>
            )
          ) : null}
        </div>
      </div>
    </div>
  );
}
