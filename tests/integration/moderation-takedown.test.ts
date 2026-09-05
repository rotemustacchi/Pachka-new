/**
 * Artwork takedown.
 *
 * moderation-admin, "Artwork takedown": an admin moves any artwork to
 * `removed`, which immediately withdraws it from the catalog, the matchmaker
 * and the artist's ability to republish; the artist is notified with the
 * reason; and orders already placed are NOT affected.
 *
 * THE IN-FLIGHT ORDER
 * -------------------
 * `orders` has not shipped, so there is no `reservations` table and no
 * `orders` table to leave alone. What this file does instead is what pass 1 did
 * for payouts: take the port the owning module will implement -- here
 * `InventoryDemandSource`, which `artworks` already defines and exports for
 * exactly this purpose -- back it with a real table in this test's own
 * throwaway database, and assert against real rows.
 *
 * THE ARTIST'S NOTICE IS DESCRIBED HERE, NOT SENT
 * ----------------------------------------------
 * There used to be a `FakeMailer` in this file. `takeDownArtwork` returns the
 * artist's notice as a `NotificationRequest` and sends nothing, so what is
 * asserted below is the descriptor -- who it is for, and that it carries the
 * reporter's label rather than the enum. That the takedown STANDS when the
 * artist cannot be told is now structural rather than defended: there is no
 * send on this path to fail. What happens to the message afterwards, including
 * an artist with no address on file, is `tests/integration/mail-delivery.test.ts`.
 *
 * That makes the assertion meaningful rather than decorative. "Takedown does
 * not affect orders" is proved by showing the reservation rows are byte-for-byte
 * unchanged afterwards, that the derived availability still counts the order,
 * and that the buyer's row is still there to be fulfilled. When `orders` ships
 * and supplies the real implementation, the same assertions hold against it.
 */
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  asAnon,
  defineGuardedScratchTable,
  grantAdminRole,
  useTestDatabase,
  type TestDatabase,
} from "../harness";
import { FakeAuthGateway } from "../fakes/auth-gateway";
import {
  canTransition,
  isPubliclyVisible,
  publishArtwork,
  type InventoryDemand,
  type InventoryDemandSource,
} from "@/modules/artworks";
import {
  readAuditTrail,
  takeDownArtwork,
  verifyAuditChain,
  type ModerationDeps,
} from "@/modules/moderation";
import type { Database, Sql } from "@/shared/db";

async function seedAccount(
  database: TestDatabase,
  roles: readonly string[],
  name: string,
): Promise<string> {
  const db = database.db;
  const { rows } = await db.query<{ user_id: string }>(
    "insert into profiles (user_id, display_name) values (gen_random_uuid(), $1) returning user_id",
    [name],
  );
  const id = rows[0]!.user_id;
  await db.query("insert into account_status (user_id, verified_at) values ($1, now())", [id]);
  for (const role of roles) {
    // `admin` is not grantable through the application (SECURITY.md S0-2 item
    // 4), and `user_roles_server_insert` enforces that, so it is seeded the way
    // an operator would grant it: out of band, with database credentials.
    if (role === "admin") await grantAdminRole(database, id);
    else await db.query("insert into user_roles (user_id, role) values ($1, $2)", [id, role]);
  }
  return id;
}

async function seedArtist(database: TestDatabase, name = "Noa B.", email = "noa@example.com") {
  const db = database.db;
  const id = await seedAccount(database, ["buyer", "artist"], name);
  await db.query("insert into artist_profiles (user_id, display_name) values ($1, $2)", [id, name]);
  await db.query("insert into artist_contact_details (user_id, email) values ($1, $2)", [
    id,
    email,
  ]);
  return id;
}

/**
 * A complete published artwork.
 *
 * `artworks_published_is_complete` refuses a published row with any mandatory
 * field missing, and the taxonomy columns are closed sets. Seeding the whole
 * thing honestly is the price of testing against the real constraints instead
 * of a relaxed copy of them.
 */
async function seedPublishedArtwork(database: TestDatabase, artistId: string, title = "Night Market") {
  const db = database.db;
  const { rows } = await db.query<{ id: string }>(
    `insert into artworks (
       artist_id, status, title, description, price_agorot,
       height_mm, width_mm, weight_grams, materials, lead_time_days,
       medium, styles, moods, is_framed,
       originality_declared_by, originality_declared_at, ai_assisted, published_at
     ) values (
       $1, 'published', $2, 'Lantern light over the stalls.', 210000,
       500, 700, 2400, 'Oil on linen', 7,
       'painting_illustration', array['modern_industrial']::text[], array['bold']::text[], true,
       $1, now(), false, now()
     ) returning id`,
    [artistId, title],
  );
  return rows[0]!.id;
}

function depsFor(db: Database): { deps: ModerationDeps } {
  return { deps: { db, auth: new FakeAuthGateway() } };
}

// ---------------------------------------------------------------------------
// A real stand-in for the orders module's reservations.
// ---------------------------------------------------------------------------

interface StandInOrders {
  readonly source: InventoryDemandSource;
  placePaidOrder(artworkId: string, buyerId: string): Promise<string>;
  snapshot(artworkId: string): Promise<Array<Record<string, unknown>>>;
}

async function createStandInOrders(database: TestDatabase): Promise<StandInOrders> {
  await defineGuardedScratchTable(
    database,
    "stand_in_reservations",
    `create table stand_in_reservations (
      id         uuid primary key default gen_random_uuid(),
      artwork_id uuid not null references artworks (id),
      buyer_id   uuid not null references profiles (user_id),
      units      integer not null default 1,
      state      text not null,
      created_at timestamptz not null default now()
    )`,
  );
  const db = database.db;

  const demandFor = async (sql: Sql, artworkId: string): Promise<InventoryDemand> => {
    const row = await sql.one<{ reserved: string; sold: string }>(
      `select
         coalesce(sum(units) filter (where state = 'reserved'), 0)::text as reserved,
         coalesce(sum(units) filter (where state = 'paid'), 0)::text     as sold
       from stand_in_reservations where artwork_id = $1`,
      [artworkId],
    );
    return { reservedUnits: Number(row.reserved), soldUnits: Number(row.sold) };
  };

  return {
    source: {
      demandFor,
      async demandForMany(sql, artworkIds) {
        const entries = await Promise.all(
          artworkIds.map(async (id) => [id, await demandFor(sql, id)] as const),
        );
        return new Map(entries);
      },
    },
    async placePaidOrder(artworkId, buyerId) {
      const { rows } = await db.query<{ id: string }>(
        `insert into stand_in_reservations (artwork_id, buyer_id, state)
         values ($1, $2, 'paid') returning id`,
        [artworkId, buyerId],
      );
      return rows[0]!.id;
    },
    async snapshot(artworkId) {
      const { rows } = await db.query<Record<string, unknown>>(
        "select * from stand_in_reservations where artwork_id = $1 order by id",
        [artworkId],
      );
      return rows;
    },
  };
}

// ---------------------------------------------------------------------------

describe("an admin removing an artwork", () => {
  const database = useTestDatabase();

  it("moves it to removed and takes it off every public surface", async () => {
    const adminId = await seedAccount(database, ["admin"], "Admin A.");
    const artistId = await seedArtist(database);
    const artworkId = await seedPublishedArtwork(database, artistId);
    const { deps } = depsFor(database.db);

    // Visible before, on the surface that actually matters: the data API an
    // anonymous visitor reaches with the key from the browser bundle.
    const before = await asAnon(database.dataApi, async (tx) =>
      (await tx.query("select id from artworks where id = $1", [artworkId])).rows,
    );
    expect(before).toHaveLength(1);
    expect(await isPubliclyVisible(database.db, artworkId)).toBe(true);

    const result = await takeDownArtwork(deps, {
      actorId: adminId,
      artworkId,
      reason: "not_original_work",
      note: "Matches a stock photograph.",
    });

    expect(result.artwork.status).toBe("removed");

    const row = await database.db.one<{ status: string }>(
      "select status from artworks where id = $1",
      [artworkId],
    );
    expect(row.status).toBe("removed");

    // Gone from the data API, gone from the catalog and the matchmaker, which
    // both read through the same visibility predicate.
    const after = await asAnon(database.dataApi, async (tx) =>
      (await tx.query("select id from artworks where id = $1", [artworkId])).rows,
    );
    expect(after).toEqual([]);
    expect(await isPubliclyVisible(database.db, artworkId)).toBe(false);
  });

  it("notifies the artist with the reason", async () => {
    const adminId = await seedAccount(database, ["admin"], "Admin B.");
    const artistId = await seedArtist(database, "Dana P.", "dana@example.com");
    const artworkId = await seedPublishedArtwork(database, artistId, "Quiet Harbour");
    const { deps } = depsFor(database.db);

    const result = await takeDownArtwork(deps, {
      actorId: adminId,
      artworkId,
      reason: "undeclared_ai",
    });

    expect(result.notifications).toEqual([
      {
        audience: "artist",
        template: "moderation.artwork_taken_down",
        // The artist's ACCOUNT, not their address. `dana@example.com` is on
        // file and this module still does not read it -- the private
        // `artist_contact_details` row is the address book's to resolve.
        recipientId: artistId,
        data: {
          artworkId,
          artworkTitle: "Quiet Harbour",
          reason: "undeclared_ai",
          // The artist reads the words the reporter chose from, not the enum.
          reasonLabel: "Undeclared AI generation",
        },
      },
    ]);
    expect(JSON.stringify(result.notifications)).not.toContain("dana@example.com");
  });

  it("carries free text through as the reason when it is not one of the set", async () => {
    const adminId = await seedAccount(database, ["admin"], "Admin B2.");
    const artistId = await seedArtist(database, "Noa R.", "noa@example.com");
    const artworkId = await seedPublishedArtwork(database, artistId, "Harbour II");

    const result = await takeDownArtwork(depsFor(database.db).deps, {
      actorId: adminId,
      artworkId,
      reason: "Sold as an original on three other marketplaces",
    });

    expect(result.notifications[0]!.data).toMatchObject({
      reason: "Sold as an original on three other marketplaces",
      reasonLabel: "Sold as an original on three other marketplaces",
    });
  });

  it("stands even when the artist cannot be emailed", async () => {
    // Structural now: the takedown commits and this function returns before
    // anything is sent, so there is no delivery failure that could reach it.
    // The artist below has no contact row at all, which is the case that used
    // to produce `artistNotified: false`.
    const adminId = await seedAccount(database, ["admin"], "Admin C.");
    const artistId = await seedArtist(database);
    const artworkId = await seedPublishedArtwork(database, artistId);
    const { deps } = depsFor(database.db);

    const result = await takeDownArtwork(deps, {
      actorId: adminId,
      artworkId,
      reason: "offensive_content",
    });

    // The notice is still described. Whether it can be delivered is a question
    // for the address book, and a takedown does not wait for the answer.
    expect(result.notifications).toHaveLength(1);
    expect(result.notifications[0]!.recipientId).toBe(artistId);

    // The takedown is the thing that had to survive.
    const row = await database.db.one<{ status: string }>(
      "select status from artworks where id = $1",
      [artworkId],
    );
    expect(row.status).toBe("removed");
    expect(await readAuditTrail(database.db, { action: "artwork_takedown" })).toHaveLength(1);
  });

  it("records an audit entry naming the actor, the artwork, and the reason", async () => {
    const adminId = await seedAccount(database, ["admin"], "Admin D.");
    const artistId = await seedArtist(database);
    const artworkId = await seedPublishedArtwork(database, artistId);
    const { deps } = depsFor(database.db);

    const result = await takeDownArtwork(deps, {
      actorId: adminId,
      artworkId,
      reason: "mass_produced",
      note: "Sold in bulk on another marketplace.",
    });

    const trail = await readAuditTrail(database.db, { targetType: "artwork" });
    expect(trail).toHaveLength(1);
    expect(trail[0]).toMatchObject({
      action: "artwork_takedown",
      actor: adminId,
      targetId: artworkId,
      note: "Sold in bulk on another marketplace.",
    });
    expect(trail[0]!.details).toMatchObject({
      reason: "mass_produced",
      artist_id: artistId,
    });
    expect(trail[0]!.id).toBe(result.audit.id);
    expect(await verifyAuditChain(database.db)).toMatchObject({ ok: true });
  });
});

describe("a removed artwork", () => {
  const database = useTestDatabase();

  it("cannot be republished by its artist", async () => {
    const adminId = await seedAccount(database, ["admin"], "Admin E.");
    const artistId = await seedArtist(database);
    const artworkId = await seedPublishedArtwork(database, artistId);
    const { deps } = depsFor(database.db);

    await takeDownArtwork(deps, { actorId: adminId, artworkId, reason: "not_original_work" });

    await expect(
      publishArtwork(
        { db: database.db, demand: noDemandForTest, impressions: noImpressionsForTest },
        artistId,
        artworkId,
      ),
    ).rejects.toThrow();

    const row = await database.db.one<{ status: string }>(
      "select status from artworks where id = $1",
      [artworkId],
    );
    expect(row.status).toBe("removed");
  });

  it("cannot be moved back by an admin either, which is what suspension-lift depends on", async () => {
    // ARCHITECTURE.md: "`removed` is terminal for every role, admins included."
    // Lifting a suspension restores previously published artworks "excluding any
    // individually removed", and that phrase only has a stable meaning if
    // removal is one-way.
    for (const by of ["admin", "artist", "system"] as const) {
      for (const to of ["published", "draft", "unlisted", "sold"] as const) {
        expect(
          canTransition({ from: "removed", to, by }),
          `removed -> ${to} by ${by} must be refused`,
        ).toMatchObject({ permitted: false });
      }
    }

    // And it is refused for the stated reason, not incidentally.
    expect(canTransition({ from: "removed", to: "published", by: "admin" })).toMatchObject({
      permitted: false,
      code: "artworks.removed_is_terminal",
    });

    // Positive control, so the loop above cannot be passing because
    // `canTransition` refuses everything.
    expect(canTransition({ from: "published", to: "removed", by: "admin" })).toMatchObject({
      permitted: true,
    });
  });

  it("survives a suspension being lifted, unlike the artist's other work", async () => {
    // The two rules meeting: reinstatement restores visibility by derivation,
    // and a removed artwork stays out because its own status keeps it out.
    const adminId = await seedAccount(database, ["admin"], "Admin F.");
    const artistId = await seedArtist(database);
    const kept = await seedPublishedArtwork(database, artistId, "Kept");
    const removed = await seedPublishedArtwork(database, artistId, "Removed");
    const { deps } = depsFor(database.db);

    await takeDownArtwork(deps, {
      actorId: adminId,
      artworkId: removed,
      reason: "not_original_work",
    });

    const { suspendAccount, reinstateAccount } = await import("@/modules/moderation");
    await suspendAccount(deps, { actorId: adminId, userId: artistId, reason: "Under review" });
    expect(await isPubliclyVisible(database.db, kept)).toBe(false);

    await reinstateAccount(deps, { actorId: adminId, userId: artistId });

    expect(await isPubliclyVisible(database.db, kept)).toBe(true);
    expect(await isPubliclyVisible(database.db, removed)).toBe(false);
  });
});

describe("takedowns that must be refused", () => {
  const database = useTestDatabase();

  it("refuses a non-admin, with not-found, and changes nothing", async () => {
    const adminId = await seedAccount(database, ["admin"], "Admin G.");
    const buyerId = await seedAccount(database, ["buyer"], "Buyer H.");
    const artistId = await seedArtist(database);
    const artworkId = await seedPublishedArtwork(database, artistId);
    const { deps } = depsFor(database.db);

    await expect(
      takeDownArtwork(deps, { actorId: buyerId, artworkId, reason: "offensive_content" }),
    ).rejects.toMatchObject({ kind: "not_found" });

    const row = await database.db.one<{ status: string }>(
      "select status from artworks where id = $1",
      [artworkId],
    );
    expect(row.status).toBe("published");
    expect(await readAuditTrail(database.db)).toEqual([]);

    // Positive control: the identical call by an admin works, and only then is
    // there a notice at all -- a refused takedown describes nothing.
    const allowed = await takeDownArtwork(deps, {
      actorId: adminId,
      artworkId,
      reason: "offensive_content",
    });
    expect(allowed.artwork.status).toBe("removed");
    expect(allowed.notifications).toHaveLength(1);
    await expect(
      takeDownArtwork(deps, { actorId: adminId, artworkId, reason: "offensive_content" }),
    ).resolves.toMatchObject({ artwork: { status: "removed" } });
  });

  it("refuses the artist trying to take down their own rival's work", async () => {
    const artistId = await seedArtist(database, "Artist I.", "i@example.com");
    const rivalId = await seedArtist(database, "Artist J.", "j@example.com");
    const artworkId = await seedPublishedArtwork(database, rivalId);
    const { deps } = depsFor(database.db);

    await expect(
      takeDownArtwork(deps, { actorId: artistId, artworkId, reason: "not_original_work" }),
    ).rejects.toMatchObject({ kind: "not_found" });

    const row = await database.db.one<{ status: string }>(
      "select status from artworks where id = $1",
      [artworkId],
    );
    expect(row.status).toBe("published");
  });

  it("refuses a takedown with no stated reason", async () => {
    const adminId = await seedAccount(database, ["admin"], "Admin K.");
    const artistId = await seedArtist(database);
    const artworkId = await seedPublishedArtwork(database, artistId);
    const { deps } = depsFor(database.db);

    for (const reason of ["", "   "]) {
      await expect(
        takeDownArtwork(deps, { actorId: adminId, artworkId, reason }),
      ).rejects.toMatchObject({ kind: "validation" });
    }

    const row = await database.db.one<{ status: string }>(
      "select status from artworks where id = $1",
      [artworkId],
    );
    expect(row.status).toBe("published");
    expect(await readAuditTrail(database.db)).toEqual([]);
  });

  it("refuses an artwork that does not exist", async () => {
    const adminId = await seedAccount(database, ["admin"], "Admin L.");
    const { deps } = depsFor(database.db);

    await expect(
      takeDownArtwork(deps, { actorId: adminId, artworkId: randomUUID(), reason: "other" }),
    ).rejects.toMatchObject({ kind: "not_found" });
  });

  it("does not take the artwork down when its audit entry fails", async () => {
    // The coupling again, on the third action that uses it. `admin_audit.note`
    // is bounded at 2000 characters, so an over-long operator note fails the
    // audit insert after `removeArtwork` has already written the status.
    const adminId = await seedAccount(database, ["admin"], "Admin M.");
    const artistId = await seedArtist(database);
    const artworkId = await seedPublishedArtwork(database, artistId);
    const { deps } = depsFor(database.db);

    await expect(
      takeDownArtwork(deps, {
        actorId: adminId,
        artworkId,
        reason: "not_original_work",
        note: "n".repeat(2001),
      }),
    ).rejects.toThrow();

    const row = await database.db.one<{ status: string }>(
      "select status from artworks where id = $1",
      [artworkId],
    );
    expect(row.status).toBe("published");
    expect(await readAuditTrail(database.db)).toEqual([]);
  });
});

describe("an artwork with an order already placed", () => {
  const database = useTestDatabase();

  it("is removed without touching the order", async () => {
    // "An admin removes an artwork that has a paid but undelivered order ->
    // the existing order continues through its lifecycle unaffected."
    const adminId = await seedAccount(database, ["admin"], "Admin N.");
    const artistId = await seedArtist(database);
    const buyerId = await seedAccount(database, ["buyer"], "Buyer O.");
    const artworkId = await seedPublishedArtwork(database, artistId);
    const orders = await createStandInOrders(database);
    const orderId = await orders.placePaidOrder(artworkId, buyerId);

    const before = await orders.snapshot(artworkId);
    const demandBefore = await orders.source.demandFor(database.db, artworkId);
    expect(demandBefore).toEqual({ reservedUnits: 0, soldUnits: 1 });

    const { deps } = depsFor(database.db);
    await takeDownArtwork(
      {
        ...deps,
        // The orders module's implementation, as it will be supplied in
        // production once `orders` ships.
        artworks: { db: database.db, demand: orders.source, impressions: noImpressionsForTest },
      },
      { actorId: adminId, artworkId, reason: "not_original_work" },
    );

    // The artwork is gone from public view...
    expect(await isPubliclyVisible(database.db, artworkId)).toBe(false);

    // ...and the order is exactly as it was. Not cancelled, not released, not
    // re-stated: the same rows, byte for byte.
    const after = await orders.snapshot(artworkId);
    expect(after).toEqual(before);
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({ id: orderId, buyer_id: buyerId, state: "paid" });

    // The derived availability still counts the sale, so nothing downstream
    // thinks the unit came back.
    expect(await orders.source.demandFor(database.db, artworkId)).toEqual(demandBefore);
  });

  it("leaves a reservation mid-checkout alone too", async () => {
    const adminId = await seedAccount(database, ["admin"], "Admin P.");
    const artistId = await seedArtist(database);
    const buyerId = await seedAccount(database, ["buyer"], "Buyer Q.");
    const artworkId = await seedPublishedArtwork(database, artistId);
    const orders = await createStandInOrders(database);

    await database.db.query(
      `insert into stand_in_reservations (artwork_id, buyer_id, state)
       values ($1, $2, 'reserved')`,
      [artworkId, buyerId],
    );
    const before = await orders.snapshot(artworkId);

    const { deps } = depsFor(database.db);
    await takeDownArtwork(
      {
        ...deps,
        artworks: { db: database.db, demand: orders.source, impressions: noImpressionsForTest },
      },
      { actorId: adminId, artworkId, reason: "offensive_content" },
    );

    expect(await orders.snapshot(artworkId)).toEqual(before);
    expect(await orders.source.demandFor(database.db, artworkId)).toEqual({
      reservedUnits: 1,
      soldUnits: 0,
    });
  });
});

// Local stand-ins for the two ports `artworks` takes, used where the test is
// not about either of them. Named here rather than imported so that a reader
// can see there is nothing behind them.
const noDemandForTest: InventoryDemandSource = {
  demandFor: async () => ({ reservedUnits: 0, soldUnits: 0 }),
  demandForMany: async (_sql, ids) =>
    new Map(ids.map((id) => [id, { reservedUnits: 0, soldUnits: 0 }] as const)),
};

const noImpressionsForTest = {
  countsFor: async (_sql: Sql, ids: readonly string[]) => new Map(ids.map((id) => [id, 0] as const)),
};
