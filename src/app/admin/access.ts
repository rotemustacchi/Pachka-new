/**
 * Every admin surface answers not-found when it is not you.
 *
 * moderation-admin: "an account without the admin role requests the admin queue
 * -> the system returns a not-found response". Not 403. A forbidden response
 * confirms the surface is there and that the caller's account is real but
 * unprivileged.
 *
 * `requireAdmin` already makes that decision, and makes it identically for an
 * absent account, a non-admin, and an admin whose own account is suspended —
 * one query, one message, no timing difference. This function's only job is to
 * carry that decision into the routing layer WITHOUT weakening it: the
 * not-found `AppError` becomes Next's not-found, and every other error is
 * rethrown rather than swallowed into a 404 that would hide a real fault.
 *
 * Note what this does NOT do: redirect an anonymous visitor to sign in. That
 * would confirm the surface exists to anyone who typed the address, which is
 * the whole thing the not-found answer is protecting. /studio redirects; /admin
 * does not, and the asymmetry is the point.
 */
import { notFound } from "next/navigation";
import type { Sql } from "@/shared/db";
import { isAppError } from "@/shared/errors";
import { requireAdmin, type AdminActor } from "@/modules/moderation";

export async function adminOrNotFound(
  db: Sql,
  userId: string | null | undefined,
): Promise<AdminActor> {
  try {
    return await requireAdmin(db, userId);
  } catch (error) {
    if (isAppError(error) && error.kind === "not_found") notFound();
    throw error;
  }
}
