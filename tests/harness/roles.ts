/**
 * Acting as `anon` or `authenticated`, the way PostgREST does.
 *
 * This is how a test reaches the surface that actually matters. Supabase
 * publishes a data API at /rest/v1/<table> for every table in `public`, and
 * anyone holding the anon key -- which ships in the browser bundle by design --
 * can query it directly. No PACHKA code runs on that path: no route handler, no
 * serializer, no `toPublicArtist()`. Row-level security and Postgres GRANTs are
 * the only things in the way.
 *
 * PostgREST serves a request by connecting as its authenticator role, setting
 * the verified JWT claims into session settings, and issuing `set local role`
 * to the role named in the token. The helpers below do the same three things,
 * against the same session settings the `auth.uid()` / `auth.role()` shims in
 * the bootstrap migration read. So a policy exercised through `asAnon` sees
 * exactly what it will see in production, and a test that gets a row back here
 * is a test that says an attacker gets that row too.
 *
 * Pass `database.dataApi`, not `database.db`. The two are different login roles
 * on purpose. `dataApi` is the authenticator PostgREST connects as, a member of
 * `anon` and `authenticated` and nothing else, so a policy written `to anon` is
 * the only thing that can let a query through here. `database.db` is the
 * server's own role, a member of `service_role` and nothing else -- it cannot
 * `set role anon` at all, and if it could, Postgres would match `to anon`
 * policies against it by membership and the two surfaces would stop being
 * distinguishable. Neither role is a superuser and neither bypasses RLS; see
 * `login-roles.ts`.
 */
import type { Database, Tx } from "@/shared/db";

/** JWT claims to publish into the session, as PostgREST would. */
export interface Claims {
  /** The `sub` claim: what `auth.uid()` resolves to. */
  readonly userId?: string;
  /**
   * The full claims object, as Supabase sets it in `request.jwt.claims`.
   * Use this to simulate a user who has rewritten their own `user_metadata`.
   */
  readonly raw?: Record<string, unknown>;
}

async function applyClaims(tx: Tx, role: string, claims: Claims): Promise<void> {
  // set_config() rather than `set local`, because the value is a test-supplied
  // string and `set local` takes no parameters.
  await tx.query("select set_config('request.jwt.claim.role', $1, true)", [role]);
  await tx.query("select set_config('request.jwt.claim.sub', $1, true)", [claims.userId ?? ""]);
  await tx.query("select set_config('request.jwt.claims', $1, true)", [
    JSON.stringify({ role, ...(claims.userId ? { sub: claims.userId } : {}), ...claims.raw }),
  ]);
  // Last, because everything above is a privilege this role may not have.
  await tx.query(`set local role ${role}`);
}

/**
 * Run `fn` as the anonymous data-API caller: someone holding nothing but the
 * anon key. Whatever comes back is public to the internet.
 */
export function asAnon<T>(db: Database, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return db.withTransaction(async (tx) => {
    await applyClaims(tx, "anon", {});
    return fn(tx);
  });
}

/**
 * Run `fn` as a signed-in user. `claims.raw` lets a test forge the parts of the
 * token the user genuinely controls -- `user_metadata` above all, which
 * `supabase.auth.updateUser` lets any signed-in account rewrite at will.
 */
export function asUser<T>(
  db: Database,
  userId: string,
  fn: (tx: Tx) => Promise<T>,
  raw?: Record<string, unknown>,
): Promise<T> {
  return db.withTransaction(async (tx) => {
    await applyClaims(tx, "authenticated", { userId, raw });
    return fn(tx);
  });
}
