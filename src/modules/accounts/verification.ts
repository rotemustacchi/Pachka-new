/**
 * Email verification, and the gate it puts on publishing and ordering.
 *
 * accounts-and-profiles, "Email verification gates selling and buying": a
 * verified address is required before an account may publish an artwork or
 * place an order. Browsing is not gated.
 *
 * The verified state belongs to the auth provider. What lives here is a mirror,
 * written server-side only, refreshed whenever the provider tells us something
 * new. It is a mirror and not the authority, and the distinction is the one
 * SECURITY.md S0-2 item 1 draws about `app_metadata`: a cache is fine, but it
 * is never what a money or admin decision is made on. This particular mirror
 * gates publishing and ordering, which are neither, and `assertEmailVerified`
 * exists so that the two modules which need the gate ask one question rather
 * than each inventing their own.
 */
import { AppError } from "@/shared/errors";
import type { Sql } from "@/shared/db";
import type { AccountsDeps } from "./deps";

/** Write the provider's answer into the local mirror. */
export async function recordVerification(
  db: Sql,
  userId: string,
  verifiedAt: Date | null,
): Promise<void> {
  await db.query(
    `update account_status
        set verified_at = case
              -- Once verified, stays verified. A provider hiccup returning null
              -- must not silently un-verify an account mid-session.
              when $2::timestamptz is null then verified_at
              else $2::timestamptz
            end
      where user_id = $1`,
    [userId, verifiedAt],
  );
}

/**
 * Ask the provider and update the mirror. Called when the visitor comes back
 * from the verification link.
 */
export async function syncEmailVerification(
  deps: AccountsDeps,
  userId: string,
): Promise<boolean> {
  const user = await deps.auth.getUser(userId);
  if (!user) throw AppError.notFound("No such account.", { code: "accounts.no_such_account" });

  await recordVerification(deps.db, userId, user.emailVerifiedAt);
  return user.emailVerifiedAt !== null;
}

export async function isEmailVerified(db: Sql, userId: string): Promise<boolean> {
  const row = await db.maybeOne<{ verified: boolean }>(
    "select verified_at is not null as verified from account_status where user_id = $1",
    [userId],
  );
  return row?.verified ?? false;
}

/** What the account was trying to do, so the message can say so. */
export type GatedAction = "publish" | "order";

const PROMPT: Readonly<Record<GatedAction, string>> = {
  publish: "Please verify your email address before publishing an artwork.",
  order: "Please verify your email address before placing an order.",
};

/**
 * The gate. Throws unless the account's address is verified.
 *
 * Exported from the module's public API so that `artworks` and `orders` call
 * this rather than reading `account_status` themselves -- no module reads
 * another module's tables directly, and a second implementation of this rule is
 * a second place for it to drift.
 */
export async function assertEmailVerified(
  db: Sql,
  userId: string,
  action: GatedAction,
): Promise<void> {
  if (await isEmailVerified(db, userId)) return;

  throw AppError.forbidden(PROMPT[action], {
    code: "accounts.email_not_verified",
    details: { action },
  });
}

/**
 * Resend the verification email.
 *
 * Rate-limited through the password-reset bucket: both are "make PACHKA send
 * mail to an address I typed", which is the abuse shape that matters
 * (SECURITY.md S2-21).
 */
export async function resendVerificationEmail(
  deps: AccountsDeps,
  userId: string,
): Promise<void> {
  await deps.auth.sendVerificationEmail(userId);
}
