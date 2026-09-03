/**
 * How an order status is spoken about, in Hebrew, in one place.
 *
 * Two different people read these words and they need different sentences for
 * the same state. `paid` means "we have your money, the artist is preparing it"
 * to a buyer, and "this is yours to pack and post" to an artist. Rendering one
 * string for both would either nag the buyer to dispatch something or tell the
 * artist their own payment went through.
 *
 * Kept out of the components so both views and any route that needs a label get
 * the same words, and so the mapping can be read without reading JSX. Machine
 * keys never appear on screen: the status is a stable identifier, the label is a
 * translation, and translations get edited.
 */
import type { OrderStatus } from "../types";

/** What the buyer is told their order is doing. */
export const BUYER_STATUS_LABELS: Readonly<Record<OrderStatus, string>> = {
  awaiting_payment: "ממתינה לתשלום",
  paid: "בהכנה למשלוח",
  shipped: "בדרך אליך",
  delivered: "נמסרה",
  return_requested: "החזרה בטיפול",
  returned: "הוחזרה",
  cancelled: "בוטלה",
};

/** What the artist is told their fulfilment is doing. */
export const ARTIST_STATUS_LABELS: Readonly<Record<OrderStatus, string>> = {
  // The artist has nothing to do yet, and must not be told to pack anything:
  // the buyer's address is withheld until `paid`, so an "ship this" prompt here
  // would point at a screen with no address on it.
  awaiting_payment: "ממתינה לתשלום הקונה",
  paid: "לשליחה",
  shipped: "נשלחה",
  delivered: "נמסרה",
  return_requested: "החזרה בטיפול",
  returned: "הוחזרה",
  cancelled: "בוטלה",
};

/**
 * The visual weight a status carries.
 *
 * `attention` is reserved for a state where the person reading has something to
 * do: pay, or post a parcel. Everything else is neutral, because a screen where
 * every badge shouts tells the reader nothing.
 */
export type StatusTone = "attention" | "progress" | "done" | "ended";

export function buyerStatusTone(status: OrderStatus): StatusTone {
  switch (status) {
    case "awaiting_payment":
      return "attention";
    case "paid":
    case "shipped":
    case "return_requested":
      return "progress";
    case "delivered":
      return "done";
    case "returned":
    case "cancelled":
      return "ended";
  }
}

export function artistStatusTone(status: OrderStatus): StatusTone {
  // `paid` is the one that matters to an artist: it is the moment a dispatch
  // deadline starts running (`shipping`'s obligation), so it is the one state
  // their screen should single out.
  return status === "paid" ? "attention" : buyerStatusTone(status);
}
