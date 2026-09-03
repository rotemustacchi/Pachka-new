/**
 * The order state machine, against the real tables.
 *
 * ARCHITECTURE.md gives every order state change to one function, so these tests
 * drive `transition()`, `transitionFulfilment()` and the operator and buyer
 * actions built on them — never an UPDATE. The two assertions that recur are the
 * two the spec asks for: the order is where it should be, and
 * `order_transitions` says how it got there.
 *
 * `state-machine.test.ts` covers the edge table exhaustively as arithmetic. This
 * file covers what happens to rows.
 */
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { grantAdminRole, useTestDatabase, type TestDatabase } from "../harness";
import type { Database } from "@/shared/db";
import {
  availableUnits,
  createDraft,
  findPublicArtwork,
  publishArtwork,
  type ArtworkInput,
} from "@/modules/artworks";
import {
  artworksDepsFor,
  beginCheckout,
  cancelOrder,
  confirmDelivery,
  createManualPaymentProvider,
  markPaymentReceived,
  orderHistory,
  shipFulfilment,
  sqlInventoryDemand,
  sweepExpiredReservations,
  transition,
  type CheckoutResult,
  type OrdersDeps,
} from "@/modules/orders";

function ordersDeps(database: TestDatabase): OrdersDeps {
  return { db: database.db, payments: createManualPaymentProvider() };
}

async function seedArtist(db: Database, name: string): Promise<string> {
  const id = randomUUID();
  await db.query("insert into profiles (user_id, display_name) values ($1, $2)", [id, name]);
  await db.query("insert into account_status (user_id, verified_at) values ($1, now())", [id]);
  await db.query("insert into user_roles (user_id, role) values ($1, 'artist')", [id]);
  await db.query("insert into artist_profiles (user_id, display_name) values ($1, $2)", [id, name]);
  return id;
}

async function seedBuyer(db: Database, name = "דנה כהן"): Promise<string> {
  const id = randomUUID();
  await db.query("insert into profiles (user_id, display_name) values ($1, $2)", [id, name]);
  await db.query("insert into account_status (user_id, verified_at) values ($1, now())", [id]);
  return id;
}

async function seedOperator(database: TestDatabase): Promise<string> {
  const id = randomUUID();
  await database.db.query("insert into profiles (user_id, display_name) values ($1, 'מנהלת')", [id]);
  await database.db.query("insert into account_status (user_id, verified_at) values ($1, now())", [
    id,
  ]);
  // Out of band: SECURITY.md S0-2 item 4 puts granting `admin` outside the
  // application, and `user_roles_server_insert` enforces it.
  await grantAdminRole(database, id);
  return id;
}

const CANVAS: ArtworkInput = {
  title: "קו החוף, שקיעה",
  description: "ציור שנעשה בחוף פולג בשעת בין ערביים.",
  priceAgorot: 125_000,
  heightCm: 100,
  widthCm: 70,
  weightGrams: 1850,
  materials: "אקריליק על בד פשתן",
  leadTimeDays: 5,
  medium: "textile_clothing",
  styles: ["minimalist"],
  moods: ["calm"],
  affirmsOriginality: true,
  aiAssisted: false,
  inventoryType: "unique",
};

const DELIVERY = {
  fullName: "דנה כהן",
  phone: "0521234567",
  line1: "הרצל 12",
  city: "תל אביב",
  postalCode: "6100000",
  countryCode: "IL",
};

async function publishFor(
  database: TestDatabase,
  artistId: string,
  input: ArtworkInput = CANVAS,
): Promise<string> {
  const deps = artworksDepsFor(ordersDeps(database));
  const draft = await createDraft(deps, artistId, input);
  return (await publishArtwork(deps, artistId, draft.id)).id;
}

/** One buyer, one artist, one piece, checked out and awaiting payment. */
async function placeOrder(
  database: TestDatabase,
): Promise<{ checkout: CheckoutResult; artistId: string; buyerId: string; artworkId: string }> {
  const deps = ordersDeps(database);
  const artistId = await seedArtist(database.db, "יעל");
  const buyerId = await seedBuyer(database.db);
  const artworkId = await publishFor(database, artistId);
  const checkout = await beginCheckout(deps, {
    buyerId,
    lines: [{ artworkId }],
    delivery: DELIVERY,
  });
  return { checkout, artistId, buyerId, artworkId };
}

async function statusOf(db: Database, orderId: string): Promise<string> {
  const row = await db.one<{ status: string }>("select status from orders where id = $1", [orderId]);
  return row.status;
}

describe("an invalid transition", () => {
  const database = useTestDatabase();

  it("is rejected and leaves the order untouched", async () => {
    // `checkout-orders`, *Invalid transition rejected*: "WHEN any actor attempts
    // to move an order directly from `awaiting_payment` to `shipped` THEN the
    // system rejects the transition and leaves the order unchanged."
    const deps = ordersDeps(database);
    const { checkout } = await placeOrder(database);
    const operatorId = await seedOperator(database);

    const before = await database.db.one<{ status: string; updated_at: Date }>(
      "select status, updated_at from orders where id = $1",
      [checkout.order.id],
    );

    await expect(
      transition(database.db, {
        orderId: checkout.order.id,
        to: "shipped",
        actorId: operatorId,
        actorKind: "admin",
      }),
    ).rejects.toMatchObject({ kind: "conflict", code: "orders.invalid_transition" });

    const after = await database.db.one<{ status: string; updated_at: Date }>(
      "select status, updated_at from orders where id = $1",
      [checkout.order.id],
    );

    // Not merely the same status — the same ROW. An implementation that wrote
    // the status and then threw would leave `updated_at` moved.
    expect(after.status).toBe("awaiting_payment");
    expect(after.updated_at).toEqual(before.updated_at);
    expect(before.status).toBe("awaiting_payment");

    // And no history row claiming a move that did not happen.
    expect(await orderHistory(database.db, checkout.order.id)).toEqual([]);

    // The order is still perfectly usable afterwards, which is what "unchanged"
    // has to mean to be worth anything.
    const paid = await markPaymentReceived(deps, { orderId: checkout.order.id, operatorId });
    expect(paid.order.status).toBe("paid");
  });

  it("refuses to leave a terminal state", async () => {
    const deps = ordersDeps(database);
    const { checkout, buyerId } = await placeOrder(database);

    await cancelOrder(deps, {
      orderId: checkout.order.id,
      actorId: buyerId,
      actorKind: "buyer",
    });

    await expect(
      transition(database.db, {
        orderId: checkout.order.id,
        to: "paid",
        actorId: await seedOperator(database),
        actorKind: "admin",
      }),
    ).rejects.toMatchObject({ kind: "conflict", code: "orders.invalid_transition" });
  });

  it("refuses an edge the actor is not entitled to perform", async () => {
    // SECURITY.md SPEC-D and S1-10: `delivered` starts the payout clock, so an
    // artist who could stamp it could pay themselves for a parcel that never
    // arrived. `forbidden` rather than `conflict`: the edge exists and the order
    // is in the right state for it — what is wrong is who is asking.
    const deps = ordersDeps(database);
    const { checkout, artistId } = await placeOrder(database);
    const operatorId = await seedOperator(database);

    await markPaymentReceived(deps, { orderId: checkout.order.id, operatorId });
    await shipFulfilment(deps, {
      fulfilmentId: checkout.fulfilments[0]!.id,
      artistId,
      carrierName: "דואר ישראל",
      trackingReference: "RR123456789IL",
      packagingConfirmed: true,
    });

    await expect(
      confirmDelivery(deps, {
        fulfilmentId: checkout.fulfilments[0]!.id,
        actorId: artistId,
        actorKind: "artist",
      }),
    ).rejects.toMatchObject({
      kind: "forbidden",
      code: "orders.transition_not_permitted_for_actor",
    });

    expect(await statusOf(database.db, checkout.order.id)).toBe("shipped");
  });
});

describe("the transition history", () => {
  const database = useTestDatabase();

  it("records the previous state, the new state, the actor and a timestamp", async () => {
    // `checkout-orders`, *Transition history recorded*.
    const deps = ordersDeps(database);
    const { checkout } = await placeOrder(database);
    const operatorId = await seedOperator(database);

    await markPaymentReceived(deps, { orderId: checkout.order.id, operatorId });

    const history = await orderHistory(database.db, checkout.order.id);
    const orderLevel = history.filter((record) => record.fulfilmentId === null);

    expect(orderLevel).toHaveLength(1);
    expect(orderLevel[0]).toMatchObject({
      from: "awaiting_payment",
      to: "paid",
      actorId: operatorId,
      actorKind: "admin",
    });
    expect(Date.parse(orderLevel[0]!.occurredAt)).not.toBeNaN();

    // The fulfilment's own move is recorded too, against the same order.
    const fulfilmentLevel = history.filter((record) => record.fulfilmentId !== null);
    expect(fulfilmentLevel).toHaveLength(1);
    expect(fulfilmentLevel[0]).toMatchObject({ from: "awaiting_payment", to: "paid" });
  });

  it("cannot be edited or deleted, by any role", async () => {
    // Append-only is what makes a history a history. There is no UPDATE or
    // DELETE policy on `order_transitions` for anyone, including the server.
    const deps = ordersDeps(database);
    const { checkout } = await placeOrder(database);
    const operatorId = await seedOperator(database);
    await markPaymentReceived(deps, { orderId: checkout.order.id, operatorId });

    await expect(
      database.db.query("update order_transitions set to_status = 'cancelled'"),
    ).rejects.toThrow(/permission denied|row-level security/i);
    await expect(database.db.query("delete from order_transitions")).rejects.toThrow(
      /permission denied|row-level security/i,
    );
  });
});

describe("the operator confirms payment", () => {
  const database = useTestDatabase();

  it("moves the order to paid, converts the reservation to a sale, and asks the artist to dispatch", async () => {
    // `checkout-orders`, *Operator confirms payment received* — all three
    // clauses, which is why this test asserts three different things.
    const deps = ordersDeps(database);
    const { checkout, artistId, artworkId } = await placeOrder(database);
    const operatorId = await seedOperator(database);

    const result = await markPaymentReceived(deps, {
      orderId: checkout.order.id,
      operatorId,
    });

    expect(result.order.status).toBe("paid");
    expect(result.fulfilments.every((f) => f.status === "paid")).toBe(true);
    expect(result.payment.status).toBe("captured");
    expect(result.payment.settledBy).toBe(operatorId);

    // The reservation converted rather than being replaced: same row, now sold.
    const demand = await sqlInventoryDemand.demandFor(database.db, artworkId);
    expect(demand).toEqual({ reservedUnits: 0, soldUnits: 1 });
    expect(availableUnits(1, demand)).toBe(0);

    // "the artist is notified to dispatch" — one message per artist, carrying
    // ids rather than the buyer's address, which the artist fetches through the
    // gated read.
    const toArtist = result.notifications.filter((n) => n.audience === "artist");
    expect(toArtist).toHaveLength(1);
    expect(toArtist[0]?.recipientId).toBe(artistId);
    expect(toArtist[0]?.template).toBe("orders.artist_dispatch_requested");
    expect(JSON.stringify(toArtist[0]?.data)).not.toContain(DELIVERY.phone);

    // `shipping` opened the dispatch obligation in the same transaction.
    const dispatch = await database.db.one<{ count: string }>(
      "select count(*)::text as count from shipping_dispatches where order_id = $1",
      [checkout.order.id],
    );
    expect(dispatch.count).toBe("1");
  });

  it("refuses to confirm twice", async () => {
    const deps = ordersDeps(database);
    const { checkout } = await placeOrder(database);
    const operatorId = await seedOperator(database);

    await markPaymentReceived(deps, { orderId: checkout.order.id, operatorId });
    await expect(
      markPaymentReceived(deps, { orderId: checkout.order.id, operatorId }),
    ).rejects.toMatchObject({ kind: "conflict", code: "orders.not_awaiting_payment" });
  });

  it("fails closed when the hold lapsed before the confirmation arrived", async () => {
    // SECURITY.md S0-4's sweep race. "Assert the outcome is exactly one of
    // {sale recorded, confirmation rejected} — never {reservation released AND
    // sale recorded}."
    const deps = ordersDeps(database);
    const { checkout, artworkId } = await placeOrder(database);
    const operatorId = await seedOperator(database);

    // The hold lapses and the sweep gets there first.
    await database.db.query(
      "update reservations set expires_at = now() - interval '1 minute' where order_id = $1",
      [checkout.order.id],
    );
    await sweepExpiredReservations(deps);

    await expect(
      markPaymentReceived(deps, { orderId: checkout.order.id, operatorId }),
    ).rejects.toMatchObject({ kind: "conflict", code: "orders.reservation_lapsed" });

    // Refused, and nothing half-done: the order did not move and the unit is
    // genuinely back on the market rather than sold to nobody.
    expect(await statusOf(database.db, checkout.order.id)).toBe("awaiting_payment");
    const demand = await sqlInventoryDemand.demandFor(database.db, artworkId);
    expect(demand).toEqual({ reservedUnits: 0, soldUnits: 0 });
    expect((await findPublicArtwork(artworksDepsFor(deps), artworkId)).purchasable).toBe(true);
  });
});

describe("cancellation", () => {
  const database = useTestDatabase();

  it("restores inventory from awaiting_payment and puts the piece back on the market", async () => {
    // `checkout-orders`, *Cancellation restores inventory*.
    const deps = ordersDeps(database);
    const { checkout, buyerId, artworkId } = await placeOrder(database);

    expect(availableUnits(1, await sqlInventoryDemand.demandFor(database.db, artworkId))).toBe(0);

    const result = await cancelOrder(deps, {
      orderId: checkout.order.id,
      actorId: buyerId,
      actorKind: "buyer",
      reason: "שינתה את דעתה",
    });

    expect(result.order.status).toBe("cancelled");
    expect(result.fulfilments.every((f) => f.status === "cancelled")).toBe(true);
    expect(result.released).toHaveLength(1);
    expect(result.released[0]?.releaseReason).toBe("cancelled");

    expect(availableUnits(1, await sqlInventoryDemand.demandFor(database.db, artworkId))).toBe(1);
    const artwork = await findPublicArtwork(artworksDepsFor(deps), artworkId);
    expect(artwork.status).toBe("published");
    expect(artwork.purchasable).toBe(true);
  });

  it("restores inventory from paid, releasing the confirmed sale", async () => {
    // The `paid -> cancelled` edge. A confirmed reservation is released too;
    // that is the whole point of the edge existing.
    const deps = ordersDeps(database);
    const { checkout, artworkId } = await placeOrder(database);
    const operatorId = await seedOperator(database);

    await markPaymentReceived(deps, { orderId: checkout.order.id, operatorId });
    expect((await sqlInventoryDemand.demandFor(database.db, artworkId)).soldUnits).toBe(1);

    const result = await cancelOrder(deps, {
      orderId: checkout.order.id,
      actorId: operatorId,
      actorKind: "admin",
      reason: "האמנית לא יכולה לספק",
    });

    expect(result.order.status).toBe("cancelled");
    expect(await sqlInventoryDemand.demandFor(database.db, artworkId)).toEqual({
      reservedUnits: 0,
      soldUnits: 0,
    });
    expect((await findPublicArtwork(artworksDepsFor(deps), artworkId)).purchasable).toBe(true);
  });

  it("lets the freed piece be bought by someone else", async () => {
    // The observable end of "becomes purchasable again". Availability
    // arithmetic that no second buyer can act on is not a restored inventory.
    const deps = ordersDeps(database);
    const { checkout, buyerId, artworkId } = await placeOrder(database);
    const nextBuyer = await seedBuyer(database.db, "נועה");

    await cancelOrder(deps, {
      orderId: checkout.order.id,
      actorId: buyerId,
      actorKind: "buyer",
    });

    const second = await beginCheckout(deps, {
      buyerId: nextBuyer,
      lines: [{ artworkId }],
      delivery: DELIVERY,
    });
    expect(second.order.buyerId).toBe(nextBuyer);
  });

  it("keeps the cancelled order rather than deleting it", async () => {
    const deps = ordersDeps(database);
    const { checkout, buyerId } = await placeOrder(database);

    await cancelOrder(deps, {
      orderId: checkout.order.id,
      actorId: buyerId,
      actorKind: "buyer",
    });

    // The row, the released reservation and the payment all survive: they are
    // the evidence for a refund, and there is no DELETE policy anywhere in this
    // module for any role.
    expect(await statusOf(database.db, checkout.order.id)).toBe("cancelled");
    await expect(database.db.query("delete from orders")).rejects.toThrow(
      /permission denied|row-level security/i,
    );
    await expect(database.db.query("delete from reservations")).rejects.toThrow(
      /permission denied|row-level security/i,
    );
  });
});

describe("a two-artist order shipping in two halves", () => {
  const database = useTestDatabase();

  it("shows one item shipped and one still awaiting dispatch", async () => {
    // `checkout-orders`, *One fulfilment ships before the other*. The order's
    // own status follows the LEAST advanced fulfilment, which is what makes the
    // buyer's view able to say both things at once.
    const deps = ordersDeps(database);
    const yael = await seedArtist(database.db, "יעל");
    const noa = await seedArtist(database.db, "נועה");
    const buyerId = await seedBuyer(database.db);
    const operatorId = await seedOperator(database);

    const first = await publishFor(database, yael);
    const second = await publishFor(database, noa);

    const checkout = await beginCheckout(deps, {
      buyerId,
      lines: [{ artworkId: first }, { artworkId: second }],
      delivery: DELIVERY,
    });
    await markPaymentReceived(deps, { orderId: checkout.order.id, operatorId });

    const yaelFulfilment = checkout.fulfilments.find((f) => f.artistId === yael)!;
    const noaFulfilment = checkout.fulfilments.find((f) => f.artistId === noa)!;

    await shipFulfilment(deps, {
      fulfilmentId: yaelFulfilment.id,
      artistId: yael,
      carrierName: "דואר ישראל",
      trackingReference: "RR111111111IL",
      packagingConfirmed: true,
    });

    // One shipped, one not — and the ORDER has not moved.
    const statuses = await database.db.query<{ id: string; status: string }>(
      "select id, status from fulfilments where order_id = $1",
      [checkout.order.id],
    );
    expect(
      statuses.rows.find((row) => row.id === yaelFulfilment.id)?.status,
    ).toBe("shipped");
    expect(statuses.rows.find((row) => row.id === noaFulfilment.id)?.status).toBe("paid");
    expect(await statusOf(database.db, checkout.order.id)).toBe("paid");

    // The second artist ships, and only now does the order.
    await shipFulfilment(deps, {
      fulfilmentId: noaFulfilment.id,
      artistId: noa,
      carrierName: "דואר ישראל",
      trackingReference: "RR222222222IL",
      packagingConfirmed: true,
    });
    expect(await statusOf(database.db, checkout.order.id)).toBe("shipped");
  });

  it("marks the order delivered only when both parcels have arrived", async () => {
    const deps = ordersDeps(database);
    const yael = await seedArtist(database.db, "יעל");
    const noa = await seedArtist(database.db, "נועה");
    const buyerId = await seedBuyer(database.db);
    const operatorId = await seedOperator(database);

    const checkout = await beginCheckout(deps, {
      buyerId,
      lines: [
        { artworkId: await publishFor(database, yael) },
        { artworkId: await publishFor(database, noa) },
      ],
      delivery: DELIVERY,
    });
    await markPaymentReceived(deps, { orderId: checkout.order.id, operatorId });

    for (const fulfilment of checkout.fulfilments) {
      await shipFulfilment(deps, {
        fulfilmentId: fulfilment.id,
        artistId: fulfilment.artistId,
        carrierName: "דואר ישראל",
        trackingReference: `RR${fulfilment.artistId.slice(0, 9)}IL`,
        packagingConfirmed: true,
      });
    }

    const half = await confirmDelivery(deps, {
      fulfilmentId: checkout.fulfilments[0]!.id,
      actorId: buyerId,
      actorKind: "buyer",
    });
    expect(half.order.status).toBe("shipped");
    // Nothing sent while a parcel is still in transit.
    expect(half.notifications).toEqual([]);

    const whole = await confirmDelivery(deps, {
      fulfilmentId: checkout.fulfilments[1]!.id,
      actorId: buyerId,
      actorKind: "buyer",
    });
    expect(whole.order.status).toBe("delivered");
    expect(whole.notifications.map((n) => n.audience).sort()).toEqual([
      "artist",
      "artist",
      "buyer",
    ]);
  });
});
