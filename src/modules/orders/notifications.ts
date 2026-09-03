/**
 * The transactional emails: order placed, payment received, shipped, delivered.
 *
 * Nothing here sends anything. Every function returns `NotificationRequest[]`
 * and the caller dispatches them once its transaction has committed — the same
 * contract `shipping` uses, and for the reason `shipping` gives: "nobody is told
 * about something that then rolled back — and this module needs no external
 * dependency, and therefore no fake in any of its tests."
 *
 * That is not a stylistic preference. Mail is one of the two boundaries
 * ARCHITECTURE.md's test policy permits a fake for. Structuring the module so
 * the boundary is outside it means the tests assert what the emails SAY, from
 * pure functions, instead of asserting that a mailer object was called — which
 * is the "asserting that a mock was called is not a test" the same policy
 * rejects.
 *
 * WHAT GOES IN A MESSAGE, AND WHAT NEVER DOES
 * -------------------------------------------
 * `checkout-orders`: "The system SHALL NOT show the buyer the artist's contact
 * details at any point." An order-placed email that listed "your pieces are
 * coming from Dana in Haifa, dana@example.com" would breach that as thoroughly
 * as a web page would, and email is worse — it leaves the platform and cannot be
 * un-sent. So no `data` payload below carries an artist's name, address or
 * email; artist-bound messages carry a recipient id and let the mail layer
 * resolve the address it is sending to.
 *
 * Buyer contact details travel the other way under the same rule: an artist's
 * dispatch email carries the order and fulfilment ids, and the address is
 * fetched through `artistFulfilment()` — which checks state and ownership —
 * rather than pasted into a template that has checked nothing.
 */
import type { Fulfilment, Order } from "./types";

export type NotificationAudience = "buyer" | "artist" | "admin";

/**
 * Something that needs telling, handed back rather than sent.
 *
 * Structurally identical to `shipping.NotificationRequest` on purpose: the
 * composition root dispatches both through one mail layer, and two shapes would
 * mean two dispatchers.
 */
export interface NotificationRequest {
  readonly audience: NotificationAudience;
  /** Stable template identifier. Callers switch on this, never on prose. */
  readonly template: string;
  /** The account to notify. Absent for `admin`, which is an operator queue. */
  readonly recipientId?: string;
  readonly data: Readonly<Record<string, unknown>>;
}

/**
 * Every template this module emits. Exported as a constant so the mail layer
 * can be checked against it exhaustively rather than by grepping for strings.
 */
export const ORDER_TEMPLATES = {
  orderPlaced: "orders.order_placed",
  operatorPaymentPending: "orders.operator_payment_pending",
  paymentReceived: "orders.payment_received",
  artistDispatchRequested: "orders.artist_dispatch_requested",
  fulfilmentShipped: "orders.fulfilment_shipped",
  orderDelivered: "orders.order_delivered",
  orderCancelled: "orders.order_cancelled",
} as const;

export type OrderTemplate = (typeof ORDER_TEMPLATES)[keyof typeof ORDER_TEMPLATES];

/**
 * `checkout-orders`, *Order placed with the manual adapter*: "the order is
 * created in `awaiting_payment`, inventory stays reserved, and both buyer and
 * operator receive instructions by email."
 *
 * Two messages, therefore, not one: the buyer's, carrying what to do, and the
 * operator's, so a human knows to watch the bank for a transfer that will
 * arrive with no other warning.
 */
export function orderPlacedNotifications(input: {
  readonly order: Order;
  readonly fulfilments: readonly Fulfilment[];
  readonly instructions: string | null;
}): NotificationRequest[] {
  const { order, fulfilments, instructions } = input;

  return [
    {
      audience: "buyer",
      template: ORDER_TEMPLATES.orderPlaced,
      recipientId: order.buyerId,
      data: {
        orderId: order.id,
        subtotalAgorot: order.subtotalAgorot,
        shippingAgorot: order.shippingAgorot,
        totalAgorot: order.totalAgorot,
        currency: order.currency,
        // How many parcels to expect. Not WHO they come from: the count is a
        // fact about the delivery, the identities are the artists' to withhold.
        parcelCount: fulfilments.length,
        instructions,
      },
    },
    {
      audience: "admin",
      template: ORDER_TEMPLATES.operatorPaymentPending,
      data: {
        orderId: order.id,
        totalAgorot: order.totalAgorot,
        currency: order.currency,
      },
    },
  ];
}

/**
 * `checkout-orders`, *Operator confirms payment received*: "the order moves to
 * `paid`, the reservation converts to a sale, and the artist is notified to
 * dispatch."
 *
 * One message per artist, because each artist dispatches their own parcel and
 * neither should learn what the other is sending. `artistDispatchRequested`
 * carries only ids; the artist follows them into `artistFulfilment()`, which is
 * where the buyer's address is released and where the state and ownership
 * checks live.
 */
export function paymentReceivedNotifications(input: {
  readonly order: Order;
  readonly fulfilments: readonly Fulfilment[];
}): NotificationRequest[] {
  const { order, fulfilments } = input;

  return [
    {
      audience: "buyer",
      template: ORDER_TEMPLATES.paymentReceived,
      recipientId: order.buyerId,
      data: {
        orderId: order.id,
        totalAgorot: order.totalAgorot,
        currency: order.currency,
      },
    },
    ...fulfilments.map((fulfilment) => ({
      audience: "artist" as const,
      template: ORDER_TEMPLATES.artistDispatchRequested,
      recipientId: fulfilment.artistId,
      data: {
        orderId: order.id,
        fulfilmentId: fulfilment.id,
        itemsSubtotalAgorot: fulfilment.itemsSubtotalAgorot,
        shippingTierCode: fulfilment.shippingTierCode,
      },
    })),
  ];
}

/**
 * One artist has posted their parcel.
 *
 * The buyer is told which parcel, not which artist. On a two-artist order the
 * distinction is the whole of `checkout-orders`' anonymity rule: "one item
 * shipped and one still awaiting dispatch" is a statement about parcels.
 */
export function fulfilmentShippedNotifications(input: {
  readonly order: Order;
  readonly fulfilment: Fulfilment;
  readonly carrierName?: string | null;
  readonly trackingReference?: string | null;
}): NotificationRequest[] {
  return [
    {
      audience: "buyer",
      template: ORDER_TEMPLATES.fulfilmentShipped,
      recipientId: input.order.buyerId,
      data: {
        orderId: input.order.id,
        fulfilmentId: input.fulfilment.id,
        carrierName: input.carrierName ?? null,
        trackingReference: input.trackingReference ?? null,
      },
    },
  ];
}

/**
 * The order has arrived.
 *
 * Sent to the buyer and to each artist: the artist's payout clock starts at
 * `delivered` (`artist-payouts`), so "it arrived" is the notice that the money
 * is now on its way to them, and they should not have to poll a dashboard to
 * learn it.
 */
export function orderDeliveredNotifications(input: {
  readonly order: Order;
  readonly fulfilments: readonly Fulfilment[];
}): NotificationRequest[] {
  return [
    {
      audience: "buyer",
      template: ORDER_TEMPLATES.orderDelivered,
      recipientId: input.order.buyerId,
      data: { orderId: input.order.id },
    },
    ...input.fulfilments.map((fulfilment) => ({
      audience: "artist" as const,
      template: ORDER_TEMPLATES.orderDelivered,
      recipientId: fulfilment.artistId,
      data: { orderId: input.order.id, fulfilmentId: fulfilment.id },
    })),
  ];
}

/**
 * The order was cancelled and the pieces are back on the market.
 *
 * The artist is told as well as the buyer. An artist who saw "sold" on their
 * dashboard and then saw the piece listed again, with no message in between,
 * would reasonably conclude the platform had lost their sale.
 */
export function orderCancelledNotifications(input: {
  readonly order: Order;
  readonly fulfilments: readonly Fulfilment[];
  readonly reason?: string | null;
}): NotificationRequest[] {
  return [
    {
      audience: "buyer",
      template: ORDER_TEMPLATES.orderCancelled,
      recipientId: input.order.buyerId,
      data: { orderId: input.order.id, reason: input.reason ?? null },
    },
    ...input.fulfilments.map((fulfilment) => ({
      audience: "artist" as const,
      template: ORDER_TEMPLATES.orderCancelled,
      recipientId: fulfilment.artistId,
      data: { orderId: input.order.id, fulfilmentId: fulfilment.id },
    })),
  ];
}
