/**
 * Roles come from `user_roles`, and from nowhere else.
 *
 * SECURITY.md S0-2. Supabase hands every signed-in user
 * `supabase.auth.updateUser({ data: {...} })`, which writes `user_metadata`,
 * which lands in their JWT. If any policy or route reads a role out of the
 * token, then `admin` is self-grantable with one client-side call -- and admin
 * settles payouts and sets the commission rate.
 *
 * The tests below forge the metadata as convincingly as the attacker can and
 * assert it buys nothing. `asUser(..., raw)` publishes the forged claims into
 * `request.jwt.claims`, which is the same session setting Supabase populates.
 */
import { describe, expect, it } from "vitest";
import { asUser, useTestDatabase } from "../harness";
import type { Database } from "@/shared/db";

/** Everything a user might plausibly stuff into their own metadata. */
const FORGED_ADMIN_CLAIMS = {
  user_metadata: { role: "admin", is_admin: true, user_roles: ["admin"], roles: ["admin"] },
  role: "admin",
  is_admin: true,
  user_roles: ["admin"],
} as const;

async function seedBuyer(db: Database, name = "Michal R."): Promise<string> {
  const { rows } = await db.query<{ user_id: string }>(
    "insert into profiles (user_id, display_name) values (gen_random_uuid(), $1) returning user_id",
    [name],
  );
  const id = rows[0]!.user_id;
  await db.query("insert into account_status (user_id, verified_at) values ($1, now())", [id]);
  await db.query("insert into user_roles (user_id, role) values ($1, 'buyer')", [id]);
  return id;
}

describe("a buyer who has rewritten their own user_metadata to claim admin", () => {
  const database = useTestDatabase();

  it("is not an admin according to the only thing that decides that", async () => {
    const buyerId = await seedBuyer(database.db);

    const isAdmin = await asUser(
      database.db,
      buyerId,
      async (tx) => {
        const row = await tx.one<{ is_admin: boolean }>(
          "select accounts.auth_is_admin() as is_admin",
        );
        return row.is_admin;
      },
      FORGED_ADMIN_CLAIMS,
    );

    expect(isAdmin).toBe(false);
  });

  it("cannot read another account's roles", async () => {
    const buyerId = await seedBuyer(database.db);
    const otherId = await seedBuyer(database.db, "Ori K.");

    const rows = await asUser(
      database.db,
      buyerId,
      async (tx) => {
        const result = await tx.query("select * from user_roles where user_id = $1", [otherId]);
        return result.rows;
      },
      FORGED_ADMIN_CLAIMS,
    );

    expect(rows).toEqual([]);
  });

  it("cannot read anyone's bank details", async () => {
    const buyerId = await seedBuyer(database.db);

    await expect(
      asUser(
        database.db,
        buyerId,
        (tx) => tx.query("select * from artist_payout_details"),
        FORGED_ADMIN_CLAIMS,
      ),
    ).rejects.toThrow(/permission denied/i);
  });

  it("cannot change the commission rate", async () => {
    const buyerId = await seedBuyer(database.db);

    await expect(
      asUser(
        database.db,
        buyerId,
        (tx) =>
          tx.query(
            "update app_config set value = '0'::jsonb where key = 'platform.commission_rate_bp'",
          ),
        FORGED_ADMIN_CLAIMS,
      ),
    ).rejects.toThrow();

    const row = await database.db.one<{ value: string }>(
      "select value::text as value from app_config where key = 'platform.commission_rate_bp'",
    );
    expect(row.value).toBe("1500");
  });
});

describe("granting yourself a role through the data API", () => {
  const database = useTestDatabase();

  it("is refused outright for admin", async () => {
    const buyerId = await seedBuyer(database.db);

    await expect(
      asUser(database.db, buyerId, (tx) =>
        tx.query("insert into user_roles (user_id, role) values (auth.uid(), 'admin')"),
      ),
    ).rejects.toThrow(/permission denied/i);

    const row = await database.db.one<{ count: string }>(
      "select count(*)::text as count from user_roles where role = 'admin'",
    );
    expect(row.count).toBe("0");
  });

  it("is refused for artist too, so the upgrade cannot skip the server", async () => {
    // The artist upgrade is a server-side function that hard-codes the literal
    // 'artist' (SECURITY.md S0-2 item 3). If `authenticated` could write this
    // table, that function would be decoration.
    const buyerId = await seedBuyer(database.db);

    await expect(
      asUser(database.db, buyerId, (tx) =>
        tx.query("insert into user_roles (user_id, role) values (auth.uid(), 'artist')"),
      ),
    ).rejects.toThrow(/permission denied/i);

    const row = await database.db.one<{ count: string }>(
      "select count(*)::text as count from user_roles where user_id = $1",
      [buyerId],
    );
    expect(row.count).toBe("1");
  });

  it("cannot be done by deleting and rewriting the row either", async () => {
    const buyerId = await seedBuyer(database.db);

    await expect(
      asUser(database.db, buyerId, (tx) => tx.query("delete from user_roles where user_id = auth.uid()")),
    ).rejects.toThrow(/permission denied/i);
  });
});

describe("a genuine admin, held in user_roles", () => {
  const database = useTestDatabase();

  it("is recognised, so the role check is not simply always false", async () => {
    // Without this the four assertions above would all pass against a helper
    // that returned a constant.
    const adminId = await seedBuyer(database.db, "Operator");
    await database.db.query("insert into user_roles (user_id, role) values ($1, 'admin')", [
      adminId,
    ]);

    const isAdmin = await asUser(database.db, adminId, async (tx) => {
      const row = await tx.one<{ is_admin: boolean }>("select accounts.auth_is_admin() as is_admin");
      return row.is_admin;
    });

    expect(isAdmin).toBe(true);
  });

  it("reads roles across accounts, which a buyer cannot", async () => {
    const adminId = await seedBuyer(database.db, "Operator");
    await database.db.query("insert into user_roles (user_id, role) values ($1, 'admin')", [
      adminId,
    ]);
    const otherId = await seedBuyer(database.db, "Ori K.");

    const rows = await asUser(database.db, adminId, async (tx) => {
      const result = await tx.query<{ role: string }>(
        "select role from user_roles where user_id = $1",
        [otherId],
      );
      return result.rows;
    });

    expect(rows).toEqual([{ role: "buyer" }]);
  });
});

describe("a suspended account", () => {
  const database = useTestDatabase();

  it("is reported inactive even while its session is still valid", async () => {
    // SECURITY.md S1-13. Supabase access tokens are self-contained and stay
    // valid for their full lifetime, so "cannot sign in" is not "cannot act".
    // Every write policy tests this predicate rather than trusting revocation.
    const buyerId = await seedBuyer(database.db);
    await database.db.query("update account_status set suspended_at = now() where user_id = $1", [
      buyerId,
    ]);

    const active = await asUser(database.db, buyerId, async (tx) => {
      const row = await tx.one<{ active: boolean }>("select accounts.auth_is_active() as active");
      return row.active;
    });

    expect(active).toBe(false);
  });

  it("becomes active again when the suspension is lifted", async () => {
    const buyerId = await seedBuyer(database.db);
    await database.db.query("update account_status set suspended_at = now() where user_id = $1", [
      buyerId,
    ]);
    await database.db.query("update account_status set suspended_at = null where user_id = $1", [
      buyerId,
    ]);

    const active = await asUser(database.db, buyerId, async (tx) => {
      const row = await tx.one<{ active: boolean }>("select accounts.auth_is_active() as active");
      return row.active;
    });

    expect(active).toBe(true);
  });
});
