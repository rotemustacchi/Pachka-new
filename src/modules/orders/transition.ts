/**
 * `orders.transition()` — the one function that changes an order's state.
 *
 * ARCHITECTURE.md, non-negotiable: "Order state changes go through one
 * function. `orders.transition()` validates the edge against the state machine
 * and writes `order_transitions`. No module and no route sets an order status
 * directly."
 *
 * That is a rule about the whole codebase, and it is why `shipping` — which
 * knows perfectly well when a parcel has been posted — returns an
 * `orderTransition` value instead of an update statement, and says so in its
 * own header: "every function that implies a state change returns the transition
 * for `orders.transition()` to perform. ARCHITECTURE.md gives order state to one
 * function, and this is not it."
 *
 * WHY THE UPDATE AND THE HISTORY ROW SHARE A TRANSACTION
 * -----------------------------------------------------
 * `checkout-orders` requires that every transition be recorded with actor and
 * timestamp. A status that moved without a history row, or a history row for a
 * move that then failed, are both worse than useless: the first loses the audit,
 * the second falsifies it. So both statements run on one handle, and a caller
 * that already has a transaction passes it in — which is what lets a cancellation
 * release inventory, move the order, and record the move atomically.
 *
 * WHY THE ROW IS LOCKED FIRST
 * ---------------------------
 * `select ... for update` on the order before reading its status. Two operators
 * clicking "mark paid" at the same moment would otherwise both read
 * `awaiting_payment`, both validate the edge, and both write — producing two
 * `awaiting_payment -> paid` rows for one payment, and, worse, running the
 * reservation-confirming side effects twice. The lock makes the second one see
 * `paid` and be refused by the state machine.
 */
import { AppError } from "@/shared/errors";
import type { Database, Tx } from "@/shared/db";
import { aggregateStatus, assertTransition, isPermittedEdge, permittedTransitions } from "./state-machine";
import {
  FULFILMENT_COLUMNS,
  ORDER_COLUMNS,
  TRANSITION_COLUMNS,
  toFulfilment,
  toOrder,
  toTransitionRecord,
  type ActorKind,
  type Fulfilment,
  type FulfilmentRow,
  type Order,
  type OrderRow,
  type OrderStatus,
  type OrderTransitionRecord,
  type OrderTransitionRow,
} from "./types";

export interface TransitionRequest {
  readonly orderId: string;
  readonly to: OrderStatus;
  /**
   * The account performing the move, or `null` for `system`. Recorded on the
   * history row; `checkout-orders` requires "the acting account".
   */
  readonly actorId: string | null;
  readonly actorKind: ActorKind;
  /** Free text for the operator's benefit. Never shown to a buyer as-is. */
  readonly reason?: string;
}

export interface TransitionResult {
  readonly order: Order;
  readonly record: OrderTransitionRecord;
}

function assertActorIdentified(request: { actorId: string | null; actorKind: ActorKind }): void {
  // A person's move records the person. `system` is the only actor kind with no
  // account behind it — the sweep and the aggregate recompute — and letting a
  // human move be recorded as `system` would be the easiest way to lose the
  // audit trail `checkout-orders` asks for.
  if (request.actorKind !== "system" && request.actorId === null) {
    throw AppError.validation(
      `A ${request.actorKind} transition must record the acting account.`,
      { code: "orders.actor_required", details: { actorKind: request.actorKind } },
    );
  }
  if (request.actorKind === "system" && request.actorId !== null) {
    throw AppError.validation("A system transition has no acting account.", {
      code: "orders.system_actor_has_no_account",
    });
  }
}

async function writeTransition(
  tx: Tx,
  input: {
    orderId: string;
    fulfilmentId: string | null;
    from: OrderStatus;
    to: OrderStatus;
    actorId: string | null;
    actorKind: ActorKind;
    reason: string | null;
  },
): Promise<OrderTransitionRecord> {
  const row = await tx.one<OrderTransitionRow>(
    `insert into order_transitions
       (order_id, fulfilment_id, from_status, to_status, actor_id, actor_kind, reason)
     values ($1, $2, $3, $4, $5, $6, $7)
     returning ${TRANSITION_COLUMNS}`,
    [
      input.orderId,
      input.fulfilmentId,
      input.from,
      input.to,
      input.actorId,
      input.actorKind,
      input.reason,
    ],
  );
  return toTransitionRecord(row);
}

/**
 * Move an order, validating the edge and recording it.
 *
 * Pass `tx` when the move is part of larger work — a cancellation that also
 * releases inventory, a payment that also confirms reservations. Omit it and
 * one is opened, which is the right shape for an operator action that is only
 * the move.
 */
export async function transition(
  db: Database,
  request: TransitionRequest,
  tx?: Tx,
): Promise<TransitionResult> {
  assertActorIdentified(request);

  const run = (handle: Tx): Promise<TransitionResult> => moveOrder(handle, request, true);
  return tx ? run(tx) : db.withTransaction(run);
}

/**
 * The move itself, shared by the authorised path and the derived one.
 *
 * `checkActor` is the only difference between them, and it is a real
 * distinction rather than a flag to skip validation:
 *
 *   • `transition()` is somebody DOING something, so both halves are checked —
 *     is this edge in the machine, and may this actor take it?
 *   • `syncOrderToFulfilments` is arithmetic over moves that were ALREADY
 *     authorised at the fulfilment level. Re-asking "may a system move an order
 *     from paid to shipped" is asking the wrong question about a move nobody
 *     performed: the artist performed it, on their fulfilment, and was checked
 *     there. Refusing here would have made the second artist's dispatch fail
 *     because the order had caught up with it.
 *
 * The EDGE is still validated on both paths. A derived move that the state
 * machine does not contain is a bug in the aggregate rule, not a permission
 * question, and it never writes a row.
 */
async function moveOrder(
  handle: Tx,
  request: TransitionRequest,
  checkActor: boolean,
): Promise<TransitionResult> {
  const current = await handle.maybeOne<OrderRow>(
    `select ${ORDER_COLUMNS} from orders where id = $1 for update`,
    [request.orderId],
  );
  if (current === null) {
    throw AppError.notFound("Order not found", {
      code: "orders.not_found",
      details: { orderId: request.orderId },
    });
  }

  const from = current.status as OrderStatus;

  // Throws before anything is written. `checkout-orders`, "Invalid transition
  // rejected": "the system rejects the transition and leaves the order
  // unchanged" — and nothing above this line has changed anything.
  if (checkActor) {
    assertTransition({ from, to: request.to, by: request.actorKind });
  } else if (!isPermittedEdge(from, request.to)) {
    throw AppError.conflict(
      `An order cannot move from "${from}" to "${request.to}". Permitted: ${
        permittedTransitions(from).join(", ") || "none"
      }.`,
      {
        code: "orders.invalid_transition",
        details: { from, to: request.to, permitted: permittedTransitions(from) },
      },
    );
  }

  const updated = await handle.one<OrderRow>(
    `update orders set status = $2 where id = $1 returning ${ORDER_COLUMNS}`,
    [request.orderId, request.to],
  );

  const record = await writeTransition(handle, {
    orderId: request.orderId,
    fulfilmentId: null,
    from,
    to: request.to,
    actorId: request.actorId,
    actorKind: request.actorKind,
    reason: request.reason ?? null,
  });

  return { order: toOrder(updated), record };
}

export interface FulfilmentTransitionRequest {
  readonly fulfilmentId: string;
  readonly to: OrderStatus;
  readonly actorId: string | null;
  readonly actorKind: ActorKind;
  readonly reason?: string;
}

export interface FulfilmentTransitionResult {
  readonly fulfilment: Fulfilment;
  readonly record: OrderTransitionRecord;
  /**
   * The order-level move this one implied, if any.
   *
   * `checkout-orders`: "WHEN one artist marks their fulfilment shipped and the
   * other has not THEN the buyer's order shows one item shipped and one still
   * awaiting dispatch." So the order follows the LEAST advanced fulfilment, and
   * the first artist to ship moves nothing at the order level. See
   * `aggregateStatus`.
   */
  readonly orderTransition: TransitionResult | null;
}

/**
 * Move one artist's fulfilment, then bring the order into line.
 *
 * The order-level move goes through `transition()` above rather than being
 * written here, so there is still exactly one function that changes an order's
 * status — including when the thing that caused the change was a fulfilment.
 * It is recorded as `system`, because no person decided it: it is arithmetic
 * over the fulfilments, and the person who moved the fulfilment is recorded on
 * that row.
 */
export async function transitionFulfilment(
  db: Database,
  request: FulfilmentTransitionRequest,
  tx?: Tx,
): Promise<FulfilmentTransitionResult> {
  assertActorIdentified(request);

  const run = async (handle: Tx): Promise<FulfilmentTransitionResult> => {
    const current = await handle.maybeOne<FulfilmentRow>(
      `select ${FULFILMENT_COLUMNS} from fulfilments where id = $1 for update`,
      [request.fulfilmentId],
    );
    if (current === null) {
      throw AppError.notFound("Fulfilment not found", {
        code: "orders.fulfilment_not_found",
        details: { fulfilmentId: request.fulfilmentId },
      });
    }

    const from = current.status as OrderStatus;
    assertTransition({ from, to: request.to, by: request.actorKind });

    // The timestamps `shipping` and `payouts` read. Stamped here rather than by
    // a trigger so that the moment recorded is the moment the state machine
    // accepted the move, not the moment some later UPDATE happened to touch the
    // row.
    const updated = await handle.one<FulfilmentRow>(
      `update fulfilments
          set status = $2,
              shipped_at   = case when $2 = 'shipped'   and shipped_at   is null then now() else shipped_at   end,
              delivered_at = case when $2 = 'delivered' and delivered_at is null then now() else delivered_at end
        where id = $1
        returning ${FULFILMENT_COLUMNS}`,
      [request.fulfilmentId, request.to],
    );

    const record = await writeTransition(handle, {
      orderId: current.order_id,
      fulfilmentId: request.fulfilmentId,
      from,
      to: request.to,
      actorId: request.actorId,
      actorKind: request.actorKind,
      reason: request.reason ?? null,
    });

    const orderTransition = await syncOrderToFulfilments(handle, current.order_id);

    return { fulfilment: toFulfilment(updated), record, orderTransition };
  };

  return tx ? run(tx) : db.withTransaction(run);
}

/**
 * Bring an order's status into line with its fulfilments.
 *
 * Returns `null` when nothing needs to move — which is the common case, and is
 * what makes "one shipped, one not" render correctly rather than dragging the
 * whole order forward on the first artist's dispatch.
 *
 * A computed target that the state machine refuses is silently left alone
 * rather than throwing. The fulfilments can legitimately imply a state the order
 * cannot legally reach from where it is — a returned fulfilment on an order that
 * has already moved on, say — and in that case the fulfilment's own history is
 * the record and the order stays put. Throwing here would make one artist's
 * ordinary action fail because of something the other artist did.
 */
async function syncOrderToFulfilments(
  handle: Tx,
  orderId: string,
): Promise<TransitionResult | null> {
  const { rows } = await handle.query<{ status: string }>(
    "select status from fulfilments where order_id = $1",
    [orderId],
  );

  const target = aggregateStatus(rows.map((row) => row.status as OrderStatus));
  if (target === null) return null;

  const order = await handle.one<OrderRow>(
    `select ${ORDER_COLUMNS} from orders where id = $1 for update`,
    [orderId],
  );
  if (order.status === target) return null;

  try {
    return await moveOrder(
      handle,
      { orderId, to: target, actorId: null, actorKind: "system", reason: "fulfilments" },
      false,
    );
  } catch (error) {
    if (error instanceof AppError && error.kind === "conflict") return null;
    throw error;
  }
}

/** The order's history, oldest first. `checkout-orders`, "Transition history recorded". */
export async function orderHistory(
  db: Database,
  orderId: string,
): Promise<readonly OrderTransitionRecord[]> {
  const { rows } = await db.query<OrderTransitionRow>(
    `select ${TRANSITION_COLUMNS} from order_transitions
      where order_id = $1 order by occurred_at asc, id asc`,
    [orderId],
  );
  return rows.map(toTransitionRecord);
}
