/**
 * What `payouts` needs from a module it is not allowed to import.
 *
 * ARCHITECTURE.md's dependency table gives `payouts` two outgoing edges,
 * `orders` and `accounts`. It does not give it `moderation`. But two things
 * this module must do are admin actions, and ARCHITECTURE.md is equally
 * explicit that the audit writer lives with the table it writes -- "other
 * modules record their admin actions by calling `moderation`'s public API on
 * their own open transaction, which is what makes the action and its audit row
 * atomic":
 *
 *   * Settling a payout. SECURITY.md S1-14 lists `payout_settlement` among the
 *     actions that must be audited, and moderation's `admin_audit.action` check
 *     constraint already contains it.
 *   * Revealing an artist's bank details. SECURITY.md S1-11 item 2: "revealing
 *     writes an `admin_audit` row with actor, artist, and timestamp. This is the
 *     control that makes an insider read detectable."
 *
 * The two instructions cannot both be followed with an import, so this module
 * does what `moderation` itself did when it needed `payout_ledger` before this
 * module existed: it writes the interface down, implements its own side
 * against it, and the composition root supplies the implementation.
 * **Raised with the lead architect rather than resolved by adding the import.**
 *
 * Every method takes an `Sql` -- which a `Tx` satisfies -- because both are
 * called from inside the action's own transaction. An implementation that opens
 * its own transaction breaks the coupling S1-14 item 3 requires, and
 * `payouts-settlement.test.ts` catches it: it asserts that a settlement whose
 * audit write fails leaves no ledger entry behind.
 *
 * THE STAND-IN FAILS CLOSED, AND THAT IS THE POINT
 * ------------------------------------------------
 * ARCHITECTURE.md distinguishes two kinds of unwired port by what "absent"
 * means. Absent is safe for moderation's suspension check, where it means
 * not-suspended. It is not safe here: an unwired audit writer would mean money
 * leaving the platform with no record of who released it, which is the precise
 * scenario the audit log exists for. So `auditUnavailable` raises, and every
 * admin path in this module refuses to run without a real one.
 */
import { AppError } from "@/shared/errors";
import type { Sql } from "@/shared/db";
import type { NotificationRequest as MailNotificationRequest } from "@/shared/mail";

/** Mirrors `moderation.AdminActor`. Structural, so no import is needed. */
export interface PayoutAdminActor {
  readonly userId: string;
}

/**
 * One admin action's worth of audit.
 *
 * A deliberately narrow subset of `moderation.AdminActionRecord`: this module
 * only ever records two of the nine actions, and both target a payout or an
 * account. Widening it would let a payouts code path record a takedown.
 */
export interface PayoutAuditRecord {
  readonly action: "payout_settlement" | "payout_details_access";
  readonly targetType: "payout" | "account";
  readonly targetId: string;
  readonly note?: string;
  readonly details?: Readonly<Record<string, unknown>>;
}

export interface PayoutAuditEntry {
  readonly id: string;
}

export interface AdminActionPort {
  /**
   * Authorise `userId` as an admin AND publish them into the session as the
   * acting identity, both on `sql`.
   *
   * The second half is not optional and is easy to forget. `admin_audit`'s
   * chain trigger stamps the actor from `auth.uid()` and refuses an entry with
   * no acting identity in the session, so an implementation that authorises
   * without publishing produces a settlement that cannot be audited -- and,
   * because the audit and the action share a transaction, no settlement at all.
   * `moderation.withAdminAction` does exactly this; wrapping it is the intended
   * implementation.
   *
   * Refuses as NOT FOUND rather than forbidden, per moderation's own rule: a
   * 403 confirms the surface exists.
   */
  authorise(sql: Sql, userId: string | null | undefined): Promise<PayoutAdminActor>;

  /** Append one audit entry on the SAME `sql` the action is running on. */
  record(sql: Sql, entry: PayoutAuditRecord): Promise<PayoutAuditEntry>;
}

/**
 * The stand-in until the composition root wires `moderation` in.
 *
 * It is not a fake and not a no-op: it refuses. An admin path that ran against
 * this would move money and record nothing.
 */
export const auditUnavailable: AdminActionPort = {
  async authorise(): Promise<PayoutAdminActor> {
    throw unwired();
  },
  async record(): Promise<PayoutAuditEntry> {
    throw unwired();
  },
};

function unwired(): AppError {
  return AppError.externalFailure(
    "Payout admin actions are unavailable: no audit writer is wired in. " +
      "Wire moderation's requireAdmin/recordAdminAction into PayoutsDeps.admin.",
    { code: "payouts.audit_writer_unwired" },
  );
}

/**
 * The one genuinely external boundary this module has.
 *
 * THE shared descriptor, narrowed to the two audiences a payout ever addresses:
 * the artist being paid, and the operator who has to move the money by hand. A
 * buyer is never told anything about a payout, and now the type says so.
 *
 * It used to be a third structurally identical declaration whose header
 * explained that a third shape would mean a third dispatcher. The dispatcher
 * was always going to be one; it is the type that had to stop being four.
 *
 * Nothing here sends anything. Every function that has something to tell
 * somebody RETURNS these and the caller dispatches them after the transaction
 * commits, so nobody is emailed about a settlement that rolled back -- and so
 * this module needs no mailer, and therefore no fake, in any of its tests.
 */
export type PayoutNotificationAudience = "artist" | "admin";

export type PayoutNotificationRequest = MailNotificationRequest<PayoutNotificationAudience>;
