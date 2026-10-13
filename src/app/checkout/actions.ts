"use server";

/**
 * Checkout, in two submits: quote, then confirm.
 *
 * `checkout-orders` requires the buyer to see item prices, shipping and the
 * total in ILS BEFORE confirming. Shipping is a function of zone x size tier
 * and the zone comes from the delivery city, so there is nothing honest to
 * quote until an address exists. Hence two submits against one form: the first
 * prices it, the second places it.
 *
 * The address is not carried between them by this action. The form's inputs are
 * uncontrolled and React preserves the DOM across a `useActionState`
 * re-render, so what the buyer typed is still in the fields and is re-posted on
 * the confirm. Nothing personal therefore travels in this action's return
 * value, in a cookie, or in a URL.
 *
 * EVERY FIGURE IS DERIVED SERVER-SIDE
 * -----------------------------------
 * SECURITY.md S0-5: "The checkout request body contains only artwork IDs,
 * quantities, and the delivery address. Every monetary figure is derived
 * server-side." So this action reads no amount, no zone and no size tier from
 * the form. It cannot: `CheckoutRequest` has no field for a price the server
 * would use, and the artwork ids come from the cart cookie while the prices
 * come from the artwork rows under the lock.
 *
 * The one number that does travel from the browser is
 * `displayedTotalAgorot` — the figure the buyer was SHOWN. It is compared and
 * then discarded (S0-5 item 5): a stale or edited value aborts the checkout
 * rather than silently re-pricing it, so tampering with it can only ever
 * refuse a sale, never change what is charged. That comparison is also how
 * `checkout-orders`' *Price changed since adding* scenario is caught at the
 * moment it matters — the window between seeing a total and confirming it.
 *
 * WHAT IS NOT DONE HERE
 * --------------------
 * The order is not moved, priced or reconciled by this file — `beginCheckout`
 * does all of it inside one transaction, under `SELECT ... FOR UPDATE` on each
 * artwork row, in sorted id order so two buyers cannot deadlock. This action
 * parses a form, calls it, and redirects.
 *
 * `beginCheckout` also returns `notifications` for the caller to dispatch once
 * the transaction has committed, which is what `dispatchAppNotifications` below
 * does. It never throws: a mail outage must not fail an order that already
 * exists and already holds inventory. The buyer is also shown the payment
 * instructions on the order page, because that is the one thing they must not
 * miss and an email is not a guarantee that they read it.
 *
 * Only async functions are exported from here. A `"use server"` module that
 * exports a constant beside them exports nothing at all — see `./state.ts`,
 * which is where `CheckoutState` and `IDLE_CHECKOUT` therefore live.
 */
import { redirect } from "next/navigation";
import { dispatchAppNotifications } from "@/app/_lib/deps";
import { formatAgorot } from "@/shared/money";
import { isAppError } from "@/shared/errors";
import {
  beginCheckout,
  previewCheckout,
  type CartLineInput,
  type CheckoutLine,
  type DeliveryInput,
} from "@/modules/orders";
import { requireUserId } from "@/app/(accounts)/deps";
import { ordersDeps } from "@/app/_lib/deps";
import { readCart, writeCart } from "@/app/_cart/cart";
import type { CheckoutState } from "./state";


function text(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === "string" ? value.trim() : "";
}

function optional(form: FormData, name: string): string | null {
  const value = text(form, name);
  return value === "" ? null : value;
}

/**
 * The delivery address as the form posts it.
 *
 * Not validated here — `orders.validateDelivery` reports every missing field at
 * once, which is what `checkout-orders` asks for ("blocks the order and
 * identifies the missing fields"), and a check in this file would be a second
 * copy of that list to keep in step.
 */
function deliveryFrom(form: FormData): DeliveryInput {
  return {
    fullName: text(form, "fullName"),
    phone: text(form, "phone"),
    line1: text(form, "line1"),
    line2: optional(form, "line2"),
    city: text(form, "city"),
    postalCode: optional(form, "postalCode"),
    countryCode: text(form, "countryCode") || "IL",
  };
}

/** The cart cookie as checkout lines. Ids and quantities; the price only to compare. */
function toCheckoutLines(lines: readonly CartLineInput[]): readonly CheckoutLine[] {
  return lines.map((line) => ({
    artworkId: line.artworkId,
    quantity: line.quantity ?? 1,
    ...(line.priceWhenAddedAgorot === undefined
      ? {}
      : { displayedUnitPriceAgorot: line.priceWhenAddedAgorot }),
  }));
}

function asState(error: unknown): CheckoutState {
  if (isAppError(error)) {
    return {
      status: "error",
      message: error.message,
      ...(error.fields ? { fields: error.fields } : {}),
    };
  }
  // An unexpected error may carry a connection string or a row of someone
  // else's data in its message (SECURITY.md S2-26).
  return { status: "error", message: "משהו השתבש. נסו שוב." };
}

export async function checkoutAction(
  _previous: CheckoutState,
  form: FormData,
): Promise<CheckoutState> {
  const cart = await readCart();
  if (cart.length === 0) {
    return { status: "error", message: "העגלה ריקה." };
  }

  const deps = ordersDeps();
  const delivery = deliveryFrom(form);
  const lines = toCheckoutLines(cart);
  const confirming = form.get("confirm") === "1";

  if (!confirming) {
    try {
      const preview = await previewCheckout(deps, { lines, delivery });
      return {
        status: "quoted",
        quote: {
          subtotal: formatAgorot(preview.subtotalAgorot),
          shipping: preview.shippingAgorot === 0 ? "חינם" : formatAgorot(preview.shippingAgorot),
          total: formatAgorot(preview.totalAgorot),
          totalAgorot: preview.totalAgorot,
          zoneDisplayName: preview.zoneDisplayName,
          parcelCount: preview.parcelCount,
        },
      };
    } catch (error) {
      return asState(error);
    }
  }

  // The real gate. Never the page's answer to "is somebody signed in" — that
  // is a render-time convenience, and identity must be read from the session
  // on the action itself.
  let orderId: string;
  try {
    const buyerId = await requireUserId();
    const shown = Number(text(form, "displayedTotalAgorot"));

    const result = await beginCheckout(deps, {
      buyerId,
      lines,
      delivery,
      ...(Number.isSafeInteger(shown) && shown > 0 ? { displayedTotalAgorot: shown } : {}),
    });
    orderId = result.order.id;

    // Dispatch AFTER the order is committed, and never before. These carry the
    // manual payment instructions — the buyer has no other way to learn what to
    // do next, since the manual adapter takes no money at checkout.
    //
    // `dispatchAppNotifications` neither throws nor rejects: a mail outage must
    // not fail an order that already exists and already holds inventory.
    await dispatchAppNotifications(result.notifications);
  } catch (error) {
    return asState(error);
  }

  // Only now. The wish has become a reservation, and a cart still holding the
  // line would let the buyer place the same order twice.
  await writeCart([]);
  redirect(`/orders/${orderId}`);
}
