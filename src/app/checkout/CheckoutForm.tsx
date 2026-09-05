"use client";

/**
 * The delivery form, and the quote it produces.
 *
 * The only Client Component in the checkout surface, and it follows the rule
 * `AccountForm` sets: it receives a Server Action reference and nothing else.
 * No cart line, no artwork row, no order is ever a prop to it — React
 * serialises the whole prop object of a Client Component into the RSC payload
 * embedded in the HTML whatever the JSX renders (SECURITY.md S1-8), so the way
 * to keep a row out of the HTML is never to hand it to a component like this.
 *
 * The quote it displays is not a prop either: it is the action's RETURN value,
 * which is money the buyer is being shown on purpose.
 *
 * WHY THE ADDRESS FIELDS ARE UNCONTROLLED
 * ---------------------------------------
 * So that nothing personal has to travel through the action's return value to
 * survive the quote step. React preserves the DOM across a `useActionState`
 * re-render, so what the buyer typed is still in the inputs and is re-posted
 * with the confirm. Echoing the address back through the payload would put a
 * street address in the HTML for no benefit.
 *
 * WHY THE TOTAL IS A HIDDEN INPUT
 * -------------------------------
 * It is the figure that was DISPLAYED, and `beginCheckout` compares it against
 * the total it derives under the lock. A stale value — the price moved, or the
 * piece sold — aborts the checkout instead of surprising the buyer, and an
 * edited one can only ever cause that same abort, because the server never uses
 * it as an amount.
 */
import { useActionState } from "react";
import { Button, Card, Input } from "@/shared/ui";
import { checkoutAction } from "./actions";
import { IDLE_CHECKOUT, type CheckoutState } from "./state";

function Banner({ state }: { readonly state: CheckoutState }) {
  if (state.status !== "error" || state.message === undefined) return null;
  return (
    <p role="alert" className="m-0 border-s-4 border-alert bg-card px-4 py-3 text-[15px] text-alert">
      {state.message}
    </p>
  );
}

/**
 * The cost breakdown, once an address makes one possible.
 *
 * `.numeric` on every figure keeps Latin digits and the shekel sign running LTR
 * inside the RTL document.
 */
function Quote({ state }: { readonly state: CheckoutState }) {
  const quote = state.quote;
  if (quote === undefined) return null;

  return (
    <Card className="p-5">
      <h2 className="m-0 mb-3 text-base font-bold text-ink">סיכום לתשלום</h2>
      <dl className="m-0 flex flex-col gap-2 text-sm">
        <div className="flex justify-between">
          <dt className="text-ink-muted">פריטים</dt>
          <dd className="numeric m-0 text-ink">{quote.subtotal}</dd>
        </div>
        <div className="flex justify-between">
          <dt className="text-ink-muted">
            משלוח · {quote.zoneDisplayName}
            {quote.parcelCount > 1 ? ` · ${quote.parcelCount} משלוחים` : null}
          </dt>
          <dd className="numeric m-0 text-ink">{quote.shipping}</dd>
        </div>
        <div className="flex justify-between border-t border-rule pt-2 font-bold">
          <dt className="text-ink">סה״כ</dt>
          <dd className="numeric m-0 text-ink">{quote.total}</dd>
        </div>
      </dl>
    </Card>
  );
}

export function CheckoutForm() {
  const [state, formAction, pending] = useActionState(checkoutAction, IDLE_CHECKOUT);
  const quoted = state.status === "quoted" && state.quote !== undefined;

  return (
    <form action={formAction} className="flex w-full max-w-[520px] flex-col gap-5">
      <Banner state={state} />

      <Input
        label="שם מלא"
        name="fullName"
        required
        autoComplete="name"
        error={state.fields?.fullName?.[0]}
      />
      <Input
        label="טלפון"
        name="phone"
        type="tel"
        required
        autoComplete="tel"
        error={state.fields?.phone?.[0]}
      />
      <Input
        label="רחוב ומספר בית"
        name="line1"
        required
        autoComplete="address-line1"
        error={state.fields?.line1?.[0]}
      />
      <Input label="דירה, כניסה (רשות)" name="line2" autoComplete="address-line2" />
      <Input
        label="עיר"
        name="city"
        required
        autoComplete="address-level2"
        error={state.fields?.city?.[0]}
      />
      <Input label="מיקוד (רשות)" name="postalCode" autoComplete="postal-code" />
      <input type="hidden" name="countryCode" value="IL" />

      <Quote state={state} />

      {quoted ? (
        <>
          {/* The displayed total, on its way back for the integrity check. */}
          <input type="hidden" name="displayedTotalAgorot" value={state.quote?.totalAgorot} />
          <input type="hidden" name="confirm" value="1" />
          <Button type="submit" disabled={pending}>
            {pending ? "רגע…" : "אישור הזמנה"}
          </Button>
          <p className="m-0 text-[13px] font-light leading-[1.6] text-ink-soft">
            אישור ההזמנה שומר עבורכם את היצירה. התשלום מתבצע בהעברה בנקאית, ופרטי ההעברה יישלחו
            בדוא״ל יחד עם מספר ההזמנה.
          </p>
        </>
      ) : (
        <Button type="submit" disabled={pending}>
          {pending ? "רגע…" : "חישוב משלוח וסיכום"}
        </Button>
      )}
    </form>
  );
}
