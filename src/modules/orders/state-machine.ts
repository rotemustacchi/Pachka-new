/**
 * The order state machine, as arithmetic. No database, no I/O.
 *
 * ARCHITECTURE.md: "Order state changes go through one function.
 * `orders.transition()` validates the edge against the state machine and writes
 * `order_transitions`. No module and no route sets an order status directly."
 * This file is the state machine; `transition.ts` is the function. They are
 * separate so the edges can be tested exhaustively without a database, and so
 * that reading the rules does not mean reading SQL.
 *
 * WHO MAY PERFORM AN EDGE
 * -----------------------
 * `checkout-orders` lists the edges and is silent about the actor for all of
 * them. SECURITY.md calls that out as SPEC-D: "No actor is assigned to
 * `shipped -> delivered`, and the payout clock hangs off it... If the artist may
 * perform it, the artist controls their own payout eligibility, and the tracking
 * reference that would contradict them is never validated against a carrier."
 * S1-10 is the same finding at severity high: "Artist can open their own payout
 * window."
 *
 * So the actor table below is stricter than the spec, in exactly the direction
 * SECURITY.md's proposed change points, and no looser anywhere. The one edge
 * that matters is `shipped -> delivered`, which an artist cannot perform. This
 * is a deliberate divergence from a spec that is silent rather than permissive,
 * and it is reported to the lead architect rather than assumed to be agreed.
 */
import { AppError } from "@/shared/errors";
import { ORDER_STATUSES, type ActorKind, type OrderStatus } from "./types";

/**
 * The permitted edges, verbatim from `checkout-orders`, "Order state machine":
 *
 *   awaiting_payment -> paid | cancelled
 *   paid             -> shipped | cancelled
 *   shipped          -> delivered
 *   delivered        -> return_requested
 *   return_requested -> returned | delivered
 *
 * `returned` and `cancelled` are terminal: nothing leaves them. That is not
 * stated in the spec as a sentence, it is stated by their absence from the left
 * column, and the absence is the rule.
 */
const EDGES: Readonly<Record<OrderStatus, readonly OrderStatus[]>> = {
  awaiting_payment: ["paid", "cancelled"],
  paid: ["shipped", "cancelled"],
  shipped: ["delivered"],
  delivered: ["return_requested"],
  return_requested: ["returned", "delivered"],
  returned: [],
  cancelled: [],
};

/**
 * Who may perform each edge. See the file header for why this is stricter than
 * the spec on one edge and equal to it everywhere else.
 *
 * `system` appears on the edges a scheduled job or an internal recompute
 * performs: the expiry sweep cancels, and the fulfilment aggregate moves the
 * parent order once every artist's half has moved. It is never a stand-in for
 * "we could not work out who did this" -- an edge a person performs always
 * records that person.
 */
const ACTORS: Readonly<Record<OrderStatus, Readonly<Partial<Record<OrderStatus, readonly ActorKind[]>>>>> = {
  awaiting_payment: {
    // The manual adapter's operator action. `system` is here for the real
    // provider that will one day confirm settlement from a webhook.
    paid: ["admin", "system"],
    // The buyer abandons, the operator cancels, or the sweep gives up on a
    // payment that never arrived.
    cancelled: ["buyer", "admin", "system"],
  },
  paid: {
    // The artist ships their own work; an operator can record it for them when
    // an artist reports a shipment they could not enter.
    shipped: ["artist", "admin"],
    // A paid order can still be cancelled -- stock lost, artist unable to
    // supply. Not by the artist alone: that would let an artist cancel a sale
    // they simply changed their mind about, after the buyer's money moved.
    cancelled: ["buyer", "admin"],
  },
  shipped: {
    // NOT `artist`. SECURITY.md SPEC-D and S1-10: `delivered` starts the payout
    // clock, so an artist who can stamp it can pay themselves for a parcel that
    // never arrived. `system` covers the configured auto-delivery interval
    // SPEC-D proposes; it is not wired to a scheduler in this change.
    delivered: ["buyer", "admin", "system"],
  },
  delivered: {
    // The buyer's fourteen-day cancellation right (`shipping-and-returns`).
    // Admin included so an operator can open a case a buyer reported by phone.
    return_requested: ["buyer", "admin"],
  },
  return_requested: {
    // Both outcomes are the operator's or the sweep's. Not the artist's:
    // SECURITY.md SPEC-E is that the artist must not unilaterally control the
    // buyer's refund. Not the buyer's either -- declaring your own return
    // received is declaring your own refund.
    returned: ["admin", "system"],
    delivered: ["admin", "system"],
  },
  returned: {},
  cancelled: {},
};

export interface TransitionAttempt {
  readonly from: OrderStatus;
  readonly to: OrderStatus;
  readonly by: ActorKind;
}

/** Every state reachable from `from`, in no particular order. */
export function permittedTransitions(from: OrderStatus): readonly OrderStatus[] {
  return EDGES[from];
}

/** Is this edge in the state machine at all, ignoring who is asking? */
export function isPermittedEdge(from: OrderStatus, to: OrderStatus): boolean {
  return EDGES[from].includes(to);
}

/** Is this edge permitted for this actor? */
export function canTransition(attempt: TransitionAttempt): boolean {
  if (!isPermittedEdge(attempt.from, attempt.to)) return false;
  return (ACTORS[attempt.from][attempt.to] ?? []).includes(attempt.by);
}

/** Which actor kinds may perform this edge. Empty for an edge that does not exist. */
export function actorsFor(from: OrderStatus, to: OrderStatus): readonly ActorKind[] {
  return ACTORS[from][to] ?? [];
}

/** A terminal state has no outgoing edge. `returned` and `cancelled`. */
export function isTerminal(status: OrderStatus): boolean {
  return EDGES[status].length === 0;
}

/**
 * Throw unless the edge is permitted for this actor.
 *
 * `conflict`, not `validation`. The request is well-formed; it is the order's
 * current state that refuses it, which is exactly the distinction
 * `shared/errors` draws -- and it is what makes the route return 409 rather
 * than 400 for "someone else already cancelled this".
 *
 * A same-state move (`paid -> paid`) is rejected too. It is not harmless: it
 * would write a transition row claiming a change that did not happen, and
 * `checkout-orders` requires the history to record the previous state and the
 * new state, which are the same value in that row and therefore record nothing.
 */
export function assertTransition(attempt: TransitionAttempt): void {
  const { from, to, by } = attempt;

  if (!ORDER_STATUSES.includes(to)) {
    throw AppError.validation(`"${String(to)}" is not an order status`, {
      code: "orders.unknown_status",
      details: { status: to },
    });
  }

  if (!isPermittedEdge(from, to)) {
    throw AppError.conflict(
      isTerminal(from)
        ? `An order that is "${from}" is final and cannot move to "${to}".`
        : `An order cannot move from "${from}" to "${to}". Permitted: ${
            permittedTransitions(from).join(", ") || "none"
          }.`,
      {
        code: "orders.invalid_transition",
        details: { from, to, permitted: permittedTransitions(from) },
      },
    );
  }

  if (!canTransition(attempt)) {
    // `forbidden`, not `conflict`: the edge exists and the order is in the
    // right state for it. What is wrong is who is asking.
    throw AppError.forbidden(
      `A ${by} may not move an order from "${from}" to "${to}".`,
      {
        code: "orders.transition_not_permitted_for_actor",
        details: { from, to, by, permittedActors: actorsFor(from, to) },
      },
    );
  }
}

/**
 * How far along an order is, for aggregating a multi-artist order from its
 * fulfilments.
 *
 * `checkout-orders`: "the buyer sees one order" while each fulfilment ships
 * independently, and an order with one half shipped "shows one item shipped and
 * one still awaiting dispatch". So the order's own status is the LEAST advanced
 * of its live fulfilments -- an order is not shipped until everything in it has
 * shipped. Ranking only covers the linear part of the machine; the return and
 * cancellation branches are per-fulfilment decisions that `transition.ts`
 * handles explicitly rather than by comparing numbers.
 */
const PROGRESS: Readonly<Partial<Record<OrderStatus, number>>> = {
  awaiting_payment: 0,
  paid: 1,
  shipped: 2,
  delivered: 3,
};

/** The linear progress rank, or `null` for a status outside the linear run. */
export function progressRank(status: OrderStatus): number | null {
  return PROGRESS[status] ?? null;
}

/**
 * The order status implied by its fulfilments, or `null` when the fulfilments
 * are in states this rule does not speak for.
 *
 * Cancelled fulfilments are excluded from the minimum rather than dragging the
 * order backwards: on a two-artist order where one artist cannot supply, the
 * buyer's order should follow the half that is still coming. An order whose
 * fulfilments are ALL cancelled is cancelled.
 */
export function aggregateStatus(
  fulfilmentStatuses: readonly OrderStatus[],
): OrderStatus | null {
  if (fulfilmentStatuses.length === 0) return null;

  const live = fulfilmentStatuses.filter((status) => status !== "cancelled");
  if (live.length === 0) return "cancelled";

  const ranks = live.map(progressRank);
  // Any fulfilment off the linear run (a return in progress) means the order's
  // status is not a function of the ranks, and the caller decides instead.
  if (ranks.some((rank) => rank === null)) return null;

  const lowest = Math.min(...(ranks as number[]));
  const found = (Object.keys(PROGRESS) as OrderStatus[]).find(
    (status) => PROGRESS[status] === lowest,
  );
  return found ?? null;
}
