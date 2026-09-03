/**
 * The state machine as arithmetic.
 *
 * `checkout-orders` states the edges in one sentence, and a sentence is easy to
 * implement almost-correctly. So this file enumerates ALL 49 ordered pairs of
 * the seven statuses and asserts each one against the spec's list, rather than
 * spot-checking the interesting ones — which is how "delivered -> cancelled"
 * quietly becomes legal.
 *
 * No database. The row-level behaviour is `orders-lifecycle.test.ts`.
 */
import { describe, expect, it } from "vitest";
import { AppError } from "@/shared/errors";
import {
  actorsFor,
  aggregateStatus,
  assertTransition,
  canTransition,
  isPermittedEdge,
  isTerminal,
  permittedTransitions,
  progressRank,
} from "./state-machine";
import { ORDER_STATUSES, type OrderStatus } from "./types";

/**
 * The spec's own list, retyped rather than imported.
 *
 * Importing the module's table and asserting the module matches it would assert
 * nothing. This is `checkout-orders`, "Order state machine", transcribed:
 * "Permitted transitions SHALL be `awaiting_payment` -> `paid` or `cancelled`;
 * `paid` -> `shipped` or `cancelled`; `shipped` -> `delivered`; `delivered` ->
 * `return_requested`; `return_requested` -> `returned` or `delivered`."
 */
const SPEC_EDGES: ReadonlyArray<readonly [OrderStatus, OrderStatus]> = [
  ["awaiting_payment", "paid"],
  ["awaiting_payment", "cancelled"],
  ["paid", "shipped"],
  ["paid", "cancelled"],
  ["shipped", "delivered"],
  ["delivered", "return_requested"],
  ["return_requested", "returned"],
  ["return_requested", "delivered"],
];

function isSpecEdge(from: OrderStatus, to: OrderStatus): boolean {
  return SPEC_EDGES.some(([a, b]) => a === from && b === to);
}

describe("the edge table", () => {
  it("permits exactly the edges the spec lists, and no others", () => {
    const wrong: string[] = [];

    for (const from of ORDER_STATUSES) {
      for (const to of ORDER_STATUSES) {
        if (isPermittedEdge(from, to) !== isSpecEdge(from, to)) {
          wrong.push(`${from} -> ${to}`);
        }
      }
    }

    expect(wrong, `edges disagreeing with checkout-orders: ${wrong.join(", ")}`).toEqual([]);
  });

  it("covers all forty-nine pairs, so the test above is not vacuous", () => {
    expect(ORDER_STATUSES.length * ORDER_STATUSES.length).toBe(49);
    expect(SPEC_EDGES).toHaveLength(8);
  });

  it("treats returned and cancelled as terminal", () => {
    // Not stated as a sentence in the spec — stated by their absence from the
    // left-hand column, which is the same rule.
    expect(isTerminal("returned")).toBe(true);
    expect(isTerminal("cancelled")).toBe(true);
    expect(permittedTransitions("returned")).toEqual([]);
    expect(permittedTransitions("cancelled")).toEqual([]);

    for (const status of ORDER_STATUSES) {
      if (status !== "returned" && status !== "cancelled") {
        expect(isTerminal(status), `${status} should not be terminal`).toBe(false);
      }
    }
  });

  it("refuses a same-state move", () => {
    // Not harmless: it would write a history row whose previous and new states
    // are the same value, which records nothing while looking like a record.
    for (const status of ORDER_STATUSES) {
      expect(isPermittedEdge(status, status), `${status} -> ${status}`).toBe(false);
    }
  });

  it("refuses the spec's own named example", () => {
    // *Invalid transition rejected*: awaiting_payment straight to shipped.
    expect(() =>
      assertTransition({ from: "awaiting_payment", to: "shipped", by: "admin" }),
    ).toThrowError(expect.objectContaining({ code: "orders.invalid_transition" }));
  });
});

describe("who may take an edge", () => {
  it("never lets an artist mark an order delivered", () => {
    // SECURITY.md SPEC-D and S1-10: `delivered` starts the payout clock, and an
    // artist who can stamp it can pay themselves for a parcel that never
    // arrived. This is the single most important row in the actor table.
    expect(actorsFor("shipped", "delivered")).not.toContain("artist");
    expect(canTransition({ from: "shipped", to: "delivered", by: "artist" })).toBe(false);
    expect(canTransition({ from: "shipped", to: "delivered", by: "buyer" })).toBe(true);
    expect(canTransition({ from: "shipped", to: "delivered", by: "admin" })).toBe(true);
  });

  it("never lets an artist decide a return's outcome", () => {
    // SECURITY.md SPEC-E: the artist must not unilaterally control the buyer's
    // refund. Nor may the buyer declare their own return received.
    expect(actorsFor("return_requested", "returned")).toEqual(["admin", "system"]);
    expect(canTransition({ from: "return_requested", to: "returned", by: "artist" })).toBe(false);
    expect(canTransition({ from: "return_requested", to: "returned", by: "buyer" })).toBe(false);
  });

  it("does not let an artist cancel a paid order on their own", () => {
    expect(canTransition({ from: "paid", to: "cancelled", by: "artist" })).toBe(false);
    expect(canTransition({ from: "paid", to: "cancelled", by: "admin" })).toBe(true);
  });

  it("distinguishes a wrong actor from a wrong edge", () => {
    // Different errors, because they mean different things over HTTP: a 403
    // says "not you", a 409 says "not now". A caller that got the same one for
    // both could not tell a permissions bug from a race.
    let actorError: unknown;
    try {
      assertTransition({ from: "shipped", to: "delivered", by: "artist" });
    } catch (error) {
      actorError = error;
    }
    expect(actorError).toBeInstanceOf(AppError);
    expect(actorError).toMatchObject({
      kind: "forbidden",
      code: "orders.transition_not_permitted_for_actor",
    });

    let edgeError: unknown;
    try {
      assertTransition({ from: "shipped", to: "paid", by: "admin" });
    } catch (error) {
      edgeError = error;
    }
    expect(edgeError).toMatchObject({ kind: "conflict", code: "orders.invalid_transition" });
  });

  it("gives every spec edge at least one actor who can take it", () => {
    // An edge nobody may take is an edge that does not exist, and would strand
    // every order that reached its left-hand side.
    for (const [from, to] of SPEC_EDGES) {
      expect(actorsFor(from, to).length, `${from} -> ${to} has no permitted actor`).toBeGreaterThan(
        0,
      );
    }
  });

  it("names no actor for an edge that is not in the machine", () => {
    expect(actorsFor("delivered", "cancelled")).toEqual([]);
    expect(actorsFor("cancelled", "paid")).toEqual([]);
  });
});

describe("aggregating an order from its fulfilments", () => {
  it("follows the least advanced fulfilment", () => {
    // `checkout-orders`, *One fulfilment ships before the other*: "the buyer's
    // order shows one item shipped and one still awaiting dispatch". An order
    // is not shipped until everything in it has shipped.
    expect(aggregateStatus(["shipped", "paid"])).toBe("paid");
    expect(aggregateStatus(["delivered", "shipped"])).toBe("shipped");
    expect(aggregateStatus(["shipped", "shipped"])).toBe("shipped");
    expect(aggregateStatus(["paid", "awaiting_payment"])).toBe("awaiting_payment");
  });

  it("ignores a cancelled fulfilment rather than dragging the order back", () => {
    // On a two-artist order where one artist cannot supply, the buyer's order
    // should follow the half that is still coming.
    expect(aggregateStatus(["shipped", "cancelled"])).toBe("shipped");
    expect(aggregateStatus(["delivered", "cancelled"])).toBe("delivered");
  });

  it("cancels an order whose every fulfilment is cancelled", () => {
    expect(aggregateStatus(["cancelled", "cancelled"])).toBe("cancelled");
  });

  it("declines to answer when a fulfilment is off the linear run", () => {
    // A return in progress is not a point on the awaiting -> delivered line, so
    // the ranks cannot decide and the caller keeps the order where it is.
    expect(aggregateStatus(["return_requested", "delivered"])).toBeNull();
    expect(aggregateStatus(["returned", "delivered"])).toBeNull();
    expect(aggregateStatus([])).toBeNull();
  });

  it("ranks only the linear states", () => {
    expect(progressRank("awaiting_payment")).toBe(0);
    expect(progressRank("paid")).toBe(1);
    expect(progressRank("shipped")).toBe(2);
    expect(progressRank("delivered")).toBe(3);
    expect(progressRank("return_requested")).toBeNull();
    expect(progressRank("returned")).toBeNull();
    expect(progressRank("cancelled")).toBeNull();
  });
});
