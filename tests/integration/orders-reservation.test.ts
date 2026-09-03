/**
 * The double sale, and the machinery that makes it impossible.
 *
 * This is the file the whole orders module exists for. A one-of-a-kind painting
 * sold twice cannot be undone: there is no second copy, and two people have paid
 * for one object.
 *
 * WHAT MAKES THE CONCURRENCY TESTS BELOW REAL
 * -------------------------------------------
 * ARCHITECTURE.md: "Concurrency is tested for real. The double-sale test runs
 * genuinely parallel transactions and asserts exactly one wins." A test that
 * awaited each checkout in turn would pass against a completely unlocked
 * implementation, so:
 *
 *   • Every attempt is STARTED before any of them is awaited. `checkoutRace`
 *     builds the whole array of promises and only then hands them to
 *     `Promise.allSettled`, so the calls are in flight simultaneously and the
 *     database decides the winner.
 *   • Each attempt is a separate `beginCheckout`, which opens its own
 *     transaction on its own pooled connection — the harness gives every test a
 *     real pool for exactly this reason.
 *   • There is no `sleep` and no timer anywhere. Ordering is established by the
 *     lock, which is the thing under test.
 *   • The assertion is on the DATABASE afterwards as well as on the promises:
 *     one order, one live reservation row. A test that only counted resolved
 *     promises would miss an implementation that created two orders and threw
 *     on the second for an unrelated reason.
 *
 * `tests/integration/transactions.test.ts` proves `withTransaction` and
 * `SELECT ... FOR UPDATE` behave under concurrency. This file proves the
 * PRODUCT does — against the real `artworks` table, the real reservations
 * ledger, and the real checkout path, with the real shipping quote inside it.
 */
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { useTestDatabase, type TestDatabase } from "../harness";
import type { Database } from "@/shared/db";
import {
  availableUnits,
  createDraft,
  findPublicArtwork,
  publishArtwork,
  type ArtworkInput,
} from "@/modules/artworks";
import {
  activeReservationCount,
  artworksDepsFor,
  beginCheckout,
  createManualPaymentProvider,
  sqlInventoryDemand,
  sweepExpiredReservations,
  type CheckoutResult,
  type OrdersDeps,
} from "@/modules/orders";

// ---------------------------------------------------------------------------
// Fixtures. Each test creates the data it needs (ARCHITECTURE.md test policy).
// ---------------------------------------------------------------------------

function ordersDeps(database: TestDatabase): OrdersDeps {
  // The real adapter, not a fake. `createManualPaymentProvider` is what ships;
  // it is deterministic and reaches no network, so there is nothing to stub and
  // nothing to assert about a stub.
  return { db: database.db, payments: createManualPaymentProvider() };
}

async function seedArtist(db: Database, name = "יעל שוורץ"): Promise<string> {
  const id = randomUUID();
  await db.query("insert into profiles (user_id, display_name) values ($1, $2)", [id, name]);
  await db.query("insert into account_status (user_id, verified_at) values ($1, now())", [id]);
  await db.query("insert into user_roles (user_id, role) values ($1, 'artist')", [id]);
  await db.query("insert into artist_profiles (user_id, display_name) values ($1, $2)", [id, name]);
  return id;
}

/**
 * A buyer with a verified address.
 *
 * Verified deliberately: SECURITY.md S1-17 requires the verification gate at
 * RESERVATION time, so an unverified buyer never reaches the lock at all — which
 * is asserted in its own test below rather than being an accident of the
 * fixture.
 */
async function seedBuyer(db: Database, name = "דנה כהן"): Promise<string> {
  const id = randomUUID();
  await db.query("insert into profiles (user_id, display_name) values ($1, $2)", [id, name]);
  await db.query("insert into account_status (user_id, verified_at) values ($1, now())", [id]);
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
};

async function publishArtworkFor(
  database: TestDatabase,
  artistId: string,
  overrides: ArtworkInput = {},
): Promise<string> {
  const deps = artworksDepsFor(ordersDeps(database));
  const draft = await createDraft(deps, artistId, { ...CANVAS, ...overrides });
  const published = await publishArtwork(deps, artistId, draft.id);
  return published.id;
}

/** Tel Aviv is in the `center` zone the shipping migration seeds. */
const DELIVERY = {
  fullName: "דנה כהן",
  phone: "0521234567",
  line1: "הרצל 12",
  city: "תל אביב",
  postalCode: "6100000",
  countryCode: "IL",
};

// ---------------------------------------------------------------------------
// The race
// ---------------------------------------------------------------------------

/**
 * Fire `buyerIds.length` checkouts at one artwork, all at once.
 *
 * The two-step build is the point. Every promise is created by the `.map`
 * before `allSettled` is reached, so all of them are in flight together; a
 * `for ... await` loop here would serialise them and prove nothing.
 */
async function checkoutRace(
  deps: OrdersDeps,
  buyerIds: readonly string[],
  artworkId: string,
): Promise<PromiseSettledResult<CheckoutResult>[]> {
  const attempts = buyerIds.map((buyerId) =>
    beginCheckout(deps, {
      buyerId,
      lines: [{ artworkId }],
      delivery: DELIVERY,
    }),
  );
  return Promise.allSettled(attempts);
}

async function liveReservationCount(db: Database, artworkId: string): Promise<number> {
  const row = await db.one<{ count: string }>(
    `select count(*)::text as count
       from reservations where artwork_id = $1 and released_at is null`,
    [artworkId],
  );
  return Number(row.count);
}

async function orderCount(db: Database): Promise<number> {
  const row = await db.one<{ count: string }>("select count(*)::text as count from orders");
  return Number(row.count);
}

describe("two buyers, one unique artwork", () => {
  const database = useTestDatabase();

  it("lets exactly one reservation succeed and tells the other the piece is gone", async () => {
    const deps = ordersDeps(database);
    const artistId = await seedArtist(database.db);
    const artworkId = await publishArtworkFor(database, artistId, { inventoryType: "unique" });
    const buyers = [await seedBuyer(database.db, "דנה"), await seedBuyer(database.db, "נועה")];

    const results = await checkoutRace(deps, buyers, artworkId);

    const won = results.filter((r) => r.status === "fulfilled");
    const lost = results.filter((r) => r.status === "rejected");

    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(1);

    // `checkout-orders`: "the other buyer is told the piece is no longer
    // available". `conflict` is a 409, which is what that sentence means over
    // HTTP — the request was fine, the world changed.
    expect((lost[0] as PromiseRejectedResult).reason).toMatchObject({
      kind: "conflict",
      code: "orders.artwork_unavailable",
    });

    // The database, not just the promises. One order, one held unit.
    expect(await orderCount(database.db)).toBe(1);
    expect(await liveReservationCount(database.db, artworkId)).toBe(1);
  });

  it("leaves the artwork sold, with derived availability at zero", async () => {
    const deps = ordersDeps(database);
    const artistId = await seedArtist(database.db);
    const artworkId = await publishArtworkFor(database, artistId, { inventoryType: "unique" });
    const buyers = [await seedBuyer(database.db, "דנה"), await seedBuyer(database.db, "נועה")];

    await checkoutRace(deps, buyers, artworkId);

    const demand = await sqlInventoryDemand.demandFor(database.db, artworkId);
    expect(demand).toEqual({ reservedUnits: 1, soldUnits: 0 });
    expect(availableUnits(1, demand)).toBe(0);

    // And it is off the market: `reconcileAvailability` moved it to `sold`
    // inside the same transaction, so nothing can be added to a cart from it.
    // `findPublicArtwork` is the catalog's own read, so this asserts what a
    // second buyer would actually see rather than what the row says.
    const artwork = await findPublicArtwork(artworksDepsFor(deps), artworkId);
    expect(artwork.status).toBe("sold");
    expect(artwork.purchasable).toBe(false);
    expect(artwork.availableUnits).toBe(0);
  });
});

describe("ten buyers, one unique artwork", () => {
  const database = useTestDatabase();

  it("lets exactly one succeed and nine be refused", async () => {
    const deps = ordersDeps(database);
    const artistId = await seedArtist(database.db);
    const artworkId = await publishArtworkFor(database, artistId, { inventoryType: "unique" });

    const buyers: string[] = [];
    for (let i = 0; i < 10; i += 1) {
      buyers.push(await seedBuyer(database.db, `קונה ${i}`));
    }

    const results = await checkoutRace(deps, buyers, artworkId);

    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(9);

    // Every refusal is the RIGHT refusal. Nine rejections would also be
    // produced by an implementation that fell over for nine unrelated reasons,
    // and that implementation would not be safe.
    for (const result of results.filter((r) => r.status === "rejected")) {
      expect((result as PromiseRejectedResult).reason).toMatchObject({
        kind: "conflict",
        code: "orders.artwork_unavailable",
      });
    }

    expect(await orderCount(database.db)).toBe(1);
    expect(await liveReservationCount(database.db, artworkId)).toBe(1);
  });
});

describe("ten buyers, an edition of three", () => {
  const database = useTestDatabase();

  it("lets exactly three succeed and derived availability reach zero", async () => {
    // SECURITY.md S0-4's "edition variant". The unique case can be passed by an
    // implementation that allows one reservation per artwork full stop; only an
    // edition shows that the rule being enforced is DERIVED availability.
    const deps = ordersDeps(database);
    const artistId = await seedArtist(database.db);
    const artworkId = await publishArtworkFor(database, artistId, {
      inventoryType: "edition",
      stock: 3,
    });

    const buyers: string[] = [];
    for (let i = 0; i < 10; i += 1) {
      buyers.push(await seedBuyer(database.db, `קונה ${i}`));
    }

    const results = await checkoutRace(deps, buyers, artworkId);

    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(3);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(7);

    const demand = await sqlInventoryDemand.demandFor(database.db, artworkId);
    expect(demand.reservedUnits).toBe(3);
    expect(availableUnits(3, demand)).toBe(0);
    expect(await liveReservationCount(database.db, artworkId)).toBe(3);

    // Three distinct units, not three claims on one. The ordinals are what the
    // defensive unique index constrains, so a duplicate here would be the
    // double sale wearing an edition's clothes.
    const { rows } = await database.db.query<{ unit_index: number }>(
      "select unit_index from reservations where artwork_id = $1 and released_at is null order by unit_index",
      [artworkId],
    );
    expect(rows.map((r) => r.unit_index)).toEqual([0, 1, 2]);
  });
});

describe("the defensive unique index", () => {
  const database = useTestDatabase();

  it("refuses a second live reservation for the same unit, even bypassing the module", async () => {
    // SECURITY.md S0-4 item 3 asks for a constraint so "a future logic bug is a
    // constraint violation rather than a double sale". This asserts the
    // constraint itself, by writing the row the module would never write — the
    // only way to test a backstop is to get past the thing it backs up.
    const deps = ordersDeps(database);
    const artistId = await seedArtist(database.db);
    const artworkId = await publishArtworkFor(database, artistId, { inventoryType: "unique" });
    const buyer = await seedBuyer(database.db);
    const intruder = await seedBuyer(database.db, "פולש");

    await beginCheckout(deps, { buyerId: buyer, lines: [{ artworkId }], delivery: DELIVERY });

    await expect(
      database.db.query(
        `insert into reservations (artwork_id, buyer_id, unit_index, expires_at)
         values ($1, $2, 0, now() + interval '1 hour')`,
        [artworkId, intruder],
      ),
    ).rejects.toThrow(/duplicate key value|reservations_one_live_row_per_unit/i);

    expect(await liveReservationCount(database.db, artworkId)).toBe(1);
  });
});

describe("a reservation that expires", () => {
  const database = useTestDatabase();

  /**
   * The clock is advanced by moving the row's `expires_at` into the past, not
   * by sleeping. ARCHITECTURE.md's test policy forbids `sleep`, and the
   * reservation TTL is bounded at a minimum of five minutes by the `app_config`
   * CHECK (SECURITY.md S1-16/S1-17 item 4) — deliberately, so it cannot be
   * widened into a weapon, which also means it cannot be narrowed into a fast
   * test. Rewriting the timestamp is the honest equivalent of waiting.
   */
  async function expireHolds(db: Database, artworkId: string): Promise<void> {
    await db.query(
      "update reservations set expires_at = now() - interval '1 minute' where artwork_id = $1 and released_at is null",
      [artworkId],
    );
  }

  it("releases the inventory and makes the artwork purchasable again", async () => {
    const deps = ordersDeps(database);
    const artistId = await seedArtist(database.db);
    const artworkId = await publishArtworkFor(database, artistId, { inventoryType: "unique" });
    const buyer = await seedBuyer(database.db);

    await beginCheckout(deps, { buyerId: buyer, lines: [{ artworkId }], delivery: DELIVERY });

    // Sold out, and off the market.
    expect(availableUnits(1, await sqlInventoryDemand.demandFor(database.db, artworkId))).toBe(0);
    expect((await findPublicArtwork(artworksDepsFor(deps), artworkId)).status).toBe("sold");

    await expireHolds(database.db, artworkId);
    const swept = await sweepExpiredReservations(deps);

    expect(swept.released).toHaveLength(1);
    expect(swept.released[0]?.releaseReason).toBe("expired");
    expect(swept.artworkIds).toEqual([artworkId]);

    // `checkout-orders`, *Reservation expires*: "the reservation is released and
    // the artwork becomes purchasable again". Both halves are asserted, because
    // releasing the row without moving the artwork out of `sold` would satisfy
    // the arithmetic and leave a piece nobody can buy.
    expect(availableUnits(1, await sqlInventoryDemand.demandFor(database.db, artworkId))).toBe(1);
    const after = await findPublicArtwork(artworksDepsFor(deps), artworkId);
    expect(after.status).toBe("published");
    expect(after.purchasable).toBe(true);
  });

  it("stops counting against availability the moment it lapses, before the sweep runs", async () => {
    // The sweep is a tidying job, not the authority. If availability depended on
    // it having run, a stalled sweep would hold the whole catalog hostage —
    // SECURITY.md S1-17's attack arriving by accident.
    const deps = ordersDeps(database);
    const artistId = await seedArtist(database.db);
    const artworkId = await publishArtworkFor(database, artistId, { inventoryType: "unique" });
    const buyer = await seedBuyer(database.db);

    await beginCheckout(deps, { buyerId: buyer, lines: [{ artworkId }], delivery: DELIVERY });
    await expireHolds(database.db, artworkId);

    // No sweep between these two lines.
    const demand = await sqlInventoryDemand.demandFor(database.db, artworkId);
    expect(demand.reservedUnits).toBe(0);
    expect(availableUnits(1, demand)).toBe(1);
  });

  it("lets a second buyer take a lapsed unit that the sweep has not reached yet", async () => {
    const deps = ordersDeps(database);
    const artistId = await seedArtist(database.db);
    const artworkId = await publishArtworkFor(database, artistId, { inventoryType: "unique" });
    const first = await seedBuyer(database.db, "ראשונה");
    const second = await seedBuyer(database.db, "שנייה");

    await beginCheckout(deps, { buyerId: first, lines: [{ artworkId }], delivery: DELIVERY });
    await expireHolds(database.db, artworkId);

    const result = await beginCheckout(deps, {
      buyerId: second,
      lines: [{ artworkId }],
      delivery: DELIVERY,
    });

    expect(result.order.buyerId).toBe(second);
    // The lapsed hold was released by the checkout itself, under the lock, so
    // its unit ordinal was free for the new one to claim.
    expect(await liveReservationCount(database.db, artworkId)).toBe(1);
  });

  it("never releases a hold whose payment has been captured", async () => {
    // SECURITY.md S0-4 item 4. A confirmed sale is not undone by the passage of
    // time, and neither is money that has moved.
    const deps = ordersDeps(database);
    const artistId = await seedArtist(database.db);
    const artworkId = await publishArtworkFor(database, artistId, { inventoryType: "unique" });
    const buyer = await seedBuyer(database.db);

    const checkout = await beginCheckout(deps, {
      buyerId: buyer,
      lines: [{ artworkId }],
      delivery: DELIVERY,
    });

    await database.db.query("update payments set status = 'captured' where order_id = $1", [
      checkout.order.id,
    ]);
    await expireHolds(database.db, artworkId);

    const swept = await sweepExpiredReservations(deps);
    expect(swept.released).toHaveLength(0);
    expect(await liveReservationCount(database.db, artworkId)).toBe(1);
  });
});

describe("the reservation cap", () => {
  const database = useTestDatabase();

  it("refuses the checkout past the cap and holds nothing extra", async () => {
    // SECURITY.md S1-17: without a cap, one scripted account holds the whole
    // catalog for the TTL and re-runs on a timer. The cap is injected here
    // rather than read from `app_config` because the key is not registered yet
    // — see `DEFAULT_MAX_ACTIVE_RESERVATIONS_PER_BUYER`.
    const deps: OrdersDeps = { ...ordersDeps(database), maxActiveReservationsPerBuyer: 2 };
    const artistId = await seedArtist(database.db);
    const buyer = await seedBuyer(database.db);

    const artworkIds: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      artworkIds.push(await publishArtworkFor(database, artistId, { inventoryType: "unique" }));
    }

    await beginCheckout(deps, {
      buyerId: buyer,
      lines: [{ artworkId: artworkIds[0]! }],
      delivery: DELIVERY,
    });
    await beginCheckout(deps, {
      buyerId: buyer,
      lines: [{ artworkId: artworkIds[1]! }],
      delivery: DELIVERY,
    });

    await expect(
      beginCheckout(deps, {
        buyerId: buyer,
        lines: [{ artworkId: artworkIds[2]! }],
        delivery: DELIVERY,
      }),
    ).rejects.toMatchObject({ kind: "rate_limited", code: "orders.reservation_cap_reached" });

    // Exactly the cap, and the third artwork untouched.
    expect(await activeReservationCount(database.db, buyer)).toBe(2);
    expect(await liveReservationCount(database.db, artworkIds[2]!)).toBe(0);
  });
});

describe("the email-verification gate", () => {
  const database = useTestDatabase();

  it("refuses an unverified buyer before any inventory is held", async () => {
    // SECURITY.md S1-17: "If the verification check sits at confirm rather than
    // at reservation, an unverified — therefore disposable and unattributable —
    // account can lock inventory." The second assertion is the one that matters:
    // zero reservation rows, not merely a rejected promise.
    const deps = ordersDeps(database);
    const artistId = await seedArtist(database.db);
    const artworkId = await publishArtworkFor(database, artistId, { inventoryType: "unique" });

    const unverified = randomUUID();
    await database.db.query("insert into profiles (user_id, display_name) values ($1, 'אורח')", [
      unverified,
    ]);
    await database.db.query("insert into account_status (user_id) values ($1)", [unverified]);

    await expect(
      beginCheckout(deps, {
        buyerId: unverified,
        lines: [{ artworkId }],
        delivery: DELIVERY,
      }),
    ).rejects.toMatchObject({ kind: "forbidden", code: "accounts.email_not_verified" });

    expect(await liveReservationCount(database.db, artworkId)).toBe(0);
    expect(await orderCount(database.db)).toBe(0);
  });
});
