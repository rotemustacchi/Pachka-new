/**
 * Who is allowed to act, and the transaction every admin action runs in.
 *
 * Two rules from the spec and one from SECURITY.md meet here.
 *
 * 1. "Non-admin attempts access -> the system returns a not-found response."
 *    Not 403. A forbidden response confirms the admin queue exists at that
 *    address, and confirms that the caller's account is real but unprivileged.
 *    `AppError.notFound` is what the taxonomy already calls "the thing
 *    addressed does not exist, or must not be revealed to exist".
 *
 * 2. Roles come from `user_roles` and nowhere else (SECURITY.md S0-2). Never
 *    from `user_metadata`, which any signed-in user rewrites with one call to
 *    `supabase.auth.updateUser`. This module never reads a JWT claim to decide
 *    anything; it reads the table.
 *
 * 3. A suspended account authorises nothing, even while its access token is
 *    still inside its lifetime (SECURITY.md S1-13). That applies to an admin
 *    whose own account has been suspended, which is exactly the case where it
 *    matters most.
 *
 * `withAdminAction` is also where the audit's actor comes from. It publishes
 * the authorised admin into `request.jwt.claim.sub` for the duration of the
 * transaction -- the same session setting PostgREST populates from a verified
 * token, and the one `auth.uid()` reads. So the identity the audit trigger
 * stamps is the identity this function authorised, from the same read, in the
 * same transaction. There is no second place that can name a different actor.
 */
import { AppError } from "@/shared/errors";
import type { Database, Sql, Tx } from "@/shared/db";

export interface AdminActor {
  readonly userId: string;
}

interface AuthorityRow {
  readonly is_admin: boolean;
  readonly suspended: boolean;
}

/**
 * Resolve the caller to an admin, or refuse as if the surface did not exist.
 *
 * One query, so an absent account, a non-admin account and a suspended admin
 * are indistinguishable in timing as well as in response.
 */
export async function requireAdmin(sql: Sql, userId: string | null | undefined): Promise<AdminActor> {
  if (!userId) throw notFound();

  const row = await sql.maybeOne<AuthorityRow>(
    `select
       exists (select 1 from user_roles where user_id = $1 and role = 'admin')            as is_admin,
       exists (select 1 from account_status
                where user_id = $1 and suspended_at is not null)                          as suspended`,
    [userId],
  );

  if (!row || !row.is_admin || row.suspended) throw notFound();

  return { userId };
}

/** True/false form, for a route deciding whether to render an admin affordance. */
export async function isAdmin(sql: Sql, userId: string | null | undefined): Promise<boolean> {
  try {
    await requireAdmin(sql, userId);
    return true;
  } catch {
    return false;
  }
}

/**
 * Run an admin action: authorise, publish the actor, and hand back a `Tx`.
 *
 * Everything the action does -- including its audit entry -- happens on this
 * one transaction. That is the whole point: SECURITY.md S1-14 item 3 requires
 * that an action cannot succeed unaudited and an audit row cannot exist for an
 * action that rolled back, and a shared transaction is the only thing that
 * makes both true at once. Callers must not reach for `deps.db` inside the
 * callback; use the `tx`. `txAsDatabase` is there for module APIs that insist
 * on a `Database`.
 */
export async function withAdminAction<T>(
  db: Database,
  actorId: string | null | undefined,
  fn: (tx: Tx, actor: AdminActor) => Promise<T>,
): Promise<T> {
  return db.withTransaction(async (tx) => {
    const actor = await requireAdmin(tx, actorId);

    // `set_config(..., is_local => true)` rather than `set local`, because the
    // value is a parameter and `set local` takes none. Local scope matters: the
    // setting dies with the transaction, so a pooled connection cannot carry
    // one admin's identity into the next request.
    await tx.query("select set_config('request.jwt.claim.sub', $1, true)", [actor.userId]);

    return fn(tx, actor);
  });
}

function notFound(): AppError {
  // Deliberately the same message for "no such account", "not an admin" and
  // "admin, but suspended". The caller learns nothing from the difference.
  return AppError.notFound("Not found", { code: "moderation.not_found" });
}
