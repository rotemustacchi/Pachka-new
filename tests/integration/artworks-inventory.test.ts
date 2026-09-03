/**
 * Inventory, the lifecycle state machine, and the reserved-artwork block.
 *
 * THE DEMAND SOURCE IN THIS FILE IS REAL CODE, NOT A MOCK
 * -------------------------------------------------------
 * `artworks` derives availability as `stock - active_reservations - sold`, and
 * the last two terms are facts `orders` owns. ARCHITECTURE.md's dependency
 * table points `orders` at `artworks` and not the reverse, so this module takes
 * an `InventoryDemandSource` and `orders` will implement it.
 *
 * The implementation below is a genuine one: a real table, real rows, real SQL,
 * running inside whatever transaction the caller passes. Nothing here asserts
 * that a function was called -- every assertion is about a row that exists, a
 * number returned, or an error raised. The table is created per test, in that
 * test's own database, and is named so it can never be mistaken for the real
 * `reservations` table `orders` will ship.
 */
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { Database, Sql } from "@/shared/db";
import {
  artistDashboard,
  canTransition,
  createDraft,
  findOwnArtwork,
  findPublicArtwork,
  lockArtworkForUpdate,
  noImpressions,
  publishArtwork,
  reconcileAvailability,
  removeArtwork,
  returnToDraft,
  unlistArtwork,
  updateArtwork,
  type ArtworkInput,
  type ArtworksDeps,
  type ImpressionSource,
  type InventoryDemand,
  type InventoryDemandSource,
} from "@/modules/artworks";
import { defineScratchTable, grantAdminRole, useTestDatabase, type TestDatabase } from "../harness";

async function seedArtist(db: Database): Promise<string> {
  const id = randomUUID();
  await db.query("insert into profiles (user_id, display_name) values ($1, 'יעל שוורץ')", [id]);
  await db.query("insert into account_status (user_id, verified_at) values ($1, now())", [id]);
  await db.query("insert into user_roles (user_id, role) values ($1, 'artist')", [id]);
  await db.query("insert into artist_profiles (user_id, display_name) values ($1, 'יעל שוורץ')", [
    id,
  ]);
  return id;
}

async function seedAdmin(database: TestDatabase): Promise<string> {
  const db = database.db;
  const id = randomUUID();
  await db.query("insert into profiles (user_id, display_name) values ($1, 'מנהלת')", [id]);
  await db.query("insert into account_status (user_id, verified_at) values ($1, now())", [id]);
  // Out of band, because SECURITY.md S0-2 item 4 puts granting `admin` outside
  // the application and `user_roles_server_insert` now enforces that.
  await grantAdminRole(database, id);
  return id;
}

const COMPLETE: ArtworkInput = {
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

/**
 * The stand-in for what `orders` will own.
 *
 * `held` is an in-progress checkout; `confirmed` is a completed sale;
 * `released` is a cancellation or an expiry and counts for nothing. That is
 * exactly the shape `InventoryDemand` describes, and building it as a table
 * rather than a canned return value is what lets the concurrency test below
 * mean anything.
 */
async function createOrderHolds(database: TestDatabase): Promise<void> {
  await defineScratchTable(
    database,
    "test_order_holds",
    `create table test_order_holds (
      id         uuid primary key default gen_random_uuid(),
      artwork_id uuid not null references artworks (id),
      units      integer not null check (units > 0),
      state      text not null check (state in ('held', 'confirmed', 'released'))
    )`,
  );
}

const orderHolds: InventoryDemandSource = {
  async demandFor(sql: Sql, artworkId: string): Promise<InventoryDemand> {
    const row = await sql.one<{ reserved: string; sold: string }>(
      `select coalesce(sum(units) filter (where state = 'held'), 0)::text      as reserved,
              coalesce(sum(units) filter (where state = 'confirmed'), 0)::text as sold
         from test_order_holds where artwork_id = $1`,
      [artworkId],
    );
    return { reservedUnits: Number(row.reserved), soldUnits: Number(row.sold) };
  },

  async demandForMany(sql: Sql, artworkIds: readonly string[]) {
    const { rows } = await sql.query<{ artwork_id: string; reserved: string; sold: string }>(
      `select artwork_id,
              coalesce(sum(units) filter (where state = 'held'), 0)::text      as reserved,
              coalesce(sum(units) filter (where state = 'confirmed'), 0)::text as sold
         from test_order_holds
        where artwork_id = any($1::uuid[])
        group by artwork_id`,
      [artworkIds],
    );
    const demand = new Map<string, InventoryDemand>(
      artworkIds.map((id) => [id, { reservedUnits: 0, soldUnits: 0 }] as const),
    );
    for (const row of rows) {
      demand.set(row.artwork_id, {
        reservedUnits: Number(row.reserved),
        soldUnits: Number(row.sold),
      });
    }
    return demand;
  },
};

function depsWithHolds(db: Database, impressions: ImpressionSource = noImpressions): ArtworksDeps {
  return { db, demand: orderHolds, impressions };
}

async function hold(db: Database, artworkId: string, state: string, units = 1): Promise<void> {
  await db.query("insert into test_order_holds (artwork_id, units, state) values ($1, $2, $3)", [
    artworkId,
    units,
    state,
  ]);
}

/** A published artwork with the given inventory shape. */
async function publish(
  deps: ArtworksDeps,
  artistId: string,
  overrides: ArtworkInput = {},
): Promise<string> {
  const draft = await createDraft(deps, artistId, { ...COMPLETE, ...overrides });
  const published = await publishArtwork(deps, artistId, draft.id);
  return published.id;
}

describe("unique pieces and editions", () => {
  const database = useTestDatabase();

  it("pins a unique piece to one unit however large a stock is submitted", async () => {
    await createOrderHolds(database);
    const d = depsWithHolds(database.db);
    const artistId = await seedArtist(database.db);

    const draft = await createDraft(d, artistId, {
      ...COMPLETE,
      inventoryType: "unique",
      stock: 12,
    });

    expect(draft.inventoryType).toBe("unique");
    expect(draft.stock).toBe(1);
  });

  /** artwork-listings: "Unique piece sells out". */
  it("marks a unique piece sold and removes it from purchasable results", async () => {
    await createOrderHolds(database);
    const d = depsWithHolds(database.db);
    const artistId = await seedArtist(database.db);
    const artworkId = await publish(d, artistId, { inventoryType: "unique" });

    await hold(database.db, artworkId, "confirmed");
    const { artwork, availability } = await reconcileAvailability(d, artworkId);

    expect(artwork.status).toBe("sold");
    expect(availability.availableUnits).toBe(0);
    expect(availability.purchasable).toBe(false);

    // The detail page still resolves and says so, rather than 404-ing on a
    // buyer who bookmarked it (catalog-browse).
    const page = await findPublicArtwork(d, artworkId);
    expect(page.status).toBe("sold");
    expect(page.soldOut).toBe(true);
    expect(page.purchasable).toBe(false);
  });

  /** artwork-listings: "Edition stock decrements" -- observably, by derivation. */
  it("shows nine remaining after one of an edition of ten is sold, and stays purchasable", async () => {
    await createOrderHolds(database);
    const d = depsWithHolds(database.db);
    const artistId = await seedArtist(database.db);
    const artworkId = await publish(d, artistId, { inventoryType: "edition", stock: 10 });

    await hold(database.db, artworkId, "confirmed");
    const { artwork, availability } = await reconcileAvailability(d, artworkId);

    expect(availability.availableUnits).toBe(9);
    expect(availability.purchasable).toBe(true);
    expect(artwork.status).toBe("published");

    // And the declared edition size is untouched -- nothing decremented a column.
    const stored = await database.db.one<{ stock: number }>(
      "select stock from artworks where id = $1",
      [artworkId],
    );
    expect(stored.stock).toBe(10);
  });

  /** artwork-listings: "Edition reaches zero". */
  it("marks an edition sold out when the last unit goes", async () => {
    await createOrderHolds(database);
    const d = depsWithHolds(database.db);
    const artistId = await seedArtist(database.db);
    const artworkId = await publish(d, artistId, { inventoryType: "edition", stock: 3 });

    await hold(database.db, artworkId, "confirmed", 3);
    const { artwork, availability } = await reconcileAvailability(d, artworkId);

    expect(artwork.status).toBe("sold");
    expect(availability.availableUnits).toBe(0);
    expect(availability.soldOut).toBe(true);
  });

  it("counts an in-progress checkout against availability without marking it sold", async () => {
    await createOrderHolds(database);
    const d = depsWithHolds(database.db);
    const artistId = await seedArtist(database.db);
    const artworkId = await publish(d, artistId, { inventoryType: "edition", stock: 2 });

    await hold(database.db, artworkId, "held");
    const { availability } = await reconcileAvailability(d, artworkId);

    expect(availability.reservedUnits).toBe(1);
    expect(availability.soldUnits).toBe(0);
    expect(availability.availableUnits).toBe(1);
  });

  /**
   * The payoff of deriving rather than decrementing. With a counter column,
   * putting a unit back after a cancellation is a second piece of code somebody
   * has to remember to write, and the failure mode is an edition that stays
   * sold out forever with stock sitting in the artist's studio.
   */
  it("returns a sold-out edition to published when a cancelled order frees a unit", async () => {
    await createOrderHolds(database);
    const d = depsWithHolds(database.db);
    const artistId = await seedArtist(database.db);
    const artworkId = await publish(d, artistId, { inventoryType: "edition", stock: 2 });

    await hold(database.db, artworkId, "confirmed", 2);
    expect((await reconcileAvailability(d, artworkId)).artwork.status).toBe("sold");

    await database.db.query(
      "update test_order_holds set state = 'released' where artwork_id = $1 and state = 'confirmed'",
      [artworkId],
    );
    const after = await reconcileAvailability(d, artworkId);

    expect(after.artwork.status).toBe("published");
    expect(after.availability.availableUnits).toBe(2);
  });

  it("never reports a negative availability, and reports the overshoot separately", async () => {
    await createOrderHolds(database);
    const d = depsWithHolds(database.db);
    const artistId = await seedArtist(database.db);
    const artworkId = await publish(d, artistId, { inventoryType: "edition", stock: 2 });

    await hold(database.db, artworkId, "confirmed", 5);
    const { availability } = await reconcileAvailability(d, artworkId);
    const dashboard = await artistDashboard(d, artistId);

    expect(availability.availableUnits).toBe(0);
    expect(dashboard.listings[0]?.oversoldBy).toBe(3);
  });

  it("requires a production lead time for a made-to-order edition", async () => {
    await createOrderHolds(database);
    const d = depsWithHolds(database.db);
    const artistId = await seedArtist(database.db);
    const draft = await createDraft(d, artistId, {
      ...COMPLETE,
      inventoryType: "edition",
      stock: 5,
      madeToOrder: true,
    });

    await expect(publishArtwork(d, artistId, draft.id)).rejects.toMatchObject({
      details: { missing: ["productionLeadTimeDays"] },
    });

    const published = await publishArtwork(d, artistId, draft.id, { productionLeadTimeDays: 21 });
    expect(published.madeToOrder).toBe(true);
    expect(published.productionLeadTimeDays).toBe(21);
  });
});

describe("the listing lifecycle", () => {
  const database = useTestDatabase();

  /** artwork-listings: "Artist unlists an artwork". */
  it("removes an unlisted artwork from public view but keeps it on the dashboard", async () => {
    await createOrderHolds(database);
    const d = depsWithHolds(database.db);
    const artistId = await seedArtist(database.db);
    const artworkId = await publish(d, artistId);

    const unlisted = await unlistArtwork(d, artistId, artworkId);

    expect(unlisted.status).toBe("unlisted");
    const dashboard = await artistDashboard(d, artistId);
    expect(dashboard.listings.map((listing) => listing.id)).toEqual([artworkId]);
    expect(dashboard.listings[0]?.status).toBe("unlisted");
  });

  it("lets an artist relist what they unlisted", async () => {
    await createOrderHolds(database);
    const d = depsWithHolds(database.db);
    const artistId = await seedArtist(database.db);
    const artworkId = await publish(d, artistId);

    await unlistArtwork(d, artistId, artworkId);
    const relisted = await publishArtwork(d, artistId, artworkId);

    expect(relisted.status).toBe("published");
  });

  /** artwork-listings: "Artist attempts to republish a removed artwork". */
  it("refuses to republish an artwork an admin removed", async () => {
    await createOrderHolds(database);
    const d = depsWithHolds(database.db);
    const artistId = await seedArtist(database.db);
    const adminId = await seedAdmin(database);
    const artworkId = await publish(d, artistId);

    await removeArtwork(d, adminId, artworkId);

    await expect(publishArtwork(d, artistId, artworkId)).rejects.toMatchObject({
      kind: "conflict",
      code: "artworks.removed_is_terminal",
    });

    const after = await database.db.one<{ status: string }>(
      "select status from artworks where id = $1",
      [artworkId],
    );
    expect(after.status).toBe("removed");
  });

  it("refuses to edit a removed artwork back into acceptability", async () => {
    await createOrderHolds(database);
    const d = depsWithHolds(database.db);
    const artistId = await seedArtist(database.db);
    const adminId = await seedAdmin(database);
    const artworkId = await publish(d, artistId);
    await removeArtwork(d, adminId, artworkId);

    await expect(
      updateArtwork(d, artistId, artworkId, { title: "שם חדש לגמרי" }),
    ).rejects.toMatchObject({ code: "artworks.removed_is_terminal" });
  });

  it("returns not-found for a removed artwork on a buyer-facing read", async () => {
    await createOrderHolds(database);
    const d = depsWithHolds(database.db);
    const artistId = await seedArtist(database.db);
    const adminId = await seedAdmin(database);
    const artworkId = await publish(d, artistId);
    await removeArtwork(d, adminId, artworkId);

    await expect(findPublicArtwork(d, artworkId)).rejects.toMatchObject({ kind: "not_found" });
  });

  it("does not let an artist remove their own artwork", () => {
    // Removal is an admin action, so that "removed" keeps meaning "taken down
    // by the platform" -- which is what makes it terminal.
    const verdict = canTransition({ from: "published", to: "removed", by: "artist" });

    expect(verdict.permitted).toBe(false);
  });

  it("does not let an artist mark their own artwork sold", () => {
    const verdict = canTransition({ from: "published", to: "sold", by: "artist" });

    expect(verdict.permitted).toBe(false);
  });

  it("keeps removed terminal even for an admin", () => {
    expect(canTransition({ from: "removed", to: "published", by: "admin" }).permitted).toBe(false);
    expect(canTransition({ from: "removed", to: "unlisted", by: "admin" }).permitted).toBe(false);
  });

  it("treats publishing an already-published artwork as a no-op rather than an error", async () => {
    await createOrderHolds(database);
    const d = depsWithHolds(database.db);
    const artistId = await seedArtist(database.db);
    const artworkId = await publish(d, artistId);

    const first = await findOwnArtwork(d, artistId, artworkId);
    const again = await publishArtwork(d, artistId, artworkId);

    expect(again.status).toBe("published");
    expect(again.publishedAt).toBe(first.artwork.publishedAt);
  });
});

describe("an artwork reserved by an in-progress order", () => {
  const database = useTestDatabase();

  /** artwork-listings: "Artwork with a pending order cannot be unlisted". */
  it("cannot be unlisted, and the refusal explains that the order must resolve", async () => {
    await createOrderHolds(database);
    const d = depsWithHolds(database.db);
    const artistId = await seedArtist(database.db);
    const artworkId = await publish(d, artistId, { inventoryType: "unique" });

    await hold(database.db, artworkId, "held");

    const error = await unlistArtwork(d, artistId, artworkId).catch((caught: unknown) => caught);

    expect(error).toMatchObject({
      kind: "conflict",
      code: "artworks.reserved_by_order_in_progress",
      details: { reservedUnits: 1 },
    });
    expect((error as Error).message).toMatch(/completes or expires/);

    const after = await database.db.one<{ status: string }>(
      "select status from artworks where id = $1",
      [artworkId],
    );
    expect(after.status).toBe("published");
  });

  it("cannot be taken back to draft either, since that also pulls it from the catalog", async () => {
    await createOrderHolds(database);
    const d = depsWithHolds(database.db);
    const artistId = await seedArtist(database.db);
    const artworkId = await publish(d, artistId, { inventoryType: "unique" });
    await hold(database.db, artworkId, "held");

    await expect(returnToDraft(d, artistId, artworkId)).rejects.toMatchObject({
      code: "artworks.reserved_by_order_in_progress",
    });
  });

  it("can be unlisted once the reservation is released", async () => {
    await createOrderHolds(database);
    const d = depsWithHolds(database.db);
    const artistId = await seedArtist(database.db);
    const artworkId = await publish(d, artistId, { inventoryType: "unique" });
    await hold(database.db, artworkId, "held");

    await expect(unlistArtwork(d, artistId, artworkId)).rejects.toMatchObject({ kind: "conflict" });

    await database.db.query("update test_order_holds set state = 'released' where artwork_id = $1", [
      artworkId,
    ]);

    expect((await unlistArtwork(d, artistId, artworkId)).status).toBe("unlisted");
  });

  /**
   * An admin takedown is deliberately NOT blocked by a reservation.
   *
   * moderation-admin: takedown "SHALL NOT affect orders already placed for that
   * artwork". The asymmetry is the point -- an artist may not pull a listing
   * out from under a buyer mid-checkout, and an admin removing stolen work
   * must be able to regardless.
   */
  it("can still be removed by an admin", async () => {
    await createOrderHolds(database);
    const d = depsWithHolds(database.db);
    const artistId = await seedArtist(database.db);
    const adminId = await seedAdmin(database);
    const artworkId = await publish(d, artistId, { inventoryType: "unique" });
    await hold(database.db, artworkId, "held");

    const removed = await removeArtwork(d, adminId, artworkId);

    expect(removed.status).toBe("removed");
    const holds = await database.db.query("select id from test_order_holds where state = 'held'");
    expect(holds.rows).toHaveLength(1);
  });

  /**
   * The lock, raced for real.
   *
   * A reservation is created under the artwork row lock (SECURITY.md S0-4), and
   * `unlistArtwork` takes the same lock before reading demand. Without it, an
   * unlist and a checkout that begin at the same moment both read "nothing
   * reserved" and both succeed -- and a buyer has paid for an artwork that is
   * no longer listed.
   *
   * Two genuine connections, no `sleep`: the test waits for the ungranted lock
   * to appear in `pg_locks`, which is the actual condition it needs, rather
   * than guessing at a duration.
   */
  it("makes an unlist wait for an in-flight reservation rather than racing it", async () => {
    await createOrderHolds(database);
    const d = depsWithHolds(database.db);
    const artistId = await seedArtist(database.db);
    const artworkId = await publish(d, artistId, { inventoryType: "unique" });

    let releaseReservation: () => void = () => {};
    const reservationCommitted = new Promise<void>((resolve) => {
      releaseReservation = resolve;
    });
    let reservationHeld: () => void = () => {};
    const lockTaken = new Promise<void>((resolve) => {
      reservationHeld = resolve;
    });

    // Connection A: behaves exactly as `orders` will -- lock the artwork row
    // first, then write the reservation, then commit.
    const checkout = database.db.withTransaction(async (tx) => {
      await lockArtworkForUpdate(tx, artworkId);
      await tx.query("insert into test_order_holds (artwork_id, units, state) values ($1, 1, 'held')", [
        artworkId,
      ]);
      reservationHeld();
      await reservationCommitted;
    });

    await lockTaken;

    // Connection B: the artist tries to withdraw the listing at the same moment.
    const unlisting = unlistArtwork(d, artistId, artworkId);

    // Wait for B to actually be blocked on A's row lock. This is the assertion
    // that the lock is doing something: if `unlistArtwork` did not take it,
    // nothing would ever be waiting and this would time out.
    await waitForBlockedLock(database.db);

    releaseReservation();
    await checkout;

    await expect(unlisting).rejects.toMatchObject({
      code: "artworks.reserved_by_order_in_progress",
    });

    const after = await database.db.one<{ status: string }>(
      "select status from artworks where id = $1",
      [artworkId],
    );
    expect(after.status).toBe("published");
  });
});

/**
 * Resolve once some session is waiting on an ungranted lock.
 *
 * Polls a real condition rather than sleeping for a guessed interval
 * (TESTING.md: "If a test needs to wait for something, wait for the
 * something"). The loop is bounded so a genuine failure surfaces as a clear
 * error instead of hanging until the suite timeout.
 */
async function waitForBlockedLock(db: Database): Promise<void> {
  for (let attempt = 0; attempt < 600; attempt += 1) {
    const row = await db.one<{ waiting: string }>(
      "select count(*)::text as waiting from pg_locks where not granted",
    );
    if (Number(row.waiting) > 0) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error(
    "No session ever blocked on a lock. unlistArtwork is not taking the artwork row lock, " +
      "so an unlist and a checkout can race (SECURITY.md S0-4).",
  );
}

describe("the artist dashboard", () => {
  const database = useTestDatabase();

  it("shows state, price, declared stock, derived availability and match impressions", async () => {
    await createOrderHolds(database);
    const artistId = await seedArtist(database.db);

    // A real impression source over a real table, the way `matchmaker` will
    // supply one. Nothing is asserted about it having been called; the
    // assertion is on the number that reaches the dashboard.
    await defineScratchTable(
      database,
      "test_match_impressions",
      "create table test_match_impressions (artwork_id uuid not null, shown_at timestamptz not null default now())",
    );
    const impressions: ImpressionSource = {
      async countsFor(sql, artworkIds) {
        const { rows } = await sql.query<{ artwork_id: string; total: string }>(
          `select artwork_id, count(*)::text as total from test_match_impressions
            where artwork_id = any($1::uuid[]) group by artwork_id`,
          [artworkIds],
        );
        return new Map(rows.map((row) => [row.artwork_id, Number(row.total)] as const));
      },
    };

    const d = depsWithHolds(database.db, impressions);
    const artworkId = await publish(d, artistId, { inventoryType: "edition", stock: 10 });
    await hold(database.db, artworkId, "confirmed", 2);
    await hold(database.db, artworkId, "held", 1);
    await database.db.query(
      "insert into test_match_impressions (artwork_id) select $1 from generate_series(1, 7)",
      [artworkId],
    );

    const dashboard = await artistDashboard(d, artistId);
    const listing = dashboard.listings[0];

    expect(listing?.status).toBe("published");
    expect(listing?.priceFormatted).toBe("₪1,250.00");
    expect(listing?.stock).toBe(10);
    expect(listing?.soldUnits).toBe(2);
    expect(listing?.reservedUnits).toBe(1);
    expect(listing?.availableUnits).toBe(7);
    expect(listing?.matchImpressions).toBe(7);
    expect(dashboard.summary.totalMatchImpressions).toBe(7);
  });

  it("lists drafts and unlisted artworks before published ones", async () => {
    await createOrderHolds(database);
    const d = depsWithHolds(database.db);
    const artistId = await seedArtist(database.db);

    const publishedId = await publish(d, artistId);
    const draft = await createDraft(d, artistId, { title: "טיוטה" });
    const toUnlist = await publish(d, artistId);
    await unlistArtwork(d, artistId, toUnlist);

    const dashboard = await artistDashboard(d, artistId);

    expect(dashboard.listings.map((listing) => listing.id)).toEqual([
      draft.id,
      toUnlist,
      publishedId,
    ]);
    expect(dashboard.summary.byStatus).toMatchObject({ draft: 1, published: 1, unlisted: 1 });
  });

  it("shows only the asking artist's own listings", async () => {
    await createOrderHolds(database);
    const d = depsWithHolds(database.db);
    const mine = await seedArtist(database.db);
    const theirs = await seedArtist(database.db);
    const myArtwork = await publish(d, mine);
    await publish(d, theirs);

    const dashboard = await artistDashboard(d, mine);

    expect(dashboard.listings.map((listing) => listing.id)).toEqual([myArtwork]);
  });

  it("offers the actions the state machine permits, and no others", async () => {
    await createOrderHolds(database);
    const d = depsWithHolds(database.db);
    const artistId = await seedArtist(database.db);
    await publish(d, artistId);

    const dashboard = await artistDashboard(d, artistId);

    // Not `sold` and not `removed`: an artist sets neither.
    expect([...(dashboard.listings[0]?.availableActions ?? [])].sort()).toEqual([
      "draft",
      "unlisted",
    ]);
  });
});
