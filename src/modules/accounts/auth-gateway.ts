/**
 * The boundary between PACHKA and Supabase Auth.
 *
 * Supabase Auth (GoTrue) is a separate service that owns password hashes,
 * session tokens and the verification email. It is outside PACHKA in exactly
 * the sense ARCHITECTURE.md's test policy means: reached through an injected
 * interface, with a deterministic fake in tests. Everything on PACHKA's side of
 * this line -- the profile row, the roles, the verification mirror -- lives in
 * our own Postgres and is tested against a real one, never faked.
 *
 * Note what is NOT on this interface: anything that returns a role. Roles come
 * from `user_roles` and nowhere else, because a signed-in user can rewrite
 * their own `user_metadata` with `supabase.auth.updateUser` and that metadata
 * lands in the JWT (SECURITY.md S0-2). If this interface handed back a role,
 * the temptation to trust it would eventually be taken.
 */

export interface AuthUser {
  readonly id: string;
  readonly email: string;
  /** When the provider recorded the address as confirmed, or null. */
  readonly emailVerifiedAt: Date | null;
}

/** What `createUser` did. The caller must not be able to tell these apart. */
export type CreateUserOutcome =
  | { readonly created: true; readonly user: AuthUser }
  /**
   * The address already has an account. Deliberately not an error: the caller
   * has to take the same visible path for both outcomes, and an exception
   * invites a `catch` that says "that address is taken" (SECURITY.md S2-26).
   */
  | { readonly created: false };

export interface AuthGateway {
  createUser(email: string, password: string): Promise<CreateUserOutcome>;
  /** Null when the credentials do not match. Never says which half was wrong. */
  signInWithPassword(email: string, password: string): Promise<AuthUser | null>;
  signOut(): Promise<void>;
  /**
   * End every session for an account, including refresh tokens.
   * Suspension calls this -- and does not depend on it succeeding, because
   * every write path also tests the suspension predicate (SECURITY.md S1-13).
   */
  revokeAllSessions(userId: string): Promise<void>;
  sendVerificationEmail(userId: string): Promise<void>;
  /** Always resolves, whether or not the address has an account. */
  requestPasswordReset(email: string): Promise<void>;
  getUser(userId: string): Promise<AuthUser | null>;
}
