/**
 * Sign in, sign out, password reset.
 *
 * Two rules run through all three.
 *
 * A failed sign-in never says which half was wrong. "No account with that
 * address" and "wrong password" are the same sentence, because the difference
 * between them is an address-enumeration oracle, and registration went to some
 * trouble to close that oracle on the other endpoint.
 *
 * A suspended account cannot sign in -- and, more importantly, cannot act.
 * SECURITY.md S1-13 and SPEC-G: Supabase access tokens are self-contained JWTs
 * valid for their full lifetime and are not checked against the database on
 * each request, so "unable to sign in" leaves a suspended artist publishing
 * artworks and changing payout details for up to an hour. Signing in is
 * therefore the least important of the two checks here. The one that carries
 * the weight is `accounts.auth_is_active()`, which every write policy tests.
 */
import { AppError } from "@/shared/errors";
import type { Sql } from "@/shared/db";
import type { AccountsDeps, RequestOrigin } from "./deps";
import type { AuthUser } from "./auth-gateway";
import { consumeRateLimit } from "./rate-limit";
import { normaliseEmail } from "./registration";
import { recordVerification } from "./verification";

export interface SignInInput extends RequestOrigin {
  readonly email: string;
  readonly password: string;
}

export interface SignedInAccount {
  readonly userId: string;
  readonly emailVerified: boolean;
  readonly roles: readonly string[];
}

/** Identical for a wrong password and for an address with no account. */
const BAD_CREDENTIALS = "Email or password is incorrect.";

export async function rolesFor(db: Sql, userId: string): Promise<string[]> {
  // From `user_roles`, and from nowhere else. Never from the JWT: a signed-in
  // user rewrites their own `user_metadata` at will (SECURITY.md S0-2).
  const { rows } = await db.query<{ role: string }>(
    "select role from user_roles where user_id = $1 order by role",
    [userId],
  );
  return rows.map((r) => r.role);
}

export async function isSuspended(db: Sql, userId: string): Promise<boolean> {
  const row = await db.maybeOne<{ suspended: boolean }>(
    "select suspended_at is not null as suspended from account_status where user_id = $1",
    [userId],
  );
  return row?.suspended ?? false;
}

export async function signIn(deps: AccountsDeps, input: SignInInput): Promise<SignedInAccount> {
  const email = normaliseEmail(input.email);

  if (input.ipAddress) await consumeRateLimit(deps.db, "signin", input.ipAddress);
  await consumeRateLimit(deps.db, "signin", email);

  const user = await deps.auth.signInWithPassword(email, input.password);
  if (!user) {
    throw AppError.validation(BAD_CREDENTIALS, { code: "accounts.bad_credentials" });
  }

  if (await isSuspended(deps.db, user.id)) {
    // Undo the session the provider just issued. Belt: the braces is that every
    // write policy independently tests the suspension predicate, so even a
    // token that survives this call authorizes nothing.
    await deps.auth.revokeAllSessions(user.id);
    throw AppError.forbidden("This account has been suspended.", {
      code: "accounts.suspended",
    });
  }

  // Keep the local mirror in step with the provider on every sign-in, so the
  // gate in `verification.ts` is reading something current.
  await recordVerification(deps.db, user.id, user.emailVerifiedAt);

  return {
    userId: user.id,
    emailVerified: user.emailVerifiedAt !== null,
    roles: await rolesFor(deps.db, user.id),
  };
}

export async function signOut(deps: AccountsDeps): Promise<void> {
  await deps.auth.signOut();
}

/**
 * End every session an account has, and mark it suspended locally.
 *
 * Exposed for the moderation module, which owns the suspension decision;
 * accounts owns the enforcement predicate (SECURITY.md S1-13). Moderation calls
 * this rather than writing `account_status` itself, because no module writes
 * another module's tables.
 */
export async function suspendAccount(
  deps: AccountsDeps,
  userId: string,
  reason: string,
): Promise<void> {
  await deps.db.query(
    "update account_status set suspended_at = now(), suspended_reason = $2 where user_id = $1",
    [userId, reason],
  );
  await deps.auth.revokeAllSessions(userId);
}

/** Lift a suspension. Published artworks come back by derivation, not by bulk update. */
export async function reinstateAccount(deps: AccountsDeps, userId: string): Promise<void> {
  await deps.db.query(
    "update account_status set suspended_at = null, suspended_reason = null where user_id = $1",
    [userId],
  );
}

export interface PasswordResetResult {
  readonly message: string;
}

/**
 * The same sentence for every address, registered or not.
 *
 * SECURITY.md S2-26 item 3 groups password reset with registration for exactly
 * this reason: an endpoint that says "no account with that address" is an
 * enumeration oracle, and it is the easier of the two to forget.
 */
const RESET_RESULT: PasswordResetResult = {
  message: "If that address has an account, we have sent it a link to reset the password.",
};

export async function requestPasswordReset(
  deps: AccountsDeps,
  input: { email: string } & RequestOrigin,
): Promise<PasswordResetResult> {
  const email = normaliseEmail(input.email);

  if (input.ipAddress) await consumeRateLimit(deps.db, "password_reset", input.ipAddress);
  await consumeRateLimit(deps.db, "password_reset", email);

  await deps.auth.requestPasswordReset(email);

  return RESET_RESULT;
}

export type { AuthUser };
