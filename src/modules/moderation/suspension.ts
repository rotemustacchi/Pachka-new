/**
 * Account suspension and reinstatement.
 *
 * Spec, "Account suspension": an admin can suspend an account; a suspended
 * artist's published artworks are withdrawn from public surfaces; the account
 * cannot sign in, publish, or place orders; it is reversible; and it is
 * recorded with a reason, acting admin, and timestamp.
 *
 * What this module does NOT do, and why:
 *
 * `moderation` does not write `account_status`. That table belongs to
 * `accounts` (ARCHITECTURE.md ownership map), so the state change goes through
 * `accounts.suspendAccount` -- a call the dependency table explicitly allows.
 * It is handed a `Database` that is really this transaction (see
 * ./tx-database), so the suspension and its audit entry are one write.
 *
 * `moderation` does not bulk-update artworks either. Withdrawal from public
 * surfaces is derived: the RLS policies read
 * `accounts.account_is_suspended(...)` at query time, so an artwork stops being
 * visible the moment the suspension row lands and comes back the moment it is
 * lifted -- which is also exactly what the "suspension lifted" scenario
 * requires, "excluding any individually removed", since a removed artwork's own
 * status keeps it out regardless. A bulk update would have to remember which
 * artworks it changed in order to reverse itself, and would get that wrong the
 * first time an artist unpublished something mid-suspension.
 */
import { reinstateAccount as accountsReinstate, suspendAccount as accountsSuspend } from "@/modules/accounts";
import { AppError } from "@/shared/errors";
import type { Sql, Tx } from "@/shared/db";
import { withAdminAction, type AdminActor } from "./admin";
import { recordAdminAction, type AuditEntry } from "./audit";
import type { ModerationDeps } from "./deps";
import { payoutLedgerUnavailable, type OutstandingPayouts } from "./ports";
import { txAsDatabase } from "./tx-database";

export interface SuspendAccountInput {
  /** The admin performing it. Authorised here, not by the caller. */
  readonly actorId: string;
  readonly userId: string;
  readonly reason: string;
  /** Free-text operator note, recorded on the audit entry. */
  readonly note?: string;
}

export interface SuspensionResult {
  readonly userId: string;
  readonly reason: string;
  readonly suspendedAt: Date;
  readonly audit: AuditEntry;
  readonly outstandingPayouts: OutstandingPayouts;
  /** How many ledger entries were flagged for an operator decision. */
  readonly payoutsFlagged: number;
}

export async function suspendAccount(
  deps: ModerationDeps,
  input: SuspendAccountInput,
): Promise<SuspensionResult> {
  const reason = input.reason?.trim() ?? "";
  if (reason.length === 0) {
    // Recorded "with a reason" is a spec requirement, not a nicety: a
    // suspension with no stated reason is not reversible by a second admin who
    // has to decide whether the first one was right.
    throw AppError.validation("A suspension must state a reason", {
      code: "moderation.suspension_reason_required",
      fields: { reason: ["Required"] },
    });
  }

  return withAdminAction(deps.db, input.actorId, async (tx, actor) => {
    await assertAccountExists(tx, input.userId);
    refuseSelfSuspension(actor, input.userId);

    // 1. The state change, through the owning module, on this transaction.
    await accountsSuspend({ db: txAsDatabase(tx), auth: deps.auth }, input.userId, reason);

    const suspended = await tx.one<{ suspended_at: Date }>(
      "select suspended_at from account_status where user_id = $1",
      [input.userId],
    );

    // 2. Outstanding payouts are retained and flagged -- never cancelled.
    const payouts = deps.payouts ?? payoutLedgerUnavailable;
    const outstanding = await payouts.outstandingFor(tx, input.userId);

    // 3. The audit entry, last, on the same transaction. If this throws,
    //    everything above it goes with it.
    const audit = await recordAdminAction(tx, {
      action: "account_suspension",
      targetType: "account",
      targetId: input.userId,
      note: input.note ?? "",
      details: {
        reason,
        outstanding_payouts_known: outstanding.known,
        outstanding_payout_entries: outstanding.entryCount,
        outstanding_payout_total_agorot: outstanding.totalAgorot.toString(),
        // Loud on purpose. Until `payouts` ships there is no ledger to ask, and
        // an operator reading this entry must be able to tell "nothing owed"
        // from "nobody checked".
        payout_review_required: !outstanding.known || outstanding.entryCount > 0,
      },
    });

    const flagged =
      outstanding.known && outstanding.entryCount > 0
        ? await payouts.flagForOperatorDecision(tx, input.userId, audit.id)
        : 0;

    return {
      userId: input.userId,
      reason,
      suspendedAt: suspended.suspended_at,
      audit,
      outstandingPayouts: outstanding,
      payoutsFlagged: flagged,
    };
  });
}

export interface ReinstateAccountInput {
  readonly actorId: string;
  readonly userId: string;
  readonly note?: string;
}

export interface ReinstatementResult {
  readonly userId: string;
  readonly audit: AuditEntry;
}

/**
 * Lift a suspension.
 *
 * Refuses an account that is not suspended, rather than writing a second audit
 * entry that says nothing happened. An audit log full of no-ops is how a real
 * entry gets missed.
 */
export async function reinstateAccount(
  deps: ModerationDeps,
  input: ReinstateAccountInput,
): Promise<ReinstatementResult> {
  return withAdminAction(deps.db, input.actorId, async (tx) => {
    await assertAccountExists(tx, input.userId);

    const status = await tx.one<{ suspended_at: Date | null; suspended_reason: string | null }>(
      "select suspended_at, suspended_reason from account_status where user_id = $1",
      [input.userId],
    );
    if (status.suspended_at === null) {
      throw AppError.conflict("That account is not suspended", {
        code: "moderation.not_suspended",
        details: { userId: input.userId },
      });
    }

    const previousReason = status.suspended_reason ?? "";

    await accountsReinstate({ db: txAsDatabase(tx), auth: deps.auth }, input.userId);

    const audit = await recordAdminAction(tx, {
      action: "account_reinstatement",
      targetType: "account",
      targetId: input.userId,
      note: input.note ?? "",
      details: {
        lifted_reason: previousReason,
        suspended_since: status.suspended_at.toISOString(),
      },
    });

    return { userId: input.userId, audit };
  });
}

/** Whether an account is currently suspended. A read, so it takes any `Sql`. */
export async function isAccountSuspended(sql: Sql, userId: string): Promise<boolean> {
  const row = await sql.maybeOne<{ suspended: boolean }>(
    "select suspended_at is not null as suspended from account_status where user_id = $1",
    [userId],
  );
  return row?.suspended ?? false;
}

async function assertAccountExists(tx: Tx, userId: string): Promise<void> {
  const row = await tx.maybeOne<{ user_id: string }>(
    "select user_id from account_status where user_id = $1",
    [userId],
  );
  if (!row) {
    throw AppError.notFound("No such account", {
      code: "moderation.account_not_found",
      details: { userId },
    });
  }
}

function refuseSelfSuspension(actor: AdminActor, userId: string): void {
  // Not in the spec, and it should be: an admin suspending themselves locks the
  // only privileged account out of the system that would let them undo it.
  if (actor.userId === userId) {
    throw AppError.conflict("An admin cannot suspend their own account", {
      code: "moderation.self_suspension",
    });
  }
}
