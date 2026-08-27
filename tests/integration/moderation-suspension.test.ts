/**
 * Suspension, reinstatement, and the one thing that must survive both: money
 * the artist is already owed.
 *
 * Spec, "Account suspension". The scenarios tested here are its three, plus the
 * rejections the test policy makes mandatory:
 *
 *   - an artist is suspended -> their work leaves public surfaces, and they
 *     cannot sign in
 *   - the suspension is lifted -> access and visibility come back
 *   - an artist with eligible unsettled payouts is suspended -> the ledger
 *     entries are RETAINED and flagged, not cancelled
 *   - a suspension with no reason is refused
 *   - a non-admin cannot suspend anyone
 *   - the audit entry and the suspension are one transaction or neither
 *
 * On the payouts port. `payout_ledger` belongs to the `payouts` module, which
 * has not shipped, and no module writes another module's tables. The test
 * therefore stands up a real ledger table in its own throwaway database and
 * implements `PayoutLedgerPort` against it with real SQL. That is not a mock:
 * the assertions read rows back out of Postgres and check the money is still
 * there. What is being proved is moderation's half of the contract -- that it
 * asks, that it flags, and that it never cancels -- which is the half that
 * would otherwise be written and never exercised until payouts lands.
 */
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { useTestDatabase } from "../harness";
import { FakeAuthGateway } from "../fakes/auth-gateway";
import { isSuspended, signIn } from "@/modules/accounts";
import {
  isAccountSuspended,
  reinstateAccount,
  readAuditTrail,
  suspendAccount,
  verifyAuditChain,
  type ModerationDeps,
  type PayoutLedgerPort,
} from "@/modules/moderation";
import type { Database, Sql } from "@/shared/db";

async function seedAccount(db: Database, roles: readonly string[], name: string): Promise<string> {
  const { rows } = await db.query<{ user_id: string }>(
    "insert into profiles (user_id, display_name) values (gen_random_uuid(), $1) returning user_id",
    [name],
  );
  const id = rows[0]!.user_id;
  await db.query("insert into account_status (user_id, verified_at) values ($1, now())", [id]);
  for (const role of roles) {
    await db.query("insert into user_roles (user_id, role) values ($1, $2)", [id, role]);
  }
  return id;
}

function depsFor(db: Database, auth = new FakeAuthGateway(), payouts?: PayoutLedgerPort) {
  const deps: ModerationDeps = { db, auth, ...(payouts ? { payouts } : {}) };
  return { deps, auth };
}

// ---------------------------------------------------------------------------
// A real ledger, standing in for the payouts module until it ships.
// ---------------------------------------------------------------------------

async function createLedger(db: Database): Promise<PayoutLedgerPort> {
  await db.query(`
    create table stand_in_payout_ledger (
      id            uuid primary key default gen_random_uuid(),
      artist_id     uuid   not null,
      amount_agorot bigint not null,
      status        text   not null,
      flagged_by    uuid,
      flagged_at    timestamptz
    )
  `);
  // The throwaway database this test owns is dropped whole afterwards, so there
  // is nothing to clean up and no fixture shared with any other test.
  await db.query("alter table stand_in_payout_ledger enable row level security");

  return {
    async outstandingFor(sql: Sql, artistId: string) {
      const row = await sql.one<{ entries: string; total: string }>(
        `select count(*)::text as entries, coalesce(sum(amount_agorot), 0)::text as total
           from stand_in_payout_ledger
          where artist_id = $1 and status = 'eligible'`,
        [artistId],
      );
      return {
        known: true,
        entryCount: Number(row.entries),
        totalAgorot: BigInt(row.total),
      };
    },
    async flagForOperatorDecision(sql: Sql, artistId: string, auditEntryId: string) {
      const { rowCount } = await sql.query(
        `update stand_in_payout_ledger
            set status = 'operator_decision', flagged_by = $2, flagged_at = now()
          where artist_id = $1 and status = 'eligible'`,
        [artistId, auditEntryId],
      );
      return rowCount;
    },
  };
}

describe("suspending an account", () => {
  const database = useTestDatabase();

  it("marks it suspended, ends its sessions, and records who did it and why", async () => {
    const adminId = await seedAccount(database.db, ["admin"], "Admin A.");
    const artistId = await seedAccount(database.db, ["buyer", "artist"], "Artist B.");
    const { deps, auth } = depsFor(database.db);

    const result = await suspendAccount(deps, {
      actorId: adminId,
      userId: artistId,
      reason: "Listings are mass-produced prints sold as originals",
      note: "Third report this week",
    });

    expect(await isAccountSuspended(database.db, artistId)).toBe(true);
    expect(await isSuspended(database.db, artistId)).toBe(true);
    expect(auth.revoked).toEqual([artistId]);

    const trail = await readAuditTrail(database.db, { targetType: "account", targetId: artistId });
    expect(trail).toHaveLength(1);
    expect(trail[0]).toMatchObject({
      action: "account_suspension",
      actor: adminId,
      targetId: artistId,
      note: "Third report this week",
    });
    expect(trail[0]!.details).toMatchObject({
      reason: "Listings are mass-produced prints sold as originals",
    });
    expect(result.audit.id).toBe(trail[0]!.id);
    expect(await verifyAuditChain(database.db)).toMatchObject({ ok: true });
  });

  it("stops the account signing in", async () => {
    const adminId = await seedAccount(database.db, ["admin"], "Admin C.");
    const auth = new FakeAuthGateway();
    const created = await auth.createUser("artist@example.com", "a-long-enough-password");
    if (!created.created) throw new Error("fixture: address already taken");
    auth.confirmEmail("artist@example.com");

    // Bind the provider-side id to a local account, the way registration does.
    await database.db.query(
      "insert into profiles (user_id, display_name) values ($1, 'Artist D.')",
      [created.user.id],
    );
    await database.db.query(
      "insert into account_status (user_id, verified_at) values ($1, now())",
      [created.user.id],
    );

    const { deps } = depsFor(database.db, auth);
    await suspendAccount(deps, {
      actorId: adminId,
      userId: created.user.id,
      reason: "Offensive content",
    });

    await expect(
      signIn({ db: database.db, auth }, { email: "artist@example.com", password: "a-long-enough-password" }),
    ).rejects.toMatchObject({ kind: "forbidden", code: "accounts.suspended" });
  });

  it("takes the artist's profile off public surfaces", async () => {
    // Withdrawal is derived, not a bulk update: the public-read policy calls
    // accounts.account_is_suspended() at query time. This asserts the derivation
    // actually responds to what moderation wrote.
    const adminId = await seedAccount(database.db, ["admin"], "Admin E.");
    const artistId = await seedAccount(database.db, ["buyer", "artist"], "Artist F.");
    await database.db.query(
      "insert into artist_profiles (user_id, display_name) values ($1, 'Artist F.')",
      [artistId],
    );

    const visibleBefore = await database.db.one<{ visible: boolean }>(
      "select accounts.account_is_suspended($1) as visible",
      [artistId],
    );
    expect(visibleBefore.visible).toBe(false);

    const { deps } = depsFor(database.db);
    await suspendAccount(deps, { actorId: adminId, userId: artistId, reason: "Under review" });

    const after = await database.db.one<{ suspended: boolean; publicly_visible: boolean }>(
      `select accounts.account_is_suspended($1)      as suspended,
              accounts.artist_is_publicly_visible($1) as publicly_visible`,
      [artistId],
    );
    expect(after.suspended).toBe(true);
    expect(after.publicly_visible).toBe(false);
  });

  it("refuses a suspension with no reason, and writes nothing", async () => {
    const adminId = await seedAccount(database.db, ["admin"], "Admin G.");
    const artistId = await seedAccount(database.db, ["artist"], "Artist H.");
    const { deps } = depsFor(database.db);

    for (const reason of ["", "   "]) {
      await expect(
        suspendAccount(deps, { actorId: adminId, userId: artistId, reason }),
      ).rejects.toMatchObject({ kind: "validation" });
    }

    expect(await isAccountSuspended(database.db, artistId)).toBe(false);
    expect(await readAuditTrail(database.db)).toEqual([]);
  });

  it("refuses a non-admin, with not-found, and writes nothing", async () => {
    const buyerId = await seedAccount(database.db, ["buyer"], "Buyer I.");
    const artistId = await seedAccount(database.db, ["artist"], "Artist J.");
    const { deps, auth } = depsFor(database.db);

    await expect(
      suspendAccount(deps, { actorId: buyerId, userId: artistId, reason: "I do not like them" }),
    ).rejects.toMatchObject({ kind: "not_found" });

    expect(await isAccountSuspended(database.db, artistId)).toBe(false);
    expect(await readAuditTrail(database.db)).toEqual([]);
    expect(auth.revoked).toEqual([]);
  });

  it("refuses an account that does not exist", async () => {
    const adminId = await seedAccount(database.db, ["admin"], "Admin K.");
    const { deps } = depsFor(database.db);

    await expect(
      suspendAccount(deps, { actorId: adminId, userId: randomUUID(), reason: "Spam" }),
    ).rejects.toMatchObject({ kind: "not_found" });
  });

  it("refuses an admin suspending themselves", async () => {
    const adminId = await seedAccount(database.db, ["admin"], "Admin L.");
    const { deps } = depsFor(database.db);

    await expect(
      suspendAccount(deps, { actorId: adminId, userId: adminId, reason: "Testing" }),
    ).rejects.toMatchObject({ kind: "conflict" });

    expect(await isAccountSuspended(database.db, adminId)).toBe(false);
  });
});

describe("the audit entry and the action it records", () => {
  const database = useTestDatabase();

  it("are one transaction: when the audit write fails, the suspension does not happen", async () => {
    // SECURITY.md S1-14 item 3, and its test: "Force the takedown to fail after
    // the [state] update but before commit (inject a constraint violation).
    // Assert the [subject] is still [unchanged] AND that no admin_audit row
    // exists -- proving one transaction, not two."
    //
    // The constraint is the real 2000-character bound on admin_audit.note, hit
    // by a note the operator typed. Nothing here is stubbed or intercepted: the
    // suspension is written first, the audit insert then fails on the column
    // check, and the transaction takes both down.
    const adminId = await seedAccount(database.db, ["admin"], "Admin M.");
    const artistId = await seedAccount(database.db, ["buyer", "artist"], "Artist N.");
    const { deps } = depsFor(database.db);

    await expect(
      suspendAccount(deps, {
        actorId: adminId,
        userId: artistId,
        reason: "Undeclared AI generation",
        note: "n".repeat(2001),
      }),
    ).rejects.toThrow();

    // The action did not take effect...
    expect(await isAccountSuspended(database.db, artistId)).toBe(false);
    const status = await database.db.one<{ suspended_at: Date | null; suspended_reason: string | null }>(
      "select suspended_at, suspended_reason from account_status where user_id = $1",
      [artistId],
    );
    expect(status.suspended_at).toBeNull();
    expect(status.suspended_reason).toBeNull();

    // ...and neither did its audit entry.
    const { rows } = await database.db.query<{ count: string }>(
      "select count(*)::text as count from admin_audit",
    );
    expect(rows[0]!.count).toBe("0");
  });

  it("leaves no orphan entry when the step AFTER the audit write fails", async () => {
    // The failure mode the previous test cannot see. If the audit row were
    // written on its own connection it would already have committed by the time
    // this throws, and an entry would survive for a suspension that never
    // happened. Here the payouts module raises -- a real error from real SQL,
    // after `recordAdminAction` has returned.
    const adminId = await seedAccount(database.db, ["admin"], "Admin M2.");
    const artistId = await seedAccount(database.db, ["buyer", "artist"], "Artist N2.");
    const ledger = await createLedger(database.db);
    await database.db.query(
      `insert into stand_in_payout_ledger (artist_id, amount_agorot, status)
       values ($1, 50000, 'eligible')`,
      [artistId],
    );

    const failing: PayoutLedgerPort = {
      outstandingFor: ledger.outstandingFor,
      async flagForOperatorDecision(sql: Sql, artistId2: string) {
        // `status` is bounded by no CHECK here, so the error is provoked the
        // way a real one would arrive: a column that does not exist, as it
        // would after a schema drift between the two modules.
        await sql.query(
          "update stand_in_payout_ledger set no_such_column = 1 where artist_id = $1",
          [artistId2],
        );
        return 1;
      },
    };

    const { deps } = depsFor(database.db, new FakeAuthGateway(), failing);

    await expect(
      suspendAccount(deps, {
        actorId: adminId,
        userId: artistId,
        reason: "Sold work that was not their own",
      }),
    ).rejects.toThrow();

    expect(await isAccountSuspended(database.db, artistId)).toBe(false);
    expect(await readAuditTrail(database.db)).toEqual([]);

    const ledgerRows = await database.db.query<{ status: string; amount: string }>(
      "select status, amount_agorot::text as amount from stand_in_payout_ledger where artist_id = $1",
      [artistId],
    );
    expect(ledgerRows.rows).toEqual([{ status: "eligible", amount: "50000" }]);
  });

  it("still holds when the failure comes from the action rather than the audit", async () => {
    const adminId = await seedAccount(database.db, ["admin"], "Admin O.");
    const { deps } = depsFor(database.db);

    // No account_status row for this id, so the action refuses before writing.
    await expect(
      suspendAccount(deps, { actorId: adminId, userId: randomUUID(), reason: "Spam" }),
    ).rejects.toMatchObject({ kind: "not_found" });

    expect(await readAuditTrail(database.db)).toEqual([]);
  });
});

describe("an artist with unsettled payouts", () => {
  const database = useTestDatabase();

  it("keeps the money: the ledger entries are retained and flagged, not cancelled", async () => {
    const adminId = await seedAccount(database.db, ["admin"], "Admin P.");
    const artistId = await seedAccount(database.db, ["buyer", "artist"], "Artist Q.");
    const ledger = await createLedger(database.db);

    await database.db.query(
      `insert into stand_in_payout_ledger (artist_id, amount_agorot, status)
       values ($1, 125000, 'eligible'), ($1, 48000, 'eligible'), ($1, 9900, 'settled')`,
      [artistId],
    );

    const { deps } = depsFor(database.db, new FakeAuthGateway(), ledger);
    const result = await suspendAccount(deps, {
      actorId: adminId,
      userId: artistId,
      reason: "Sold work that was not their own",
    });

    expect(result.outstandingPayouts).toEqual({
      known: true,
      entryCount: 2,
      totalAgorot: 173000n,
    });
    expect(result.payoutsFlagged).toBe(2);

    // Nothing was cancelled, zeroed, or removed.
    const { rows } = await database.db.query<{
      status: string;
      amount: string;
      flagged_by: string | null;
    }>(
      // The alias is not `amount_agorot`: ORDER BY prefers an output column
      // over the underlying one, and ordering the text form puts 125000 first.
      `select status, amount_agorot::text as amount, flagged_by
         from stand_in_payout_ledger
        where artist_id = $1
        order by amount_agorot`,
      [artistId],
    );
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.amount)).toEqual(["9900", "48000", "125000"]);
    expect(rows.map((r) => r.status)).toEqual(["settled", "operator_decision", "operator_decision"]);
    for (const row of rows.filter((r) => r.status === "operator_decision")) {
      expect(row.flagged_by).toBe(result.audit.id);
    }

    // And the audit entry says an operator has a decision to make.
    expect(result.audit.details).toMatchObject({
      outstanding_payouts_known: true,
      outstanding_payout_entries: 2,
      outstanding_payout_total_agorot: "173000",
      payout_review_required: true,
    });
  });

  it("records that nobody checked when the payouts module is not wired in", async () => {
    // The dangerous failure would be recording "no outstanding payouts". This
    // asserts the entry says the question was never asked.
    const adminId = await seedAccount(database.db, ["admin"], "Admin R.");
    const artistId = await seedAccount(database.db, ["artist"], "Artist S.");
    const { deps } = depsFor(database.db);

    const result = await suspendAccount(deps, {
      actorId: adminId,
      userId: artistId,
      reason: "Misleading listings",
    });

    expect(result.outstandingPayouts.known).toBe(false);
    expect(result.audit.details).toMatchObject({
      outstanding_payouts_known: false,
      payout_review_required: true,
    });
  });
});

describe("lifting a suspension", () => {
  const database = useTestDatabase();

  it("gives the account back its access and its public visibility", async () => {
    const adminId = await seedAccount(database.db, ["admin"], "Admin T.");
    const artistId = await seedAccount(database.db, ["buyer", "artist"], "Artist U.");
    await database.db.query(
      "insert into artist_profiles (user_id, display_name) values ($1, 'Artist U.')",
      [artistId],
    );
    const { deps } = depsFor(database.db);

    await suspendAccount(deps, { actorId: adminId, userId: artistId, reason: "Under review" });
    expect(await isAccountSuspended(database.db, artistId)).toBe(true);

    const result = await reinstateAccount(deps, {
      actorId: adminId,
      userId: artistId,
      note: "Reviewed; the report was mistaken",
    });

    expect(await isAccountSuspended(database.db, artistId)).toBe(false);
    const status = await database.db.one<{ suspended_reason: string | null }>(
      "select suspended_reason from account_status where user_id = $1",
      [artistId],
    );
    expect(status.suspended_reason).toBeNull();

    expect(result.audit).toMatchObject({
      action: "account_reinstatement",
      actor: adminId,
      targetId: artistId,
      note: "Reviewed; the report was mistaken",
    });
    expect(result.audit.details).toMatchObject({ lifted_reason: "Under review" });
  });

  it("leaves both entries in the log, in order, chained", async () => {
    const adminId = await seedAccount(database.db, ["admin"], "Admin V.");
    const artistId = await seedAccount(database.db, ["artist"], "Artist W.");
    const { deps } = depsFor(database.db);

    const suspension = await suspendAccount(deps, {
      actorId: adminId,
      userId: artistId,
      reason: "Under review",
    });
    const reinstatement = await reinstateAccount(deps, { actorId: adminId, userId: artistId });

    const trail = await readAuditTrail(database.db, { targetType: "account", targetId: artistId });
    expect(trail.map((entry) => entry.action)).toEqual([
      "account_reinstatement",
      "account_suspension",
    ]);
    expect(reinstatement.audit.prevHash).toBe(suspension.audit.rowHash);
    expect(await verifyAuditChain(database.db)).toMatchObject({ ok: true });
  });

  it("refuses to lift a suspension that is not there", async () => {
    const adminId = await seedAccount(database.db, ["admin"], "Admin X.");
    const artistId = await seedAccount(database.db, ["artist"], "Artist Y.");
    const { deps } = depsFor(database.db);

    await expect(
      reinstateAccount(deps, { actorId: adminId, userId: artistId }),
    ).rejects.toMatchObject({ kind: "conflict" });

    expect(await readAuditTrail(database.db)).toEqual([]);
  });

  it("refuses a non-admin", async () => {
    const adminId = await seedAccount(database.db, ["admin"], "Admin Z.");
    const buyerId = await seedAccount(database.db, ["buyer"], "Buyer AA.");
    const artistId = await seedAccount(database.db, ["artist"], "Artist AB.");
    const { deps } = depsFor(database.db);

    await suspendAccount(deps, { actorId: adminId, userId: artistId, reason: "Under review" });

    await expect(
      reinstateAccount(deps, { actorId: buyerId, userId: artistId }),
    ).rejects.toMatchObject({ kind: "not_found" });

    expect(await isAccountSuspended(database.db, artistId)).toBe(true);
  });
});
