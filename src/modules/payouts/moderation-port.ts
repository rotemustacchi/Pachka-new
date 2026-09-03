/**
 * The `PayoutLedgerPort` that `moderation` has been waiting for.
 *
 * `moderation/ports.ts` declares the interface and has been running against
 * `payoutLedgerUnavailable`, which reports `known: false` so that a suspension's
 * audit entry says "nobody checked" rather than "nothing owed". This is the real
 * one. Wire it into `ModerationDeps.payouts` and that distinction starts
 * carrying information.
 *
 * WHY THE TYPE IS NOT IMPORTED
 * ----------------------------
 * ARCHITECTURE.md's dependency table gives `payouts` edges to `orders` and
 * `accounts`, and none to `moderation`. Importing `PayoutLedgerPort` from
 * `@/modules/moderation` -- even as a type -- would add the edge the table does
 * not have. So the shape is restated here and satisfied structurally.
 *
 * That is not a hope. `tests/integration/payouts-moderation.test.ts` assigns
 * this value to the imported `PayoutLedgerPort` type, which is a compile error
 * if the two ever drift, and then drives a real suspension through
 * `moderation.suspendAccount` with this port wired in. A test file may import
 * anything; a module may not.
 *
 * BOTH METHODS TAKE THE CALLER'S `Sql`
 * ------------------------------------
 * moderation calls these from inside `withAdminAction`'s transaction, and its
 * port documentation is explicit that "an implementation that opens its own
 * transaction breaks the coupling SECURITY.md S1-14 item 3 requires". Neither
 * function below opens one.
 */
import type { Sql } from "@/shared/db";
import { eligibilityDelayDays } from "./config";

/** Structurally identical to `moderation.OutstandingPayouts`. */
export interface OutstandingPayouts {
  readonly known: boolean;
  readonly entryCount: number;
  readonly totalAgorot: bigint;
}

/** Structurally identical to `moderation.PayoutLedgerPort`. */
export interface PayoutLedgerPort {
  outstandingFor(sql: Sql, artistId: string): Promise<OutstandingPayouts>;
  flagForOperatorDecision(sql: Sql, artistId: string, auditEntryId: string): Promise<number>;
}

/**
 * The eligible-but-unsettled predicate, in SQL.
 *
 * The same rule as `eligibility.ts` -- delivered plus the window, no return
 * outstanding, not already settled -- narrowed to what the port asks for. It is
 * restated rather than shared because the port's answer must be a single
 * aggregate computed inside the caller's transaction, and because a suspension
 * must not depend on this module's richer view shape holding still.
 *
 * A payout already flagged by an earlier suspension still counts as outstanding.
 * The artist is still owed the money; what changed is that an operator has been
 * asked about it.
 */
const OUTSTANDING_PREDICATE = `
  l.entry_type = 'sale'
  and l.artist_id = $1
  and not exists (
    select 1 from payout_ledger s
     where s.parent_entry_id = l.id and s.entry_type = 'settlement'
  )
  and exists (
    select 1 from order_transitions t
     where t.fulfilment_id = l.fulfilment_id
       and t.to_status = 'delivered'
       and now() >= t.occurred_at + make_interval(days => $2::int)
  )
  and not exists (
    select 1 from returns r
     where r.fulfilment_id = l.fulfilment_id and r.status <> 'resolved_denied'
  )
  and exists (
    select 1 from fulfilments f
     where f.id = l.fulfilment_id
       and f.status not in ('return_requested', 'returned', 'cancelled')
  )
`;

export const sqlPayoutLedger: PayoutLedgerPort = {
  async outstandingFor(sql: Sql, artistId: string): Promise<OutstandingPayouts> {
    const delayDays = await eligibilityDelayDays(sql);

    const row = await sql.one<{ entries: string; total: string }>(
      `select count(*)::text as entries,
              coalesce(sum(l.net_agorot + coalesce(adj.net, 0)), 0)::text as total
         from payout_ledger l
         left join lateral (
           select sum(a.net_agorot) as net
             from payout_ledger a
            where a.parent_entry_id = l.id and a.entry_type = 'adjustment'
         ) adj on true
        where ${OUTSTANDING_PREDICATE}`,
      [artistId, delayDays],
    );

    return {
      // Wired in, so the answer is a fact about the artist rather than a gap.
      known: true,
      entryCount: Number(row.entries),
      // bigint, per the port: money is an integer count of agorot and this total
      // is not bounded by anything this module controls.
      totalAgorot: BigInt(row.total),
    };
  },

  /**
   * Append one `hold` entry against each outstanding sale, and return how many.
   *
   * The spec is emphatic that this RETAINS the entries -- "the ledger entries are
   * retained and flagged for operator decision rather than cancelled" -- and the
   * schema makes deleting or zeroing one impossible anyway: `payout_ledger` has
   * no UPDATE or DELETE policy for any role, revoked grants, and a trigger that
   * raises. So flagging can only BE an append, which is what this does.
   *
   * A `hold` moves no money (the schema's `payout_ledger_hold_shape` requires all
   * three figures to be zero), and it carries the id of the `admin_audit` entry
   * for the suspension, so an operator reading a flagged payout can see exactly
   * which action parked it and why.
   */
  async flagForOperatorDecision(sql: Sql, artistId: string, auditEntryId: string): Promise<number> {
    const delayDays = await eligibilityDelayDays(sql);

    const { rowCount } = await sql.query(
      `insert into payout_ledger (
         artist_id, fulfilment_id, order_id, entry_type, parent_entry_id,
         gross_agorot, commission_rate_bp, commission_agorot, net_agorot,
         audit_entry_id, reason
       )
       select l.artist_id, l.fulfilment_id, l.order_id, 'hold', l.id,
              0, l.commission_rate_bp, 0, 0,
              $3, 'Flagged for operator decision following an admin action on the artist''s account.'
         from payout_ledger l
        where ${OUTSTANDING_PREDICATE}
          -- Not twice for the same audit entry: a suspension recorded once
          -- flags each payout once, however many times the path is re-entered.
          and not exists (
            select 1 from payout_ledger h
             where h.parent_entry_id = l.id
               and h.entry_type = 'hold'
               and h.audit_entry_id = $3
          )`,
      [artistId, delayDays, auditEntryId],
    );

    return rowCount;
  },
};
