/**
 * Every admin surface is admin-only, and says "not found" when it is not you.
 *
 * Spec, "Admin queue": "an account without the admin role requests the admin
 * queue -> the system returns a not-found response". Not 403. A forbidden
 * response is a confirmation: it tells an attacker the surface is there and
 * that their account is real. The tests assert the error KIND, because that is
 * what `httpStatusFor` turns into the status code a caller actually sees.
 *
 * The interesting cases are not "a stranger is refused". They are: an admin
 * whose own account has been suspended, and a buyer who has rewritten their own
 * `user_metadata` to say `admin` -- which any signed-in user can do with one
 * call to `supabase.auth.updateUser` (SECURITY.md S0-2).
 */
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  grantAdminRole,
  useTestDatabase,
  type TestDatabase,
} from "../harness";
import { isAdmin, readAuditTrail, recordAdminAction, requireAdmin, withAdminAction } from "@/modules/moderation";

async function seedAccount(
  database: TestDatabase,
  roles: readonly string[],
  name = "Dana L.",
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

describe("requiring an admin", () => {
  const database = useTestDatabase();

  it("admits an account holding the admin role", async () => {
    const adminId = await seedAccount(database, ["buyer", "admin"], "Admin A.");

    await expect(requireAdmin(database.db, adminId)).resolves.toEqual({ userId: adminId });
    await expect(isAdmin(database.db, adminId)).resolves.toBe(true);
  });

  it("returns not-found for an account without the role", async () => {
    const buyerId = await seedAccount(database, ["buyer"], "Buyer B.");

    await expect(requireAdmin(database.db, buyerId)).rejects.toMatchObject({ kind: "not_found" });
    await expect(isAdmin(database.db, buyerId)).resolves.toBe(false);
  });

  it("returns not-found for an artist, who is not an admin either", async () => {
    const artistId = await seedAccount(database, ["buyer", "artist"], "Artist C.");

    await expect(requireAdmin(database.db, artistId)).rejects.toMatchObject({ kind: "not_found" });
  });

  it("returns not-found for an account that does not exist", async () => {
    await expect(requireAdmin(database.db, randomUUID())).rejects.toMatchObject({
      kind: "not_found",
    });
  });

  it("returns not-found for an anonymous caller", async () => {
    await expect(requireAdmin(database.db, null)).rejects.toMatchObject({ kind: "not_found" });
    await expect(requireAdmin(database.db, undefined)).rejects.toMatchObject({ kind: "not_found" });
    await expect(isAdmin(database.db, null)).resolves.toBe(false);
  });

  it("returns not-found for an admin whose own account is suspended", async () => {
    // SECURITY.md S1-13: a suspended account authorises nothing, even while its
    // access token is still inside its lifetime.
    const adminId = await seedAccount(database, ["admin"], "Admin D.");
    await database.db.query(
      "update account_status set suspended_at = now(), suspended_reason = 'under review' where user_id = $1",
      [adminId],
    );

    await expect(requireAdmin(database.db, adminId)).rejects.toMatchObject({ kind: "not_found" });
  });

  it("says exactly the same thing in every refusal", async () => {
    // A message that varies is an oracle: "no such account" versus "not an
    // admin" tells an attacker which addresses are real.
    const buyerId = await seedAccount(database, ["buyer"], "Buyer E.");
    const suspendedAdminId = await seedAccount(database, ["admin"], "Admin F.");
    await database.db.query("update account_status set suspended_at = now() where user_id = $1", [
      suspendedAdminId,
    ]);

    const messages = await Promise.all(
      [buyerId, suspendedAdminId, randomUUID(), null].map((id) =>
        requireAdmin(database.db, id).then(
          () => "admitted",
          (error: { message: string; code: string }) => `${error.code}:${error.message}`,
        ),
      ),
    );

    expect(new Set(messages).size).toBe(1);
    expect(messages[0]).toBe("moderation.not_found:Not found");
  });
});

describe("an admin action", () => {
  const database = useTestDatabase();

  it("is refused, and writes nothing, when the caller is not an admin", async () => {
    const buyerId = await seedAccount(database, ["buyer"], "Buyer G.");

    await expect(
      withAdminAction(database.db, buyerId, (tx) =>
        recordAdminAction(tx, {
          action: "artwork_takedown",
          targetType: "artwork",
          targetId: randomUUID(),
          note: "should never land",
        }),
      ),
    ).rejects.toMatchObject({ kind: "not_found" });

    const { rows } = await database.db.query<{ count: string }>(
      "select count(*)::text as count from admin_audit",
    );
    expect(rows[0]!.count).toBe("0");
  });

  it("reads back only what it was asked for", async () => {
    const adminId = await seedAccount(database, ["admin"], "Admin H.");
    const artworkId = randomUUID();

    await withAdminAction(database.db, adminId, async (tx) => {
      await recordAdminAction(tx, {
        action: "artwork_takedown",
        targetType: "artwork",
        targetId: artworkId,
        note: "not the artist's own work",
      });
      await recordAdminAction(tx, {
        action: "report_resolution",
        targetType: "report",
        targetId: randomUUID(),
        note: "dismissed",
      });
    });

    const trail = await readAuditTrail(database.db, { targetType: "artwork" });

    expect(trail).toHaveLength(1);
    expect(trail[0]).toMatchObject({
      action: "artwork_takedown",
      targetId: artworkId,
      note: "not the artist's own work",
      actor: adminId,
    });
  });

  it("puts both entries of one action in one transaction", async () => {
    // Two entries written inside a single withAdminAction share a transaction,
    // so a failure in the second takes the first with it.
    const adminId = await seedAccount(database, ["admin"], "Admin I.");

    await expect(
      withAdminAction(database.db, adminId, async (tx) => {
        await recordAdminAction(tx, {
          action: "config_change",
          targetType: "config",
          targetId: "returns.window_days",
          note: "first",
        });
        await recordAdminAction(tx, {
          action: "config_change",
          targetType: "config",
          targetId: "returns.window_days",
          note: "x".repeat(2001),
        });
      }),
    ).rejects.toThrow();

    const { rows } = await database.db.query<{ count: string }>(
      "select count(*)::text as count from admin_audit",
    );
    expect(rows[0]!.count).toBe("0");
  });
});
