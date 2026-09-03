/**
 * What happens to an order after it is placed: payment, dispatch, delivery,
 * cancellation.
 *
 * Every function here follows the same shape, and the shape is the point:
 *
 *   lock the artwork rows -> change the reservation ledger -> move the order
 *   through `transition()` -> reconcile derived availability -> return the
 *   notifications for the caller to send after the commit.
 *
 * Nothing writes an order status directly (ARCHITECTURE.md), nothing sends mail
 * from inside a transaction, and nothing touches inventory without holding the
 * lock that inventory decisions are made under.
 */
import { AppError } from "@/shared/errors";
import type { Tx } from "@/shared/db";
import {
  lockArtworkForUpdate,
  reconcileAvailability,
} from "@/modules/artworks";
import { markShipped, recordDispatchObligation, type MarkShippedInput } from "@/modules/shipping";
import { artworksDepsFor, type OrdersDeps } from "./deps";
import {
  fulfilmentShippedNotifications,
  orderCancelledNotifications,
  orderDeliveredNotifications,
  paymentReceivedNotifications,
  type NotificationRequest,
} from "./notifications";
import {
  artworkIdsForOrder,
  confirmReservationsForOrder,
  releaseReservationsForOrder,
} from "./reservations";
import { transition, transitionFulfilment } from "./transition";
import {
  FULFILMENT_COLUMNS,
  ORDER_COLUMNS,
  PAYMENT_COLUMNS,
  toFulfilment,
  toOrder,
  toPaymentRecord,
  type ActorKind,
  type Fulfilment,
  type FulfilmentRow,
  type Order,
  type OrderRow,
  type PaymentRecord,
  type PaymentRow,
  type Reservation,
} from "./types";

/**
 * Take every artwork lock this order touches, in a fixed order.
 *
 * Same sorted-id discipline as `checkout.ts`, and for the same reason: a
 * cancellation and a checkout that overlap on two artworks would otherwise be
 * able to deadlock. `artworkIdsForOrder` already returns them sorted.
 *
 * Locking through `artworks.lockArtworkForUpdate` rather than a local
 * `select ... for update` keeps every caller in the codebase taking the same
 * lock on the same row — which is what makes the lock mean anything.
 */
async function lockOrderArtworks(tx: Tx, orderId: string): Promise<string[]> {
  const artworkIds = await artworkIdsForOrder(tx, orderId);
  for (const artworkId of artworkIds) {
    await lockArtworkForUpdate(tx, artworkId);
  }
  return artworkIds;
}

async function readOrder(tx: Tx, orderId: string): Promise<Order> {
  const row = await tx.maybeOne<OrderRow>(
    `select ${ORDER_COLUMNS} from orders where id = $1`,
    [orderId],
  );
  if (row === null) {
    throw AppError.notFound("Order not found", {
      code: "orders.not_found",
      details: { orderId },
    });
  }
  return toOrder(row);
}

async function readFulfilments(tx: Tx, orderId: string): Promise<Fulfilment[]> {
  const { rows } = await tx.query<FulfilmentRow>(
    `select ${FULFILMENT_COLUMNS} from fulfilments where order_id = $1 order by artist_id`,
    [orderId],
  );
  return rows.map(toFulfilment);
}

async function readPayment(tx: Tx, orderId: string): Promise<PaymentRecord> {
  const row = await tx.maybeOne<PaymentRow>(
    `select ${PAYMENT_COLUMNS} from payments where order_id = $1`,
    [orderId],
  );
  if (row === null) {
    throw AppError.notFound("No payment has been started for this order.", {
      code: "orders.payment_not_found",
      details: { orderId },
    });
  }
  return toPaymentRecord(row);
}

// ---------------------------------------------------------------------------
// The operator action
// ---------------------------------------------------------------------------

export interface MarkPaymentReceivedInput {
  readonly orderId: string;
  /** The operator. Recorded on the payment row and on the transition. */
  readonly operatorId: string;
}

export interface MarkPaymentReceivedResult {
  readonly order: Order;
  readonly fulfilments: readonly Fulfilment[];
  readonly payment: PaymentRecord;
  readonly reservations: readonly Reservation[];
  readonly notifications: readonly NotificationRequest[];
}

/**
 * `checkout-orders`, *Operator confirms payment received*:
 *
 *   WHEN an operator marks an awaiting-payment order as paid
 *   THEN the order moves to `paid`, the reservation converts to a sale, and the
 *        artist is notified to dispatch
 *
 * All three, in one transaction, under the artwork locks. The conversion is
 * where the sweep race lives (SECURITY.md S0-4), so the locks come first and
 * `confirmReservationsForOrder` re-checks expiry underneath them and fails
 * closed. An operator who confirms a payment for an order whose hold lapsed
 * gets a conflict and a refund conversation — not a second buyer's painting.
 */
export async function markPaymentReceived(
  deps: OrdersDeps,
  input: MarkPaymentReceivedInput,
): Promise<MarkPaymentReceivedResult> {
  const outcome = await deps.db.withTransaction(async (tx) => {
    const artworkIds = await lockOrderArtworks(tx, input.orderId);
    const order = await readOrder(tx, input.orderId);
    const payment = await readPayment(tx, input.orderId);

    if (order.status !== "awaiting_payment") {
      // Caught here as well as by the state machine so the message names the
      // actual problem. Confirming payment twice is an operator double-click,
      // not an attack, and deserves a sentence rather than a transition error.
      throw AppError.conflict(
        `This order is already "${order.status}"; payment cannot be confirmed again.`,
        { code: "orders.not_awaiting_payment", details: { orderId: order.id, status: order.status } },
      );
    }

    // Fails closed if any hold lapsed while the confirmation was in flight.
    const reservations = await confirmReservationsForOrder(tx, order.id);

    // The provider. For the manual adapter this records that the operator saw
    // the transfer; for a real one it captures the authorisation.
    const captured = await deps.payments.capture(payment.providerReference, order.totalAgorot);

    const paymentRow = await tx.one<PaymentRow>(
      `update payments
          set status = $2,
              settled_by = $3,
              captured_at = case when $2 = 'captured' then coalesce(captured_at, now()) else captured_at end
        where order_id = $1
        returning ${PAYMENT_COLUMNS}`,
      [order.id, captured.status, input.operatorId],
    );

    // The order first, so the operator is recorded as the actor on the move the
    // spec attributes to them. The fulfilment moves below then find the order
    // already where they would have put it, and their aggregate recompute is a
    // no-op — see `syncOrderToFulfilments`.
    const moved = await transition(
      deps.db,
      { orderId: order.id, to: "paid", actorId: input.operatorId, actorKind: "admin" },
      tx,
    );

    const fulfilments: Fulfilment[] = [];
    for (const fulfilment of await readFulfilments(tx, order.id)) {
      const result = await transitionFulfilment(
        deps.db,
        {
          fulfilmentId: fulfilment.id,
          to: "paid",
          actorId: input.operatorId,
          actorKind: "admin",
        },
        tx,
      );
      fulfilments.push(result.fulfilment);

      // `shipping` owns the artist's dispatch deadline and opens it on payment.
      // Called on `tx`, so an obligation cannot exist for a payment that then
      // rolled back. Idempotent on `fulfilment_id`, so a retried confirmation
      // does not reset a deadline.
      await recordDispatchObligation(tx, {
        fulfilmentId: fulfilment.id,
        orderId: order.id,
        artistId: fulfilment.artistId,
        ...(await dispatchShapeFor(tx, fulfilment.id)),
        paidAt: new Date(),
      });
    }

    // Reserved units became sold units. The totals are unchanged, so no artwork
    // changes status here — but the reconcile is what keeps that a fact rather
    // than an assumption, and it is cheap under locks already held.
    const artworksDeps = artworksDepsFor(deps, deps.db);
    for (const artworkId of artworkIds) {
      await reconcileAvailability(artworksDeps, artworkId, tx);
    }

    return {
      order: moved.order,
      fulfilments,
      payment: toPaymentRecord(paymentRow),
      reservations,
    };
  });

  return {
    ...outcome,
    notifications: paymentReceivedNotifications({
      order: outcome.order,
      fulfilments: outcome.fulfilments,
    }),
  };
}

/**
 * The lead time and medium `shipping` needs to set a dispatch deadline.
 *
 * Taken from the artwork with the LONGEST lead time in the fulfilment: one
 * artist's parcel goes when everything in it is ready, so the deadline is set by
 * the slowest piece. Snapshotted at payment, which is `shipping`'s own rule —
 * "so that an artist editing the listing afterwards cannot move their own
 * deadline."
 */
async function dispatchShapeFor(
  tx: Tx,
  fulfilmentId: string,
): Promise<{ leadTimeDays: number; medium: string | null }> {
  const row = await tx.maybeOne<{ lead_time_days: number | null; medium: string | null }>(
    `select a.lead_time_days, a.medium
       from order_items i
       join artworks a on a.id = i.artwork_id
      where i.fulfilment_id = $1
      order by coalesce(a.lead_time_days, 0) desc
      limit 1`,
    [fulfilmentId],
  );
  return { leadTimeDays: row?.lead_time_days ?? 0, medium: row?.medium ?? null };
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

export interface ShipFulfilmentResult {
  readonly fulfilment: Fulfilment;
  readonly order: Order;
  readonly notifications: readonly NotificationRequest[];
}

/**
 * An artist has posted their parcel.
 *
 * `shipping.markShipped` holds the evidence rule — a carrier, a tracking
 * reference, and a packaging confirmation where the medium requires one — and
 * returns `{ dispatch, notifications }` without moving anything, because
 * "shipping never moves an order". So this performs the `paid -> shipped`
 * transition on the fulfilment and lets the aggregate decide whether the whole
 * order has shipped: on a two-artist order the first artist's dispatch moves
 * their own fulfilment and leaves the order where it is, which is exactly what
 * `checkout-orders` asks the buyer's view to show.
 */
export async function shipFulfilment(
  deps: OrdersDeps,
  input: MarkShippedInput,
): Promise<ShipFulfilmentResult> {
  const outcome = await deps.db.withTransaction(async (tx) => {
    const dispatched = await markShipped(tx, input);

    const moved = await transitionFulfilment(
      deps.db,
      {
        fulfilmentId: input.fulfilmentId,
        to: "shipped",
        actorId: input.artistId,
        actorKind: "artist",
      },
      tx,
    );

    const order = await readOrder(tx, moved.fulfilment.orderId);
    return { fulfilment: moved.fulfilment, order, dispatch: dispatched.dispatch };
  });

  return {
    fulfilment: outcome.fulfilment,
    order: outcome.order,
    notifications: fulfilmentShippedNotifications({
      order: outcome.order,
      fulfilment: outcome.fulfilment,
      carrierName: outcome.dispatch.carrierName,
      trackingReference: outcome.dispatch.trackingReference,
    }),
  };
}

// ---------------------------------------------------------------------------
// Delivery
// ---------------------------------------------------------------------------

export interface ConfirmDeliveryInput {
  readonly fulfilmentId: string;
  readonly actorId: string | null;
  /**
   * Never `artist`. The state machine refuses it — SECURITY.md SPEC-D and
   * S1-10: `delivered` starts the payout clock, so an artist who could stamp it
   * could pay themselves for a parcel that never arrived.
   */
  readonly actorKind: ActorKind;
}

export async function confirmDelivery(
  deps: OrdersDeps,
  input: ConfirmDeliveryInput,
): Promise<ShipFulfilmentResult & { readonly fulfilments: readonly Fulfilment[] }> {
  const outcome = await deps.db.withTransaction(async (tx) => {
    const moved = await transitionFulfilment(
      deps.db,
      {
        fulfilmentId: input.fulfilmentId,
        to: "delivered",
        actorId: input.actorId,
        actorKind: input.actorKind,
      },
      tx,
    );

    const order = await readOrder(tx, moved.fulfilment.orderId);
    const fulfilments = await readFulfilments(tx, order.id);
    return { fulfilment: moved.fulfilment, order, fulfilments };
  });

  return {
    ...outcome,
    // Only when the whole order has arrived. Telling a buyer "your order was
    // delivered" while a second parcel is still in transit is worse than saying
    // nothing.
    notifications:
      outcome.order.status === "delivered"
        ? orderDeliveredNotifications({ order: outcome.order, fulfilments: outcome.fulfilments })
        : [],
  };
}

// ---------------------------------------------------------------------------
// Cancellation
// ---------------------------------------------------------------------------

export interface CancelOrderInput {
  readonly orderId: string;
  readonly actorId: string | null;
  readonly actorKind: ActorKind;
  readonly reason?: string;
}

export interface CancelOrderResult {
  readonly order: Order;
  readonly fulfilments: readonly Fulfilment[];
  readonly released: readonly Reservation[];
  readonly notifications: readonly NotificationRequest[];
}

/**
 * `checkout-orders`, *Cancellation restores inventory*:
 *
 *   WHEN an order in `awaiting_payment` or `paid` is cancelled
 *   THEN the reserved inventory is released and the artwork becomes purchasable
 *        again
 *
 * "Becomes purchasable again" is the half that is easy to miss. Releasing the
 * reservation changes derived availability, but an artwork whose last unit was
 * sold is sitting in `status = 'sold'`, and a piece nobody can buy is not
 * purchasable however the arithmetic comes out. `reconcileAvailability` is what
 * moves it back to `published` — under the same locks, in the same transaction,
 * so the two facts can never disagree.
 *
 * The order is cancelled before its fulfilments, so the operator or buyer is
 * recorded as the actor on the move that matters, and the fulfilment moves that
 * follow are theirs too.
 */
export async function cancelOrder(
  deps: OrdersDeps,
  input: CancelOrderInput,
): Promise<CancelOrderResult> {
  const outcome = await deps.db.withTransaction(async (tx) => {
    const artworkIds = await lockOrderArtworks(tx, input.orderId);

    const moved = await transition(
      deps.db,
      {
        orderId: input.orderId,
        to: "cancelled",
        actorId: input.actorId,
        actorKind: input.actorKind,
        ...(input.reason === undefined ? {} : { reason: input.reason }),
      },
      tx,
    );

    const fulfilments: Fulfilment[] = [];
    for (const fulfilment of await readFulfilments(tx, input.orderId)) {
      // A fulfilment already past the linear run — one artist shipped before
      // the order was cancelled — is left alone rather than forced backwards.
      // Its own history is the record, and the parcel is genuinely in transit.
      if (fulfilment.status === "cancelled" || fulfilment.status === "returned") {
        fulfilments.push(fulfilment);
        continue;
      }
      const result = await transitionFulfilment(
        deps.db,
        {
          fulfilmentId: fulfilment.id,
          to: "cancelled",
          actorId: input.actorId,
          actorKind: input.actorKind,
          ...(input.reason === undefined ? {} : { reason: input.reason }),
        },
        tx,
      );
      fulfilments.push(result.fulfilment);
    }

    // Held units AND confirmed ones. A cancelled paid order gives the piece
    // back; that is the whole point of the `paid -> cancelled` edge.
    const released = await releaseReservationsForOrder(tx, input.orderId, "cancelled");

    const artworksDeps = artworksDepsFor(deps, deps.db);
    for (const artworkId of artworkIds) {
      await reconcileAvailability(artworksDeps, artworkId, tx);
    }

    return { order: moved.order, fulfilments, released };
  });

  return {
    ...outcome,
    notifications: orderCancelledNotifications({
      order: outcome.order,
      fulfilments: outcome.fulfilments,
      reason: input.reason ?? null,
    }),
  };
}
