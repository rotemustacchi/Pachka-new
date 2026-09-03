/**
 * The audit log is append-only for real, or it is decoration.
 *
 * SECURITY.md S1-14: "If that is implemented as 'the application only ever
 * calls INSERT', it is not a control -- it is a coding style." So none of the
 * tests below assert that PACHKA code calls INSERT. They take the attacker's
 * side of each control and assert it holds:
 *
 *   - as the application's own database role, UPDATE and DELETE the log
 *   - insert a row naming somebody else as the actor, and a timestamp in 2020
 *   - make the audit write fail and check the action it recorded went with it
 *   - edit a row with the trigger disabled -- an attacker holding database
 *     credentials -- and check the chain says so, at the right position
 *   - remove a row the same way, and check the chain says so
 *
 * The last two are the ones that matter most, because they are the only
 * controls that still work once the attacker has the service-role key.
 */
import { randomUUID } from "node:crypto";
import type { Client } from "pg";
import { describe, expect, it } from "vitest";
import {
  asAnon,
  asUser,
  grantAdminRole,
  useTestDatabase,
  withPrivilegedConnection,
  type TestDatabase,
} from "../harness";
import { recordAdminAction, verifyAuditChain, withAdminAction } from "@/modules/moderation";
import type { Database } from "@/shared/db";

async function seedAccount(
  database: TestDatabase,
  roles: readonly string[],
  name = "Noa A.",
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

const seedAdmin = (database: TestDatabase, name = "Admin A.") =>
  seedAccount(database, ["buyer", "admin"], name);

/** Append `count` entries as `adminId`, returning them oldest-first. */
async function appendEntries(db: Database, adminId: string, count: number) {
  const written = [];
  for (let index = 0; index < count; index += 1) {
    written.push(
      await withAdminAction(db, adminId, (tx) =>
        recordAdminAction(tx, {
          action: "report_resolution",
          targetType: "report",
          targetId: `report-${index}`,
          note: `resolved ${index}`,
        }),
      ),
    );
  }
  return written;
}

describe("an admin action is recorded", () => {
  const database = useTestDatabase();

  it("writes one entry carrying actor, timestamp, target, and note", async () => {
    const adminId = await seedAdmin(database);
    const before = Date.now();

    const entry = await withAdminAction(database.db, adminId, (tx) =>
      recordAdminAction(tx, {
        action: "commission_change",
        targetType: "config",
        targetId: "platform.commission_rate_bp",
        note: "Lowered for the launch promotion",
        details: { from: 1500, to: 1200 },
      }),
    );

    const { rows } = await database.db.query<{ count: string }>(
      "select count(*)::text as count from admin_audit",
    );
    expect(rows[0]!.count).toBe("1");

    expect(entry.actor).toBe(adminId);
    expect(entry.action).toBe("commission_change");
    expect(entry.targetId).toBe("platform.commission_rate_bp");
    expect(entry.note).toBe("Lowered for the launch promotion");
    expect(entry.details).toEqual({ from: 1500, to: 1200 });
    expect(entry.at.getTime()).toBeGreaterThanOrEqual(before - 1000);
    expect(entry.at.getTime()).toBeLessThanOrEqual(Date.now() + 1000);
  });

  it("refuses an action outside the recordable set", async () => {
    const adminId = await seedAdmin(database);

    await expect(
      withAdminAction(database.db, adminId, (tx) =>
        // @ts-expect-error -- the point of the test is the runtime guard behind the type
        recordAdminAction(tx, { action: "quietly_deleted", targetType: "account", targetId: "x" }),
      ),
    ).rejects.toMatchObject({ kind: "validation" });

    const { rows } = await database.db.query<{ count: string }>(
      "select count(*)::text as count from admin_audit",
    );
    expect(rows[0]!.count).toBe("0");
  });

  it("does not survive the transaction it was written in being rolled back", async () => {
    // The sharp end of SECURITY.md S1-14 item 3, and the one a "write the audit
    // row afterwards" implementation fails: an entry exists for an action that
    // never happened. It has to be tested from this side as well as the other,
    // because an audit writer that opens its own transaction still LOOKS right
    // when the failure happens before it -- the failure that catches it is one
    // that happens after.
    const adminId = await seedAdmin(database);

    await expect(
      withAdminAction(database.db, adminId, async (tx) => {
        await recordAdminAction(tx, {
          action: "account_suspension",
          targetType: "account",
          targetId: randomUUID(),
          note: "recorded, then the action failed",
        });
        throw new Error("the action this entry records failed after it was written");
      }),
    ).rejects.toThrow(/failed after it was written/);

    const { rows } = await database.db.query<{ count: string }>(
      "select count(*)::text as count from admin_audit",
    );
    expect(rows[0]!.count).toBe("0");
  });

  it("is not visible to anyone else until its transaction commits", async () => {
    // Two real connections. The second is not inside the first's transaction,
    // so it sees the log the way a concurrent request or the alerting job does.
    const adminId = await seedAdmin(database);
    const observer = await database.pool.connect();

    try {
      await withAdminAction(database.db, adminId, async (tx) => {
        await recordAdminAction(tx, {
          action: "report_resolution",
          targetType: "report",
          targetId: "r-1",
          note: "in flight",
        });

        const during = await observer.query("select count(*)::text as count from admin_audit");
        expect(during.rows[0]!.count).toBe("0");
      });

      const after = await observer.query("select count(*)::text as count from admin_audit");
      expect(after.rows[0]!.count).toBe("1");
    } finally {
      observer.release();
    }
  });

  it("refuses an entry written with no acting identity in the session", async () => {
    // Straight onto the pool: no withAdminAction, so nothing has published an
    // actor. An unattributed audit entry is worse than none.
    await expect(
      database.db.query(
        `insert into admin_audit (actor, at, action, target_type, target_id, note)
         values (gen_random_uuid(), now(), 'artwork_takedown', 'artwork', 'a1', '')`,
      ),
    ).rejects.toThrow(/no acting identity/i);
  });
});

describe("the actor and timestamp on an entry", () => {
  const database = useTestDatabase();

  it("come from the session, not from the values the caller supplied", async () => {
    // SECURITY.md S1-14: "the audit row records an actor and timestamp taken
    // from the caller, so the caller writes whatever actor they like".
    const adminId = await seedAdmin(database);
    const otherAdminId = await seedAdmin(database, "Admin B.");

    const row = await withAdminAction(database.db, adminId, (tx) =>
      tx.one<{ actor: string; at: Date }>(
        `insert into admin_audit (actor, at, action, target_type, target_id, note)
         values ($1, timestamptz '2020-01-01 00:00:00Z', 'account_suspension', 'account', $2, 'forged')
         returning actor, at`,
        [otherAdminId, otherAdminId],
      ),
    );

    expect(row.actor).toBe(adminId);
    expect(row.actor).not.toBe(otherAdminId);
    expect(Math.abs(row.at.getTime() - Date.now())).toBeLessThan(10_000);
  });

  it("cannot be named as parameters of the writer at all", async () => {
    // Stronger than "the writer ignores them": there is nothing to pass. If a
    // later change adds an actor or at parameter, this fails.
    const { rows } = await database.db.query<{ args: string }>(
      `select pg_get_function_arguments(p.oid) as args
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'moderation' and p.proname = 'admin_audit_chain'`,
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]!.args).toBe("");
  });
});

describe("an entry already written", () => {
  const database = useTestDatabase();

  it("cannot be updated by the role the application itself connects as", async () => {
    const adminId = await seedAdmin(database);
    const [entry] = await appendEntries(database.db, adminId, 1);

    // `database.db` is the real shared/db client on the connection module code
    // runs with. It is refused before the trigger is reached: the table grants
    // it SELECT and INSERT and nothing else, and there is no UPDATE policy for
    // any role. Two independent controls, and this is the outer one.
    await expect(
      database.db.query("update admin_audit set note = 'x' where id = $1", [entry!.id]),
    ).rejects.toThrow(/permission denied|row-level security/i);

    // And the inner one, which is the control that still matters after an
    // attacker has database credentials: the trigger refuses the same statement
    // from the table's own owner, who is not subject to either of the above.
    await expect(
      withPrivilegedConnection(
        database,
        "simulating an attacker who holds the database owner's credentials",
        (client) =>
          client.query("update admin_audit set note = 'x' where id = $1", [entry!.id]),
      ),
    ).rejects.toThrow(/append-only/i);

    const after = await database.db.one<{ count: string; note: string; row_hash: string }>(
      `select (select count(*)::text from admin_audit) as count,
              note, encode(row_hash, 'hex') as row_hash
         from admin_audit where id = $1`,
      [entry!.id],
    );
    expect(after.count).toBe("1");
    expect(after.note).toBe("resolved 0");
    expect(after.row_hash).toBe(entry!.rowHash);
  });

  it("cannot be deleted by the role the application itself connects as", async () => {
    const adminId = await seedAdmin(database);
    const [entry] = await appendEntries(database.db, adminId, 1);

    await expect(
      database.db.query("delete from admin_audit where id = $1", [entry!.id]),
    ).rejects.toThrow(/permission denied|row-level security/i);

    // The owner is refused too, by the trigger rather than by a privilege.
    await expect(
      withPrivilegedConnection(
        database,
        "simulating an attacker who holds the database owner's credentials",
        (client) => client.query("delete from admin_audit where id = $1", [entry!.id]),
      ),
    ).rejects.toThrow(/append-only/i);

    const after = await database.db.one<{ count: string; row_hash: string }>(
      `select (select count(*)::text from admin_audit) as count,
              encode(row_hash, 'hex') as row_hash
         from admin_audit where id = $1`,
      [entry!.id],
    );
    expect(after.count).toBe("1");
    expect(after.row_hash).toBe(entry!.rowHash);
  });
});

describe("the hash chain", () => {
  const database = useTestDatabase();

  it("verifies clean on an untouched log, and on an empty one", async () => {
    expect(await verifyAuditChain(database.db)).toEqual({
      ok: true,
      brokenSeq: null,
      reason: null,
    });

    const adminId = await seedAdmin(database);
    await appendEntries(database.db, adminId, 5);

    expect(await verifyAuditChain(database.db)).toEqual({
      ok: true,
      brokenSeq: null,
      reason: null,
    });
  });

  it("links each entry to the one before it", async () => {
    const adminId = await seedAdmin(database);
    const written = await appendEntries(database.db, adminId, 4);

    for (let index = 1; index < written.length; index += 1) {
      expect(written[index]!.prevHash).toBe(written[index - 1]!.rowHash);
    }
    // And the first links to a fixed anchor rather than to nothing, so
    // "entry one is the beginning" cannot be forged by truncating the log.
    expect(written[0]!.prevHash).toMatch(/^[0-9a-f]{64}$/);
    expect(written[0]!.prevHash).not.toBe(written[0]!.rowHash);
  });

  it("reports a break when a row is altered directly in the database", async () => {
    // The attacker here holds database credentials and has disabled the
    // immutability trigger -- which a superuser can do and the application
    // cannot. This is the scenario the chain exists for.
    const adminId = await seedAdmin(database);
    const written = await appendEntries(database.db, adminId, 5);
    const target = written[2]!;

    await tamper(database, (client) =>
      client.query("update admin_audit set note = 'nothing to see here' where id = $1", [
        target.id,
      ]),
    );

    // The edit really landed -- otherwise the assertion below proves nothing.
    const edited = await database.db.one<{ note: string }>(
      "select note from admin_audit where id = $1",
      [target.id],
    );
    expect(edited.note).toBe("nothing to see here");

    expect(await verifyAuditChain(database.db)).toEqual({
      ok: false,
      brokenSeq: target.seq,
      reason: "row_altered",
    });
  });

  it("reports a break when a row is deleted out of band", async () => {
    const adminId = await seedAdmin(database);
    const written = await appendEntries(database.db, adminId, 5);
    const removed = written[2]!;
    const following = written[3]!;

    await tamper(database, (client) =>
      client.query("delete from admin_audit where id = $1", [removed.id]),
    );

    const { rows } = await database.db.query<{ count: string }>(
      "select count(*)::text as count from admin_audit",
    );
    expect(rows[0]!.count).toBe("4");

    // A deleted entry has no row left to fail on. It shows up at the entry that
    // followed it, whose recorded predecessor is now missing.
    expect(await verifyAuditChain(database.db)).toEqual({
      ok: false,
      brokenSeq: following.seq,
      reason: "link_broken",
    });
  });

  it("catches entries cut from the end when a checkpoint is held outside the table", async () => {
    // The one attack the walk cannot see on its own: delete from the END, where
    // no later row is left to fail to link. Inside the table, "the log stops
    // here" and "the log was cut here" are the same picture -- so the test
    // first proves the walk alone is fooled, then proves what is not.
    const adminId = await seedAdmin(database);
    const written = await appendEntries(database.db, adminId, 3);
    const checkpoint = written[2]!.rowHash;

    await tamper(database, (client) =>
      client.query("delete from admin_audit where id = $1", [written[2]!.id]),
    );

    expect(await verifyAuditChain(database.db)).toEqual({
      ok: true,
      brokenSeq: null,
      reason: null,
    });

    expect(await verifyAuditChain(database.db, { checkpoint })).toEqual({
      ok: false,
      brokenSeq: null,
      reason: "checkpoint_missing",
    });
  });

  it("does not cry wolf when the checkpoint is simply older than the tip", async () => {
    const adminId = await seedAdmin(database);
    const written = await appendEntries(database.db, adminId, 2);
    const checkpoint = written[0]!.rowHash;

    await appendEntries(database.db, adminId, 3);

    expect(await verifyAuditChain(database.db, { checkpoint })).toEqual({
      ok: true,
      brokenSeq: null,
      reason: null,
    });
  });
});

describe("reading the audit log through the data API", () => {
  const database = useTestDatabase();

  it("is refused outright for an anonymous visitor", async () => {
    const adminId = await seedAdmin(database);
    await appendEntries(database.db, adminId, 1);

    await expect(
      asAnon(database.dataApi, (tx) => tx.query("select * from admin_audit")),
    ).rejects.toThrow(/permission denied/i);
  });

  it("returns nothing to a signed-in account that is not an admin", async () => {
    const adminId = await seedAdmin(database);
    const buyerId = await seedAccount(database, ["buyer"], "Buyer B.");
    await appendEntries(database.db, adminId, 3);

    const rows = await asUser(database.dataApi,
      buyerId,
      async (tx) => (await tx.query("select * from admin_audit")).rows,
      // Everything a buyer can put in their own token, which they can rewrite
      // at will with supabase.auth.updateUser (SECURITY.md S0-2).
      { user_metadata: { role: "admin" }, role: "admin", is_admin: true },
    );

    expect(rows).toEqual([]);
  });

  it("returns the entries to an admin", async () => {
    const adminId = await seedAdmin(database);
    await appendEntries(database.db, adminId, 3);

    const rows = await asUser(database.dataApi,
      adminId,
      async (tx) => (await tx.query("select * from admin_audit")).rows,
    );

    expect(rows).toHaveLength(3);
  });

  it("does not let an admin write one by hand through the data API", async () => {
    // The audit writer runs on the server. There is no grant behind the INSERT
    // policy, so even the role the policy would admit cannot reach the table.
    const adminId = await seedAdmin(database);

    await expect(
      asUser(database.dataApi, adminId, (tx) =>
        tx.query(
          `insert into admin_audit (actor, at, action, target_type, target_id)
           values (auth.uid(), now(), 'payout_settlement', 'payout', 'p1')`,
        ),
      ),
    ).rejects.toThrow(/permission denied/i);
  });
});

/**
 * Do something the immutability trigger would refuse, the way an attacker
 * holding database credentials would: turn it off, act, turn it back on.
 *
 * This is a test fixture, not a code path. It exists to prove the control that
 * still works when this one has been defeated.
 *
 * It runs on the privileged connection rather than the application one, and
 * that is the fixture being faithful rather than the fixture cheating. Neither
 * `alter table ... disable trigger` nor an UPDATE or DELETE on `admin_audit` is
 * available to the application role — no policy grants them and none should,
 * which the tests above assert directly. The attacker this scenario models is
 * specifically one who has the database owner's credentials, so giving the
 * fixture anything less would test a weaker attacker than the hash chain is
 * designed to catch.
 */
async function tamper(
  database: TestDatabase,
  act: (client: Client) => Promise<unknown>,
): Promise<void> {
  await withPrivilegedConnection(
    database,
    "simulating an attacker who holds the database owner's credentials",
    async (client) => {
      await client.query("alter table admin_audit disable trigger admin_audit_append_only");
      try {
        await act(client);
      } finally {
        await client.query("alter table admin_audit enable trigger admin_audit_append_only");
      }
    },
  );
}
