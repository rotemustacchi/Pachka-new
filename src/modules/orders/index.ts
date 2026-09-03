/**
 * `orders` — the cart, the reservation, the money, and the state machine that
 * carries a sale from placement to delivery.
 *
 * This file is the module's entire surface. ARCHITECTURE.md: nothing outside a
 * module may import a deeper path than its `index.ts`.
 *
 * THE ONE BUG THIS MODULE EXISTS TO PREVENT
 * -----------------------------------------
 * A one-of-a-kind painting sold twice is unrecoverable: there is no second copy,
 * and two people have paid for one object. That is why this project runs on
 * Postgres rather than Firebase, and it is why `reservations.ts` reads the way
 * it does. Reservation is `SELECT ... FOR UPDATE` on the artwork row inside a
 * transaction, through `shared/db`'s `withTransaction` — never through
 * supabase-js, where PostgREST's request-per-transaction would release the lock
 * immediately and buy nothing (SECURITY.md S0-4).
 *
 * FOR THE MODULES THAT DEPEND ON THIS ONE
 * ---------------------------------------
 * `payouts` — an order carries `commissionRateBp`, snapshotted from `app_config`
 * at placement (SECURITY.md S0-5 item 3), and a fulfilment carries
 * `itemsSubtotalAgorot` and `shippingAgorot` separately, because
 * `artist-payouts` excludes shipping from commission. Eligibility hangs off
 * `delivered`, which the state machine here refuses to let an artist stamp
 * (SPEC-D, S1-10). Read fulfilments through `listArtistFulfilments` or by
 * joining on your own tables; do not write ours.
 *
 * `certificates` — a certificate is issued against a paid fulfilment. What you
 * need is `Fulfilment` (artist, order, status) and `OrderItem` (artwork,
 * quantity, price). What you must not put on a public certificate page is
 * anything from `DeliveryDetails`: SECURITY.md S0-6 and SPEC-B are that the
 * public verification page must not disclose the buyer. This module will never
 * hand you the buyer's address for a fulfilment you do not own, which is the
 * structural half of that.
 *
 * `shipping` — mutually visible with this module by design. You return
 * `orderTransition` and `restoreInventory` as VALUES; `payments.ts` performs
 * them. Nothing in shipping moves an order, and nothing in shipping touches
 * `reservations`.
 *
 * `artworks` — `sqlInventoryDemand` below is the `InventoryDemandSource` you
 * declared and have been running without. Wire it through `artworksDepsFor` and
 * `assertDemandSourceIsWired` stops throwing.
 *
 * `app/` — routes parse input, call one of these functions, and render. Every
 * function that has something to tell somebody returns
 * `NotificationRequest[]`; the route dispatches them AFTER the call returns, so
 * nobody is emailed about a transaction that rolled back.
 */

// ---- The domain types and the seven states.
export {
  ACTOR_KINDS,
  ORDER_STATUSES,
  PAYMENT_STATUSES,
  RELEASE_REASONS,
  toDeliveryDetails,
  toFulfilment,
  toOrder,
  toOrderItem,
  toPaymentRecord,
  toReservation,
  toTransitionRecord,
  DELIVERY_COLUMNS,
  FULFILMENT_COLUMNS,
  ORDER_COLUMNS,
  ORDER_ITEM_COLUMNS,
  PAYMENT_COLUMNS,
  RESERVATION_COLUMNS,
  TRANSITION_COLUMNS,
  type ActorKind,
  type DeliveryDetails,
  type DeliveryDetailsRow,
  type Fulfilment,
  type FulfilmentRow,
  type FulfilmentStatus,
  type Order,
  type OrderItem,
  type OrderItemRow,
  type OrderRow,
  type OrderStatus,
  type OrderTransitionRecord,
  type OrderTransitionRow,
  type PaymentRecord,
  type PaymentRow,
  type PaymentStatus,
  type ReleaseReason,
  type Reservation,
  type ReservationRow,
} from "./types";

// ---- The state machine. Pure; no database.
export {
  actorsFor,
  aggregateStatus,
  assertTransition,
  canTransition,
  isPermittedEdge,
  isTerminal,
  permittedTransitions,
  progressRank,
  type TransitionAttempt,
} from "./state-machine";

// ---- THE function that changes an order's status. ARCHITECTURE.md: there is
// exactly one, and this is it.
export {
  orderHistory,
  transition,
  transitionFulfilment,
  type FulfilmentTransitionRequest,
  type FulfilmentTransitionResult,
  type TransitionRequest,
  type TransitionResult,
} from "./transition";

// ---- What this module is handed.
export {
  artworksDepsFor,
  maxActiveReservationsFor,
  packedDepthMmFor,
  DEFAULT_FLAT_ARTWORK_PACKED_DEPTH_MM,
  DEFAULT_MAX_ACTIVE_RESERVATIONS_PER_BUYER,
  type OrdersDeps,
} from "./deps";

// ---- The port `artworks` declared. Inject this; `noDemand` is a placeholder
// that reports zero reservations for everything and sells paintings twice.
export { sqlInventoryDemand } from "./demand";

// ---- Reservation. The lock, the ledger, the sweep.
export {
  activeReservationCount,
  artworkIdsForOrder,
  assertDemandWired,
  assertReservationCapacity,
  confirmReservationsForOrder,
  holdUnits,
  releaseExpiredHolds,
  releaseReservationsForOrder,
  reservationExpiryFrom,
  sweepExpiredReservations,
  type HoldRequest,
  type SweepResult,
} from "./reservations";

// ---- The cart. Revalidated on every view; reserves nothing.
export {
  checkoutableLines,
  revalidateCart,
  type CartLine,
  type CartLineInput,
  type CartView,
} from "./cart";

// ---- Checkout. One transaction, prices read under the lock.
export {
  beginCheckout,
  validateDelivery,
  type CheckoutLine,
  type CheckoutRequest,
  type CheckoutResult,
  type DeliveryInput,
} from "./checkout";

// ---- Payment: the interface, the one adapter, and what happens after.
export type {
  AuthorizeRequest,
  PaymentOutcome,
  PaymentProvider,
} from "./payment-provider";
export {
  createManualPaymentProvider,
  MANUAL_PAYMENT_INSTRUCTIONS,
  MANUAL_PROVIDER_NAME,
  type ManualPaymentProviderOptions,
} from "./manual-payment";
export {
  cancelOrder,
  confirmDelivery,
  markPaymentReceived,
  shipFulfilment,
  type CancelOrderInput,
  type CancelOrderResult,
  type ConfirmDeliveryInput,
  type MarkPaymentReceivedInput,
  type MarkPaymentReceivedResult,
  type ShipFulfilmentResult,
} from "./payments";

// ---- Visibility, both directions. `checkout-orders` and SECURITY.md S1-18.
export {
  artistFulfilment,
  buyerOrder,
  listArtistFulfilments,
  listBuyerOrders,
  type ArtistFulfilmentView,
  type BuyerOrderView,
  type BuyerParcel,
} from "./views";

// ---- What needs telling. Returned, never sent from inside a transaction.
export {
  fulfilmentShippedNotifications,
  orderCancelledNotifications,
  orderDeliveredNotifications,
  orderPlacedNotifications,
  paymentReceivedNotifications,
  ORDER_TEMPLATES,
  type NotificationAudience,
  type NotificationRequest,
  type OrderTemplate,
} from "./notifications";

// ---- Configuration this module reads.
export { commissionRateBp, reservationTtlMinutes } from "./config";
