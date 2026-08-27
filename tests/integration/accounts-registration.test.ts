/**
 * Registration, sign-in, sign-out, password reset, and the verification gate.
 *
 * Tasks 2.2 and 2.3. Every assertion is about something observable: a row that
 * exists, a value returned, an error raised. Nothing here asserts that a
 * function was called.
 */
import { describe, expect, it } from "vitest";
import { useTestDatabase } from "../harness";
import { FakeAuthGateway } from "../fakes/auth-gateway";
import {
  assertEmailVerified,
  isEmailVerified,
  register,
  requestPasswordReset,
  rolesFor,
  signIn,
  signOut,
  suspendAccount,
  syncEmailVerification,
  type AccountsDeps,
} from "@/modules/accounts";
import type { Database } from "@/shared/db";

const PASSWORD = "a-long-enough-passphrase";

function deps(db: Database): AccountsDeps & { auth: FakeAuthGateway } {
  return { db, auth: new FakeAuthGateway() };
}

describe("registering", () => {
  const database = useTestDatabase();

  it("creates an account holding exactly the buyer role", async () => {
    const d = deps(database.db);

    await register(d, {
      email: "yael@example.com",
      password: PASSWORD,
      displayName: "Yael Schwartz",
    });

    const userId = d.auth.idFor("yael@example.com");
    expect(await rolesFor(database.db, userId)).toEqual(["buyer"]);
  });

  it("creates the profile and the status row together", async () => {
    const d = deps(database.db);

    await register(d, { email: "yael@example.com", password: PASSWORD, displayName: "Yael" });

    const userId = d.auth.idFor("yael@example.com");
    const row = await database.db.one<{ display_name: string; verified: boolean }>(
      `select p.display_name, s.verified_at is not null as verified
         from profiles p join account_status s using (user_id)
        where p.user_id = $1`,
      [userId],
    );
    expect(row).toEqual({ display_name: "Yael", verified: false });
  });

  it("sends a verification email", async () => {
    const d = deps(database.db);

    await register(d, { email: "yael@example.com", password: PASSWORD, displayName: "Yael" });

    expect(d.auth.verificationEmails).toEqual(["yael@example.com"]);
  });

  it("does not store the address anywhere a visitor can read", async () => {
    // The address lives with the auth provider. `profiles` is world-readable
    // and must not carry it (SECURITY.md S0-1).
    const d = deps(database.db);
    await register(d, { email: "yael@example.com", password: PASSWORD, displayName: "Yael" });

    const { rows } = await database.db.query<{ found: string }>(
      "select display_name as found from profiles",
    );
    expect(rows.map((r) => r.found)).toEqual(["Yael"]);
  });

  it("normalises the address, so one person cannot hold two accounts on casing", async () => {
    const d = deps(database.db);

    await register(d, { email: "Yael@Example.COM", password: PASSWORD, displayName: "Yael" });
    await register(d, { email: "yael@example.com", password: PASSWORD, displayName: "Impostor" });

    const { rowCount } = await database.db.query("select 1 from profiles");
    expect(rowCount).toBe(1);
  });
});

describe("registering an address that already has an account", () => {
  const database = useTestDatabase();

  it("returns a response identical to a successful registration", async () => {
    // The spec requires a generic message; SECURITY.md S2-26 requires that the
    // two cases be indistinguishable. Byte-identical is the strongest form of
    // that and the easiest to keep true.
    const d = deps(database.db);
    const first = await register(d, {
      email: "yael@example.com",
      password: PASSWORD,
      displayName: "Yael",
    });

    const second = await register(d, {
      email: "yael@example.com",
      password: PASSWORD,
      displayName: "Someone Else",
    });

    expect(second).toEqual(first);
  });

  it("leaks neither the address nor any database vocabulary", async () => {
    const d = deps(database.db);
    await register(d, { email: "yael@example.com", password: PASSWORD, displayName: "Yael" });

    const result = await register(d, {
      email: "yael@example.com",
      password: PASSWORD,
      displayName: "Someone Else",
    });

    expect(result.message).not.toContain("yael@example.com");
    for (const word of ["duplicate", "constraint", "violates", "already exists", "profiles_"]) {
      expect(result.message.toLowerCase()).not.toContain(word);
    }
  });

  it("creates no second account", async () => {
    const d = deps(database.db);
    await register(d, { email: "yael@example.com", password: PASSWORD, displayName: "Yael" });

    await register(d, {
      email: "yael@example.com",
      password: PASSWORD,
      displayName: "Someone Else",
    });

    const { rowCount } = await database.db.query("select 1 from profiles");
    expect(rowCount).toBe(1);
  });

  it("sends no second verification email", async () => {
    const d = deps(database.db);
    await register(d, { email: "yael@example.com", password: PASSWORD, displayName: "Yael" });

    await register(d, { email: "yael@example.com", password: PASSWORD, displayName: "Other" });

    expect(d.auth.verificationEmails).toEqual(["yael@example.com"]);
  });
});

describe("registration input that is safe to reject precisely", () => {
  const database = useTestDatabase();

  it("rejects a malformed address", async () => {
    await expect(
      register(deps(database.db), {
        email: "not-an-address",
        password: PASSWORD,
        displayName: "Yael",
      }),
    ).rejects.toMatchObject({ kind: "validation" });
  });

  it("rejects a password shorter than the configured minimum", async () => {
    await expect(
      register(deps(database.db), {
        email: "yael@example.com",
        password: "short",
        displayName: "Yael",
      }),
    ).rejects.toMatchObject({ kind: "validation" });
  });

  it("states the configured minimum rather than a hard-coded one", async () => {
    await database.db.query(
      "update app_config set value = '16'::jsonb where key = 'accounts.min_password_length'",
    );

    await expect(
      register(deps(database.db), {
        email: "yael@example.com",
        password: "twelve-chars",
        displayName: "Yael",
      }),
    ).rejects.toMatchObject({ fields: { password: ["Please use at least 16 characters."] } });
  });

  it("rejects a display name carrying contact details", async () => {
    // A display name is public text, so the scanner runs on it too.
    await expect(
      register(deps(database.db), {
        email: "yael@example.com",
        password: PASSWORD,
        displayName: "Yael 050-123-4567",
      }),
    ).rejects.toMatchObject({ kind: "validation" });
  });

  it("creates nothing when validation fails", async () => {
    await expect(
      register(deps(database.db), { email: "bad", password: "x", displayName: "Y" }),
    ).rejects.toThrow();

    const { rowCount } = await database.db.query("select 1 from profiles");
    expect(rowCount).toBe(0);
  });
});

describe("signing in", () => {
  const database = useTestDatabase();

  async function registered(d: AccountsDeps & { auth: FakeAuthGateway }): Promise<string> {
    await register(d, { email: "yael@example.com", password: PASSWORD, displayName: "Yael" });
    return d.auth.idFor("yael@example.com");
  }

  it("returns the account's roles, read from user_roles", async () => {
    const d = deps(database.db);
    const userId = await registered(d);

    const session = await signIn(d, { email: "yael@example.com", password: PASSWORD });

    expect(session).toEqual({ userId, emailVerified: false, roles: ["buyer"] });
  });

  it("gives the same message for a wrong password and an unknown address", async () => {
    const d = deps(database.db);
    await registered(d);

    const wrongPassword = await signIn(d, {
      email: "yael@example.com",
      password: "wrong-but-long-enough",
    }).catch((error: Error) => error.message);

    const unknownAddress = await signIn(d, {
      email: "nobody@example.com",
      password: PASSWORD,
    }).catch((error: Error) => error.message);

    expect(wrongPassword).toBe(unknownAddress);
  });

  it("reports verification once the address is confirmed", async () => {
    const d = deps(database.db);
    await registered(d);
    d.auth.confirmEmail("yael@example.com");

    const session = await signIn(d, { email: "yael@example.com", password: PASSWORD });

    expect(session.emailVerified).toBe(true);
  });

  it("mirrors the verified state into the database on sign-in", async () => {
    const d = deps(database.db);
    const userId = await registered(d);
    d.auth.confirmEmail("yael@example.com");

    await signIn(d, { email: "yael@example.com", password: PASSWORD });

    expect(await isEmailVerified(database.db, userId)).toBe(true);
  });

  it("refuses a suspended account", async () => {
    const d = deps(database.db);
    const userId = await registered(d);
    await suspendAccount(d, userId, "Repeated takedowns");

    await expect(signIn(d, { email: "yael@example.com", password: PASSWORD })).rejects.toMatchObject(
      { kind: "forbidden", code: "accounts.suspended" },
    );
  });

  it("revokes the suspended account's sessions rather than only refusing the form", async () => {
    // SECURITY.md S1-13: a self-contained JWT keeps working for its full
    // lifetime. Refusing the login screen alone changes nothing for a session
    // that already exists.
    const d = deps(database.db);
    const userId = await registered(d);

    await suspendAccount(d, userId, "Repeated takedowns");

    expect(d.auth.revoked).toContain(userId);
  });

  it("lets a reinstated account back in", async () => {
    const d = deps(database.db);
    const userId = await registered(d);
    await suspendAccount(d, userId, "Mistake");
    await database.db.query("update account_status set suspended_at = null where user_id = $1", [
      userId,
    ]);

    const session = await signIn(d, { email: "yael@example.com", password: PASSWORD });

    expect(session.userId).toBe(userId);
  });

  it("signs out", async () => {
    const d = deps(database.db);
    await registered(d);

    await signOut(d);

    expect(d.auth.signedOut).toBe(1);
  });
});

describe("password reset", () => {
  const database = useTestDatabase();

  it("says the same thing for a registered and an unregistered address", async () => {
    const d = deps(database.db);
    await register(d, { email: "yael@example.com", password: PASSWORD, displayName: "Yael" });

    const known = await requestPasswordReset(d, { email: "yael@example.com" });
    const unknown = await requestPasswordReset(d, { email: "nobody@example.com" });

    expect(known).toEqual(unknown);
  });

  it("does not echo the address back", async () => {
    const result = await requestPasswordReset(deps(database.db), { email: "yael@example.com" });

    expect(result.message).not.toContain("yael@example.com");
  });
});

describe("the verification gate", () => {
  const database = useTestDatabase();

  async function registered(): Promise<{
    d: AccountsDeps & { auth: FakeAuthGateway };
    userId: string;
  }> {
    const d = deps(database.db);
    await register(d, { email: "yael@example.com", password: PASSWORD, displayName: "Yael" });
    return { d, userId: d.auth.idFor("yael@example.com") };
  }

  it("blocks publishing for an unverified address", async () => {
    const { userId } = await registered();

    await expect(assertEmailVerified(database.db, userId, "publish")).rejects.toMatchObject({
      kind: "forbidden",
      code: "accounts.email_not_verified",
    });
  });

  it("prompts the artist to verify rather than saying only 'forbidden'", async () => {
    const { userId } = await registered();

    await expect(assertEmailVerified(database.db, userId, "publish")).rejects.toThrow(/verify your email/i);
  });

  it("blocks ordering for an unverified address", async () => {
    const { userId } = await registered();

    await expect(assertEmailVerified(database.db, userId, "order")).rejects.toMatchObject({
      kind: "forbidden",
    });
  });

  it("allows publishing once the address is verified", async () => {
    const { d, userId } = await registered();
    d.auth.confirmEmail("yael@example.com");
    await syncEmailVerification(d, userId);

    await expect(assertEmailVerified(database.db, userId, "publish")).resolves.toBeUndefined();
  });

  it("allows ordering once the address is verified", async () => {
    const { d, userId } = await registered();
    d.auth.confirmEmail("yael@example.com");
    await syncEmailVerification(d, userId);

    await expect(assertEmailVerified(database.db, userId, "order")).resolves.toBeUndefined();
  });

  it("does not un-verify an account when the provider answers null", async () => {
    // A provider hiccup must not silently revoke a verified account mid-session.
    const { d, userId } = await registered();
    d.auth.confirmEmail("yael@example.com");
    await syncEmailVerification(d, userId);

    await database.db.query("update account_status set verified_at = verified_at where user_id = $1", [userId]);
    const { recordVerification } = await import("@/modules/accounts/verification");
    await recordVerification(database.db, userId, null);

    expect(await isEmailVerified(database.db, userId)).toBe(true);
  });
});

describe("rate limits on the anonymous auth surface", () => {
  const database = useTestDatabase();

  it("refuses registration past the configured threshold", async () => {
    // SECURITY.md's rate-limit table; SPEC-J. Open self-service registration on
    // a free tier is a bulk-account-creation surface.
    await database.db.query(
      "update app_config set value = '2'::jsonb where key = 'accounts.registration_max_per_window'",
    );
    const d = deps(database.db);

    await register(d, { email: "a@example.com", password: PASSWORD, displayName: "Alma", ipAddress: "203.0.113.5" });
    await register(d, { email: "b@example.com", password: PASSWORD, displayName: "Boaz", ipAddress: "203.0.113.5" });

    await expect(
      register(d, { email: "c@example.com", password: PASSWORD, displayName: "Carmel", ipAddress: "203.0.113.5" }),
    ).rejects.toMatchObject({ code: "accounts.rate_limited" });
  });

  it("limits per IP, so one blocked address does not block everyone", async () => {
    await database.db.query(
      "update app_config set value = '2'::jsonb where key = 'accounts.registration_max_per_window'",
    );
    const d = deps(database.db);
    await register(d, { email: "a@example.com", password: PASSWORD, displayName: "Alma", ipAddress: "203.0.113.5" });
    await register(d, { email: "b@example.com", password: PASSWORD, displayName: "Boaz", ipAddress: "203.0.113.5" });

    const other = await register(d, {
      email: "d@example.com",
      password: PASSWORD,
      displayName: "Dana",
      ipAddress: "198.51.100.9",
    });

    expect(other.message).toBeTruthy();
  });

  it("refuses sign-in past the configured threshold", async () => {
    await database.db.query(
      "update app_config set value = '2'::jsonb where key = 'accounts.signin_max_per_window'",
    );
    const d = deps(database.db);
    await register(d, { email: "yael@example.com", password: PASSWORD, displayName: "Yael" });

    await signIn(d, { email: "yael@example.com", password: "wrong-password-here" }).catch(() => {});
    await signIn(d, { email: "yael@example.com", password: "wrong-password-here" }).catch(() => {});

    await expect(
      signIn(d, { email: "yael@example.com", password: PASSWORD }),
    ).rejects.toMatchObject({ code: "accounts.rate_limited" });
  });

  it("refuses password reset past the configured threshold", async () => {
    await database.db.query(
      "update app_config set value = '1'::jsonb where key = 'accounts.password_reset_max_per_window'",
    );
    const d = deps(database.db);

    await requestPasswordReset(d, { email: "yael@example.com" });

    await expect(requestPasswordReset(d, { email: "yael@example.com" })).rejects.toMatchObject({
      code: "accounts.rate_limited",
    });
  });

  it("stores no raw address or IP in the counter table", async () => {
    // Unhashed, this table becomes a list of every address that has ever tried
    // to register (SECURITY.md, log redaction).
    const d = deps(database.db);
    await register(d, {
      email: "yael@example.com",
      password: PASSWORD,
      displayName: "Yael",
      ipAddress: "203.0.113.5",
    });

    const { rows } = await database.db.query<{ subject: string }>(
      "select subject from auth_rate_limit_events",
    );
    const subjects = rows.map((r) => r.subject).join(" ");

    expect(subjects).not.toContain("yael@example.com");
    expect(subjects).not.toContain("203.0.113.5");
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) expect(row.subject).toMatch(/^[0-9a-f]{64}$/);
  });
});
