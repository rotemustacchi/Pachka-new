/**
 * That the ledger is append-only for real, and that a correction appends.
 *
 * `artist-payouts`, *Correction recorded*: "WHEN an operator corrects an amount
 * THEN the system appends an adjusting entry referencing the original and does
 * not modify it."
 *
 * "Does not modify it" is a claim about the database, not about this module's
 * code, so most of this file attacks the table directly rather than through the
 * module. Three attackers, in increasing order of privilege:
 *
 *   1. The data API -- anon and authenticated, holding the anon key that ships
 *      in the browser bundle. Stopped by revoked grants and by a read policy
 *      that names a concrete subject.
 *   2. The application's own role, a member of `service_role`. This is the one
 *      that matters most: it is what every route runs as, it carries the
 *      privileges an attacker gets by executing application code, and it has
 *      no UPDATE or DELETE grant on this table at all.
 *   3. The database owner. Stopped by a trigger, because grants cannot stop
 *      them -- the same argument `moderation` makes for `admin_audit`, which is
 *      why the harness's privileged-connection hatch names exactly this threat.
 *
 * ARCHITECTURE.md: "revoked grants plus a trigger, not application convention."
 * A test that only drove `recordCorrection` and asserted a second row appeared
 * would pass just as well against a module that politely chose not to UPDATE.
 */
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  asAnon,
  asUser,
  grantAdminRole,
  useTestDatabase,
  withPrivilegedConnection,
  type TestDatabase,
} from "../harness";
import type { Database, Sql } from "@/shared/db";
import { recordAdminAction, requireAdmin } from "@/modules/moderation";
import {
  ledgerHistoryFor,
  recordCorrection,
  recordFulfilmentPaid,
  artistPayouts,
  type AdminActionPort,
  type PayoutsDeps,
} from "@/modules/payouts";

/**
 * The wiring the composition root owes this module.
 *
 * `payouts` has no dependency edge to `moderation` (ARCHITECTURE.md's table), so
 * the module declares `AdminActionPort` and cannot implement it. This is the
 * implementation, written where a test may legitimately import both, and it is
 * exactly the adapter the lead architect should land in `app/`.
 *
 * The `set_config` line is not incidental. `admin_audit`'s chain trigger stamps
 * the actor from `auth.uid()` and refuses an entry with no acting identity in
 * the session, so publishing the authorised admin is half of what `authorise`
 * means. `moderation.withAdminAction` does the same thing for its own callers.
 */
function moderationAdmin(): AdminActionPort {
  return {
    async authorise(sql: Sql, userId: string | null | undefined) {
      const actor = await requireAdmin(sql, userId);
      await sql.query("select set_config('request.jwt.claim.sub', $1, true)", [actor.userId]);
      return actor;
    },
    async record(sql: Sql, entry) {
      return recordAdminAction(sql, entry);
    },
  };
}

function deps(database: TestDatabase): PayoutsDeps {
  return { db: database.db, admin: moderationAdmin() };
}

async function seedArtist(db: Database, name = "יעל"): Promise<string> {
  const id = randomUUID();
  await db.query("insert into profiles (user_id, display_name) values ($1, $2)", [id, name]);
  await db.query("insert into account_status (user_id, verified_at) values ($1, now())", [id]);
  await db.query("insert into user_roles (user_id, role) values ($1, 'artist')", [id]);
  await db.query("insert into artist_profiles (user_id, display_name) values ($1, $2)", [id, name]);
  return id;
}

async function seedBuyer(db: Database): Promise<string> {
  const id = randomUUID();
  await db.query("insert into profiles (user_id, display_name) values ($1, 'דנה')", [id]);
  await db.query("insert into account_status (user_id, verified_at) values ($1, now())", [id]);
  return id;
}

async function seedOperator(database: TestDatabase): Promise<string> {
  const id = randomUUID();
  await database.db.query("insert into profiles (user_id, display_name) values ($1, 'מנהלת')", [id]);
  await database.db.query("insert into account_status (user_id, verified_at) values ($1, now())", [id]);
  // SECURITY.md S0-2 item 4 puts granting `admin` outside the application.
  await grantAdminRole(database, id);
  return id;
}

async function seedSale(
  db: Database,
  artistId: string,
  buyerId: string,
  subtotal = 100_000,
  hoursAgo = 20 * 24,
): Promise<{ orderId: string; fulfilmentId: string }> {
  const order = await db.one<{ id: string }>(
    `insert into orders
       (buyer_id, status, subtotal_agorot, shipping_agorot, total_agorot, commission_rate_bp)
     values ($1, 'delivered', $2, 5000, $3, 1500) returning id`,
    [buyerId, subtotal, subtotal + 5_000],
  );
  const fulfilment = await db.one<{ id: string }>(
    `insert into fulfilments
       (order_id, artist_id, status, items_subtotal_agorot, shipping_agorot, delivered_at)
     values ($1, $2, 'delivered', $3, 5000, now() - make_interval(hours => $4::int)) returning id`,
    [order.id, artistId, subtotal, hoursAgo],
  );
  await db.query(
    `insert into order_transitions
       (order_id, fulfilment_id, from_status, to_status, actor_id, actor_kind, occurred_at)
     values ($1, $2, 'shipped', 'delivered', $3, 'buyer', now() - make_interval(hours => $4::int))`,
    [order.id, fulfilment.id, buyerId, hoursAgo],
  );
  return { orderId: order.id, fulfilmentId: fulfilment.id };
}

describe("the application's own role", () => {
  const database = useTestDatabase();

  it("cannot update a ledger entry, because it holds no UPDATE privilege at all", async () => {
    // `database.db` is a member of `service_role` and is what every route runs
    // as. This is the privilege an attacker gets by executing application code,
    // which is the failure mode SECURITY.md S1-14 says a coding style does not
    // defend against.
    const artistId = await seedArtist(database.db);
    const buyerId = await seedBuyer(database.db);
    const sale = await seedSale(database.db, artistId, buyerId);
    const { entry } = await recordFulfilmentPaid(deps(database), sale.fulfilmentId);

    await expect(
      database.db.query("update payout_ledger set net_agorot = 999999 where id = $1", [entry.id]),
    ).rejects.toThrow(/permission denied/i);

    const after = await database.db.one<{ net_agorot: string }>(
      "select net_agorot from payout_ledger where id = $1",
      [entry.id],
    );
    expect(after.net_agorot).toBe("85000");
  });

  it("cannot delete one either", async () => {
    const artistId = await seedArtist(database.db);
    const buyerId = await seedBuyer(database.db);
    const sale = await seedSale(database.db, artistId, buyerId);
    const { entry } = await recordFulfilmentPaid(deps(database), sale.fulfilmentId);

    await expect(
      database.db.query("delete from payout_ledger where id = $1", [entry.id]),
    ).rejects.toThrow(/permission denied/i);

    const { rowCount } = await database.db.query("select 1 from payout_ledger where id = $1", [
      entry.id,
    ]);
    expect(rowCount).toBe(1);
  });

  it("can still insert, which is the one write this table takes", async () => {
    // The positive control. Without it, the two assertions above would pass just
    // as well against a table nobody can write at all -- which would be a broken
    // ledger, not a protected one.
    const artistId = await seedArtist(database.db);
    const buyerId = await seedBuyer(database.db);
    const sale = await seedSale(database.db, artistId, buyerId);

    const { created } = await recordFulfilmentPaid(deps(database), sale.fulfilmentId);
    expect(created).toBe(true);
  });
});

describe("an attacker holding the database owner's credentials", () => {
  const database = useTestDatabase();

  it("is refused by the trigger when they try to rewrite an amount", async () => {
    // Grants cannot stop the owner, so this is the layer that does. Same
    // argument `moderation` makes for admin_audit, with money attached.
    const artistId = await seedArtist(database.db);
    const buyerId = await seedBuyer(database.db);
    const sale = await seedSale(database.db, artistId, buyerId);
    const { entry } = await recordFulfilmentPaid(deps(database), sale.fulfilmentId);

    await expect(
      withPrivilegedConnection(
        database,
        "simulating an attacker who holds the database owner's credentials",
        (client) =>
          client.query("update payout_ledger set net_agorot = 999999 where id = $1", [entry.id]),
      ),
    ).rejects.toThrow(/append-only/i);

    const after = await database.db.one<{ net_agorot: string }>(
      "select net_agorot from payout_ledger where id = $1",
      [entry.id],
    );
    expect(after.net_agorot).toBe("85000");
  });

  it("is refused when they try to delete the evidence", async () => {
    const artistId = await seedArtist(database.db);
    const buyerId = await seedBuyer(database.db);
    const sale = await seedSale(database.db, artistId, buyerId);
    const { entry } = await recordFulfilmentPaid(deps(database), sale.fulfilmentId);

    await expect(
      withPrivilegedConnection(
        database,
        "simulating an attacker who holds the database owner's credentials",
        (client) => client.query("delete from payout_ledger where id = $1", [entry.id]),
      ),
    ).rejects.toThrow(/append-only/i);

    const { rowCount } = await database.db.query("select 1 from payout_ledger where id = $1", [
      entry.id,
    ]);
    expect(rowCount).toBe(1);
  });

  it("cannot write a row that invents money, because the arithmetic is a constraint", async () => {
    // `payout_ledger_conserves_money`. Not a unit test, not a comment: a CHECK,
    // so even the owner cannot land a row where commission + net <> gross.
    const artistId = await seedArtist(database.db);
    const buyerId = await seedBuyer(database.db);
    const sale = await seedSale(database.db, artistId, buyerId);

    await expect(
      withPrivilegedConnection(
        database,
        "simulating an attacker who holds the database owner's credentials",
        (client) =>
          client.query(
            `insert into payout_ledger
               (artist_id, fulfilment_id, order_id, entry_type,
                gross_agorot, commission_rate_bp, commission_agorot, net_agorot)
             values ($1, $2, $3, 'sale', 100000, 1500, 15000, 90000)`,
            [artistId, sale.fulfilmentId, sale.orderId],
          ),
      ),
    ).rejects.toThrow(/payout_ledger_conserves_money/i);
  });
});

describe("the data API", () => {
  const database = useTestDatabase();

  it("shows an anonymous visitor nothing, not even that a sale happened", async () => {
    const artistId = await seedArtist(database.db);
    const buyerId = await seedBuyer(database.db);
    const sale = await seedSale(database.db, artistId, buyerId);
    await recordFulfilmentPaid(deps(database), sale.fulfilmentId);

    await expect(
      asAnon(database.dataApi, (tx) => tx.query("select * from payout_ledger")),
    ).rejects.toThrow(/permission denied/i);
  });

  it("shows an artist their own revenue and none of anybody else's", async () => {
    // SECURITY.md S1-18: "on `payout_ledger` [a permissive policy] exposes every
    // artist's revenue." Exercised on the PostgREST path, where no PACHKA code
    // runs and the policy is the only thing in the way.
    const artistA = await seedArtist(database.db, "אורית");
    const artistB = await seedArtist(database.db, "רון");
    const buyerId = await seedBuyer(database.db);
    const saleA = await seedSale(database.db, artistA, buyerId, 111_100);
    const saleB = await seedSale(database.db, artistB, buyerId, 999_900);
    await recordFulfilmentPaid(deps(database), saleA.fulfilmentId);
    await recordFulfilmentPaid(deps(database), saleB.fulfilmentId);

    const { rows } = await asUser(database.dataApi, artistA, (tx) =>
      tx.query<{ artist_id: string; gross_agorot: string }>(
        "select artist_id, gross_agorot from payout_ledger",
      ),
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]?.artist_id).toBe(artistA);
    expect(JSON.stringify(rows)).not.toContain("999900");
  });

  it("lets an artist read but never write, so nobody edits their own ledger", async () => {
    const artistId = await seedArtist(database.db);
    const buyerId = await seedBuyer(database.db);
    const sale = await seedSale(database.db, artistId, buyerId);
    const { entry } = await recordFulfilmentPaid(deps(database), sale.fulfilmentId);

    await expect(
      asUser(database.dataApi, artistId, (tx) =>
        tx.query("update payout_ledger set net_agorot = 999999 where id = $1", [entry.id]),
      ),
    ).rejects.toThrow(/permission denied/i);
  });
});

describe("a correction", () => {
  const database = useTestDatabase();

  it("appends an adjusting entry and leaves the original byte-for-byte unchanged", async () => {
    const artistId = await seedArtist(database.db);
    const buyerId = await seedBuyer(database.db);
    const operatorId = await seedOperator(database);
    const sale = await seedSale(database.db, artistId, buyerId, 100_000);
    const { entry } = await recordFulfilmentPaid(deps(database), sale.fulfilmentId);

    // The whole row, before. Compared in full afterwards rather than field by
    // field, so a correction that touched anything at all would be caught.
    const before = await database.db.one(
      "select row_to_json(l) as row from payout_ledger l where id = $1",
      [entry.id],
    );

    const correction = await recordCorrection(deps(database), {
      actorId: operatorId,
      ledgerEntryId: entry.id,
      grossDeltaAgorot: -20_000,
      reason: "Buyer was refunded a damaged frame; sale reduced by ₪200.",
    });

    const after = await database.db.one(
      "select row_to_json(l) as row from payout_ledger l where id = $1",
      [entry.id],
    );
    expect(after).toEqual(before);

    // And the adjustment exists, references the original, and splits at the
    // original's snapshotted rate: -20000 at 1500 bp is -3000 / -17000.
    expect(correction.entry.entryType).toBe("adjustment");
    expect(correction.entry.parentEntryId).toBe(entry.id);
    expect(correction.entry.grossAgorot).toBe(-20_000);
    expect(correction.entry.commissionAgorot).toBe(-3_000);
    expect(correction.entry.netAgorot).toBe(-17_000);
    expect(correction.entry.commissionRateBp).toBe(1_500);
  });

  it("changes what the artist is owed without changing what the sale said", async () => {
    const artistId = await seedArtist(database.db);
    const buyerId = await seedBuyer(database.db);
    const operatorId = await seedOperator(database);
    const sale = await seedSale(database.db, artistId, buyerId, 100_000);
    const { entry } = await recordFulfilmentPaid(deps(database), sale.fulfilmentId);

    await recordCorrection(deps(database), {
      actorId: operatorId,
      ledgerEntryId: entry.id,
      grossDeltaAgorot: -20_000,
      reason: "Partial refund.",
    });

    const view = await artistPayouts(deps(database), artistId);
    const payout = view.payouts[0];

    // The sale still says what it always said.
    expect(payout?.entry.netAgorot).toBe(85_000);
    // What settling it would now pay is the sale plus its adjustments.
    expect(payout?.adjustmentsNetAgorot).toBe(-17_000);
    expect(payout?.payableNetAgorot).toBe(68_000);
    // And the balance straight from the table agrees.
    expect(view.totals.outstandingAgorot).toBe(68_000);
  });

  it("reverses a sale to exactly nothing, inventing no agora on the way", async () => {
    // The identity the sign rule in commission.ts exists for. Under a plain
    // floor, a sale of 10 agorot at 1500 bp and its reversal would leave a
    // commission of -1 and a net of +1 behind.
    const artistId = await seedArtist(database.db);
    const buyerId = await seedBuyer(database.db);
    const operatorId = await seedOperator(database);
    const sale = await seedSale(database.db, artistId, buyerId, 10);
    const { entry } = await recordFulfilmentPaid(deps(database), sale.fulfilmentId);

    expect(entry.commissionAgorot).toBe(1);
    expect(entry.netAgorot).toBe(9);

    await recordCorrection(deps(database), {
      actorId: operatorId,
      ledgerEntryId: entry.id,
      grossDeltaAgorot: -10,
      reason: "Sale reversed in full.",
    });

    const totals = await database.db.one<{ gross: string; commission: string; net: string }>(
      `select sum(gross_agorot)::text as gross,
              sum(commission_agorot)::text as commission,
              sum(net_agorot)::text as net
         from payout_ledger where artist_id = $1`,
      [artistId],
    );
    expect(totals).toEqual({ gross: "0", commission: "0", net: "0" });
  });

  it("keeps the whole history, oldest first, with the sale at the top", async () => {
    const artistId = await seedArtist(database.db);
    const buyerId = await seedBuyer(database.db);
    const operatorId = await seedOperator(database);
    const sale = await seedSale(database.db, artistId, buyerId);
    const { entry } = await recordFulfilmentPaid(deps(database), sale.fulfilmentId);

    await recordCorrection(deps(database), {
      actorId: operatorId,
      ledgerEntryId: entry.id,
      grossDeltaAgorot: -5_000,
      reason: "First correction.",
    });
    await recordCorrection(deps(database), {
      actorId: operatorId,
      ledgerEntryId: entry.id,
      grossDeltaAgorot: 2_000,
      reason: "Second correction, correcting the first.",
    });

    const history = await ledgerHistoryFor(database.db, entry.id);

    expect(history.map((h) => h.entryType)).toEqual(["sale", "adjustment", "adjustment"]);
    expect(history[1]?.reason).toBe("First correction.");
    expect(history[2]?.reason).toBe("Second correction, correcting the first.");
  });

  it("refuses one with no stated reason, because an unexplained correction is unreadable later", async () => {
    const artistId = await seedArtist(database.db);
    const buyerId = await seedBuyer(database.db);
    const operatorId = await seedOperator(database);
    const sale = await seedSale(database.db, artistId, buyerId);
    const { entry } = await recordFulfilmentPaid(deps(database), sale.fulfilmentId);

    await expect(
      recordCorrection(deps(database), {
        actorId: operatorId,
        ledgerEntryId: entry.id,
        grossDeltaAgorot: -1_000,
        reason: "   ",
      }),
    ).rejects.toMatchObject({ kind: "validation", code: "payouts.correction_reason_required" });

    const { rowCount } = await database.db.query(
      "select 1 from payout_ledger where parent_entry_id = $1",
      [entry.id],
    );
    expect(rowCount).toBe(0);
  });

  it("refuses one from somebody who is not an admin", async () => {
    const artistId = await seedArtist(database.db);
    const buyerId = await seedBuyer(database.db);
    const sale = await seedSale(database.db, artistId, buyerId);
    const { entry } = await recordFulfilmentPaid(deps(database), sale.fulfilmentId);

    // The artist whose money it is. Not found, never forbidden -- a 403 would
    // confirm the surface exists.
    await expect(
      recordCorrection(deps(database), {
        actorId: artistId,
        ledgerEntryId: entry.id,
        grossDeltaAgorot: 50_000,
        reason: "Paying myself more.",
      }),
    ).rejects.toMatchObject({ kind: "not_found" });

    const { rowCount } = await database.db.query(
      "select 1 from payout_ledger where parent_entry_id = $1",
      [entry.id],
    );
    expect(rowCount).toBe(0);
  });

  it("cannot be recorded at all when no audit writer is wired in", async () => {
    // ./ports: the stand-in raises rather than shrugging, because an unaudited
    // change to what the platform owes is worse than an unavailable one.
    const artistId = await seedArtist(database.db);
    const buyerId = await seedBuyer(database.db);
    const operatorId = await seedOperator(database);
    const sale = await seedSale(database.db, artistId, buyerId);
    const { entry } = await recordFulfilmentPaid({ db: database.db }, sale.fulfilmentId);

    await expect(
      recordCorrection({ db: database.db }, {
        actorId: operatorId,
        ledgerEntryId: entry.id,
        grossDeltaAgorot: -1_000,
        reason: "Should never land.",
      }),
    ).rejects.toMatchObject({ code: "payouts.audit_writer_unwired" });

    const { rowCount } = await database.db.query(
      "select 1 from payout_ledger where parent_entry_id = $1",
      [entry.id],
    );
    expect(rowCount).toBe(0);
  });
});
