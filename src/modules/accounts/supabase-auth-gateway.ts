/**
 * `AuthGateway` backed by Supabase Auth.
 *
 * This is the adapter at the boundary — the one place in the module that knows
 * GoTrue's shapes. It is kept deliberately thin, and it contains no PACHKA
 * rules, because it is the one file the integration suite cannot exercise:
 * ARCHITECTURE.md's test policy forbids live network in tests, so there is no
 * honest way to test this against the real service. Every decision worth
 * testing therefore lives on the other side of the interface, where the fake
 * drives it and a real Postgres records the result.
 *
 * If you are adding logic here, it probably belongs in `registration.ts`,
 * `session.ts` or `verification.ts` instead.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { AuthGateway, AuthUser, CreateUserOutcome } from "./auth-gateway";

export interface SupabaseAuthGatewayOptions {
  /**
   * Request-scoped client carrying the anon key and the caller's auth cookies.
   * Used for anything acting AS the user: sign-up, sign-in, sign-out, reset.
   */
  readonly client: SupabaseClient;
  /**
   * Service-role client, created lazily so that a request which never needs
   * admin access never constructs one. Used only for operations GoTrue exposes
   * on the admin API: reading a user by id, and ending an account's sessions.
   */
  readonly admin: () => SupabaseClient;
  /** Absolute URL the verification and reset links come back to. */
  readonly redirectTo?: string;
}

interface GoTrueUser {
  readonly id: string;
  readonly email?: string;
  readonly email_confirmed_at?: string;
  readonly identities?: unknown[];
}

function toAuthUser(user: GoTrueUser): AuthUser {
  return {
    id: user.id,
    email: (user.email ?? "").toLowerCase(),
    emailVerifiedAt: user.email_confirmed_at ? new Date(user.email_confirmed_at) : null,
  };
}

export function createSupabaseAuthGateway(options: SupabaseAuthGatewayOptions): AuthGateway {
  const { client, admin, redirectTo } = options;

  return {
    async createUser(email, password): Promise<CreateUserOutcome> {
      const { data, error } = await client.auth.signUp({
        email,
        password,
        options: redirectTo ? { emailRedirectTo: redirectTo } : undefined,
      });

      if (error || !data.user) return { created: false };

      // GoTrue deliberately does not error on an address that already exists —
      // that would be the enumeration oracle registration is written to avoid.
      // It returns a decoy user with an EMPTY `identities` array instead. That
      // empty array is the only signal, and reading it here is what lets
      // `register()` take the identical path for both outcomes.
      const identities = (data.user as GoTrueUser).identities;
      if (Array.isArray(identities) && identities.length === 0) return { created: false };

      return { created: true, user: toAuthUser(data.user as GoTrueUser) };
    },

    async signInWithPassword(email, password): Promise<AuthUser | null> {
      const { data, error } = await client.auth.signInWithPassword({ email, password });
      // Any error is the same answer to the caller. GoTrue distinguishes
      // "invalid credentials" from "email not confirmed"; `session.ts` gives one
      // sentence for both, and the distinction must not leak through here.
      if (error || !data.user) return null;
      return toAuthUser(data.user as GoTrueUser);
    },

    async signOut(): Promise<void> {
      await client.auth.signOut();
    },

    async revokeAllSessions(userId): Promise<void> {
      // GoTrue has no "log this user id out" admin call in this client version:
      // `auth.admin.signOut` takes a JWT, which the operator suspending an
      // account does not hold. Banning does revoke the account's refresh tokens
      // and is what "suspended" means to the auth provider anyway.
      //
      // This is the belt. The braces is `accounts.auth_is_active()`, which every
      // write policy tests — so a live access token belonging to a suspended
      // account authorizes nothing whether or not this call succeeds
      // (SECURITY.md S1-13 item 2). Reinstatement clears it; see below.
      await admin().auth.admin.updateUserById(userId, { ban_duration: "876000h" });
    },

    async sendVerificationEmail(userId): Promise<void> {
      const { data } = await admin().auth.admin.getUserById(userId);
      const email = data.user?.email;
      if (!email) return;

      await client.auth.resend({
        type: "signup",
        email,
        ...(redirectTo ? { options: { emailRedirectTo: redirectTo } } : {}),
      });
    },

    async requestPasswordReset(email): Promise<void> {
      // Resolves whether or not the address exists, and the caller returns the
      // same sentence either way (SECURITY.md S2-26 item 3). The error is
      // swallowed on purpose: surfacing it would reintroduce the difference.
      await client.auth.resetPasswordForEmail(
        email,
        redirectTo ? { redirectTo } : undefined,
      );
    },

    async getUser(userId): Promise<AuthUser | null> {
      const { data, error } = await admin().auth.admin.getUserById(userId);
      if (error || !data.user) return null;
      return toAuthUser(data.user as GoTrueUser);
    },
  };
}

/**
 * Lift the provider-side ban that `revokeAllSessions` applies.
 *
 * Not part of `AuthGateway`: reinstatement is a moderation action, and putting
 * it on the interface would mean every fake had to implement it to satisfy a
 * path most callers never take. `reinstateAccount` in `session.ts` clears the
 * PACHKA-side suspension, which is the half that authorizes anything.
 */
export async function liftSupabaseBan(adminClient: SupabaseClient, userId: string): Promise<void> {
  await adminClient.auth.admin.updateUserById(userId, { ban_duration: "none" });
}
