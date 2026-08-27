/**
 * The append-only admin audit log.
 *
 * ARCHITECTURE.md sketches this as `shared/audit`. It is here instead, because
 * `moderation` owns the `admin_audit` table in the same document's ownership
 * map and the write boundary for this work is `modules/moderation`. Reported to
 * the lead architect; moving the writer to `shared/audit` later is an export
 * change and nothing else, because everything below takes an `Sql` and holds no
 * moderation state.
 *
 * The database does the load-bearing work -- see
 * `db/migrations/20260827T150000_moderation_admin_audit.sql`. What is enforced
 * where, so that nobody reading only this file draws the wrong conclusion:
 *
 *   actor and timestamp   trigger, from the session. Anything passed from here
 *                         is discarded before the row lands.
 *   append-only           revoked grants plus a BEFORE UPDATE OR DELETE trigger.
 *   hash chain            BEFORE INSERT trigger; any insert is chained, not
 *                         just the ones that come through this function.
 *   same transaction      here, and only here: `recordAdminAction` takes the
 *                         caller's `Sql`. Handing it a `Database` instead of a
 *                         `Tx` would silently decouple the two writes, which is
 *                         what `moderation-audit.test.ts` exists to catch.
 */
import { AppError } from "@/shared/errors";
import type { Sql } from "@/shared/db";

/**
 * The closed set of recorded actions, mirroring the CHECK constraint on
 * `admin_audit.action`. SECURITY.md S1-14 names six; SPEC-K adds
 * `payout_details_access` and S1-16 adds `config_change`.
 */
export const AUDIT_ACTIONS = [
  "artwork_takedown",
  "account_suspension",
  "account_reinstatement",
  "report_resolution",
  "commission_change",
  "config_change",
  "rate_table_change",
  "payout_settlement",
  "payout_details_access",
] as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[number];

export const AUDIT_TARGET_TYPES = [
  "artwork",
  "account",
  "report",
  "config",
  "shipping_rate",
  "payout",
] as const;

export type AuditTargetType = (typeof AUDIT_TARGET_TYPES)[number];

export interface AdminActionRecord {
  readonly action: AuditAction;
  readonly targetType: AuditTargetType;
  /** Text, not uuid: a config change targets a key, not a row. */
  readonly targetId: string;
  readonly note?: string;
  readonly details?: Readonly<Record<string, unknown>>;
}

export interface AuditEntry {
  readonly id: string;
  readonly seq: number;
  readonly actor: string;
  readonly at: Date;
  readonly action: AuditAction;
  readonly targetType: AuditTargetType;
  readonly targetId: string;
  readonly note: string;
  readonly details: Readonly<Record<string, unknown>>;
  /** Hex. Exposed so a reader can chain-check without a round trip per row. */
  readonly prevHash: string;
  readonly rowHash: string;
}

interface AuditRow {
  readonly id: string;
  readonly seq: string;
  readonly actor: string;
  readonly at: Date;
  readonly action: AuditAction;
  readonly target_type: AuditTargetType;
  readonly target_id: string;
  readonly note: string;
  readonly details: Record<string, unknown>;
  readonly prev_hash: string;
  readonly row_hash: string;
}

function toEntry(row: AuditRow): AuditEntry {
  return {
    id: row.id,
    seq: Number(row.seq),
    actor: row.actor,
    at: row.at,
    action: row.action,
    targetType: row.target_type,
    targetId: row.target_id,
    note: row.note,
    details: row.details,
    prevHash: row.prev_hash,
    rowHash: row.row_hash,
  };
}

const RETURNING = `
  id, seq::text as seq, actor, at, action, target_type, target_id, note, details,
  encode(prev_hash, 'hex') as prev_hash, encode(row_hash, 'hex') as row_hash
`;

/**
 * Append one entry.
 *
 * Takes an `Sql` rather than a `Database` on purpose: pass the `Tx` of the
 * action being recorded and the two commit or roll back together. There is no
 * overload that opens its own transaction, because the moment one exists
 * somebody uses it.
 *
 * `action`, `targetType` and `targetId` are validated here as well as by the
 * CHECK constraints. Not redundancy for its own sake: a caller that passes an
 * action the database rejects would take its own transaction down with it, and
 * "you cannot record that action" is a clearer failure than a constraint
 * violation surfacing from three frames away.
 *
 * `note` length is deliberately NOT validated here. The 2000-character bound
 * lives on the column, and letting it fail there is what proves the audit write
 * and the action share a transaction.
 */
export async function recordAdminAction(
  sql: Sql,
  record: AdminActionRecord,
): Promise<AuditEntry> {
  if (!AUDIT_ACTIONS.includes(record.action)) {
    throw AppError.validation(`Not a recordable admin action: "${record.action}"`, {
      code: "moderation.unknown_audit_action",
      details: { action: record.action },
    });
  }
  if (!AUDIT_TARGET_TYPES.includes(record.targetType)) {
    throw AppError.validation(`Not an audit target type: "${record.targetType}"`, {
      code: "moderation.unknown_audit_target_type",
      details: { targetType: record.targetType },
    });
  }
  if (record.targetId.trim().length === 0) {
    throw AppError.validation("An audit entry must name what it acted on", {
      code: "moderation.audit_target_required",
    });
  }

  const row = await sql.one<AuditRow>(
    `insert into admin_audit (actor, at, action, target_type, target_id, note, details)
     -- actor and at are overwritten by the chain trigger from the session.
     -- The placeholders below exist because the columns are NOT NULL, and are
     -- the values a caller would have to forge; the test asserts they do not
     -- survive.
     values (gen_random_uuid(), now(), $1, $2, $3, coalesce($4, ''), coalesce($5::jsonb, '{}'::jsonb))
     returning ${RETURNING}`,
    [
      record.action,
      record.targetType,
      record.targetId,
      record.note ?? "",
      record.details ? JSON.stringify(record.details) : null,
    ],
  );

  return toEntry(row);
}

export interface AuditTrailFilter {
  readonly targetType?: AuditTargetType;
  readonly targetId?: string;
  readonly action?: AuditAction;
  readonly limit?: number;
}

/** The trail, newest first. Read-only; there is no other kind of access. */
export async function readAuditTrail(
  sql: Sql,
  filter: AuditTrailFilter = {},
): Promise<AuditEntry[]> {
  const { rows } = await sql.query<AuditRow>(
    `select ${RETURNING}
       from admin_audit
      where ($1::text is null or target_type = $1)
        and ($2::text is null or target_id = $2)
        and ($3::text is null or action = $3)
      order by seq desc
      limit $4`,
    [
      filter.targetType ?? null,
      filter.targetId ?? null,
      filter.action ?? null,
      Math.min(Math.max(filter.limit ?? 100, 1), 500),
    ],
  );
  return rows.map(toEntry);
}

export interface ChainVerification {
  readonly ok: boolean;
  /** Where the chain first stops making sense, or null when it never does. */
  readonly brokenSeq: number | null;
  /**
   * `link_broken`        — this entry does not follow the one before it, which
   *                        is what a DELETED predecessor looks like.
   * `row_altered`        — this entry's contents no longer hash to its stored
   *                        hash: an in-place edit.
   * `checkpoint_missing` — an entry that was known to exist is gone. Only
   *                        reachable by passing a checkpoint; see below.
   */
  readonly reason: "link_broken" | "row_altered" | "checkpoint_missing" | null;
}

export interface ChainVerificationOptions {
  /**
   * A `rowHash` (hex) recorded earlier, from outside this table.
   *
   * The chain catches alteration and mid-log deletion on its own. It cannot
   * catch entries cut from the END, because nothing is left behind to fail to
   * link — inside the table, "the log stops here" and "the log was cut here"
   * are the same picture. A hash kept elsewhere — by the alerting job, in an
   * off-site copy, in the operator's own record of an action — is what closes
   * that gap, and this is where you hand it back.
   */
  readonly checkpoint?: string;
}

/**
 * Walk the chain and report the first break.
 *
 * This is the control that still works after everything else has been defeated.
 * Revoked grants and the immutability trigger stop the application and the data
 * API; neither stops a superuser, and neither stops someone restoring a doctored
 * backup. The chain does not stop them either -- it makes them visible, which
 * for an audit log is the property that matters.
 *
 * SECURITY.md wants this on a schedule with an alert on a break. Nothing in
 * this module owns a scheduler; whatever sweeps the database calls it.
 */
export async function verifyAuditChain(
  sql: Sql,
  options: ChainVerificationOptions = {},
): Promise<ChainVerification> {
  const row = await sql.one<{
    ok: boolean;
    broken_seq: string | null;
    reason: ChainVerification["reason"];
  }>(
    `select ok, broken_seq::text as broken_seq, reason
       from moderation.verify_audit_chain(decode($1, 'hex'))`,
    [options.checkpoint ?? null],
  );

  return {
    ok: row.ok,
    brokenSeq: row.broken_seq === null ? null : Number(row.broken_seq),
    reason: row.reason,
  };
}
