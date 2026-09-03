/**
 * When a payout becomes payable, and why it might not be.
 *
 * `artist-payouts`: "A payout SHALL become eligible only when its fulfilment has
 * been in `delivered` state for the full 14-day return window without a return
 * request. A fulfilment under `return_requested` SHALL NOT be eligible. The
 * artist SHALL be able to see the exact date their payout becomes eligible."
 *
 * WHERE THE CLOCK COMES FROM, AND WHERE IT DOES NOT
 * -------------------------------------------------
 * From `order_transitions`, filtered to the `-> delivered` edge for this
 * fulfilment, on the server-written `occurred_at`. NOT from
 * `fulfilments.delivered_at`, even though `orders` stamps that column itself and
 * it holds the same instant today.
 *
 * SECURITY.md S1-10 item 2 is explicit -- "eligibility is computed from the
 * server-written timestamp on the `order_transitions` row for the `-> delivered`
 * edge; no date supplied by any client is an input to eligibility" -- and the
 * distinction is testable rather than decorative. `order_transitions` has no
 * UPDATE policy for any role and is written only by `orders.transition()`;
 * `fulfilments` is an updatable row. A fulfilment that acquired a
 * `delivered_at` some other way -- a stray UPDATE, a seed script, an import --
 * has no transition row, and this module therefore reports it as never
 * delivered. `payouts-eligibility.test.ts` sets exactly that trap.
 *
 * The LATEST such transition wins, not the earliest. A parcel that went
 * delivered -> return_requested -> ... -> delivered again restarts its window,
 * because the window is about the buyer's opportunity to send it back and the
 * second delivery opened a second one. Taking the latest can only ever push
 * eligibility later, which is the safe direction for a rule about paying money
 * out.
 *
 * WHAT AN OPEN RETURN MEANS
 * -------------------------
 * Every return case blocks except `resolved_denied`. `shipping`'s six statuses
 * split three ways: `requested`, `disputed` and `unreceived` are live cases;
 * `received_intact` and `resolved_refunded` released the buyer's money, so the
 * sale is undone and there is nothing to pay; `resolved_denied` is the one
 * outcome where an admin decided against the buyer and the artist keeps the
 * sale. Stated as a single exception rather than a list of blockers so that a
 * status added to `shipping` later defaults to WITHHOLDING the payout -- the
 * same fail-closed choice `orders.views` makes with its disclosing states, for
 * the same reason.
 */
import type { Sql } from "@/shared/db";
import { fromDbValue, type Agorot } from "@/shared/money";
import { LEDGER_COLUMNS, toLedgerEntry, type LedgerEntry, type PayoutStatus } from "./types";

/**
 * Why a payout is not payable right now. `null` when it is.
 *
 * A closed set, because the artist's dashboard and the operator's queue both
 * render an explanation and neither should be switching on prose.
 */
export type PayoutBlockReason =
  | "awaiting_delivery"
  | "within_return_window"
  | "return_open"
  | "fulfilment_returned"
  | "flagged_for_operator"
  | null;

export interface PayoutView {
  /** The `sale` entry itself. */
  readonly entry: LedgerEntry;
  readonly status: PayoutStatus;
  readonly blockedBy: PayoutBlockReason;

  /** Server-stamped, from `order_transitions`. Null until the parcel is delivered. */
  readonly deliveredAt: string | null;
  /**
   * THE DATE THE ARTIST IS SHOWN (`artist-payouts`, *Artist sees the date*).
   * Null until delivery, because before then there is no honest answer.
   */
  readonly eligibleAt: string | null;

  /** Sum of every adjusting entry against this sale. Signed. */
  readonly adjustmentsNetAgorot: Agorot;
  /** Net plus adjustments: what settling this payout would actually pay. */
  readonly payableNetAgorot: Agorot;

  readonly settledOn: string | null;
  readonly bankReference: string | null;
  /** The `admin_audit` entry of the hold, when one is in force. */
  readonly heldByAuditEntryId: string | null;
  readonly heldReason: string | null;
}

interface PayoutViewRow {
  readonly id: string;
  readonly seq: string;
  readonly artist_id: string;
  readonly fulfilment_id: string;
  readonly order_id: string;
  readonly entry_type: string;
  readonly parent_entry_id: string | null;
  readonly gross_agorot: string;
  readonly commission_rate_bp: number;
  readonly commission_agorot: string;
  readonly net_agorot: string;
  readonly settled_on: Date | string | null;
  readonly bank_reference: string | null;
  readonly settled_by: string | null;
  readonly audit_entry_id: string | null;
  readonly reason: string;
  readonly created_at: Date | string;

  readonly delivered_at: Date | null;
  readonly eligible_at: Date | null;
  readonly now_at_or_past_eligible: boolean;
  readonly fulfilment_status: string;
  readonly return_open: boolean;
  readonly settlement_on: Date | string | null;
  readonly settlement_reference: string | null;
  readonly hold_audit_entry_id: string | null;
  readonly hold_reason: string | null;
  readonly adjustments_net: string;
}

/**
 * The one query that decides eligibility, written once.
 *
 * Every read path in this module -- the artist's dashboard, the operator's
 * queue, `moderation`'s outstanding-payout check, and the recheck inside the
 * settlement transaction -- selects from this. SECURITY.md S1-10 item 3 requires
 * that settlement re-evaluate eligibility inside its own transaction rather than
 * trust a cached view; that is only meaningful if the recheck asks the same
 * question the queue asked, and one string is the only way to guarantee it.
 *
 * `$1` is the eligibility delay in days, read from `app_config` by the caller.
 * It is interpolated as a bound parameter into an interval rather than into the
 * SQL text, so the value that decides when money moves cannot be a string
 * anybody concatenated.
 */
const PAYOUT_VIEW_SQL = `
  select
    ${LEDGER_COLUMNS},
    d.delivered_at,
    d.delivered_at + make_interval(days => $1::int)                      as eligible_at,
    (d.delivered_at is not null
       and now() >= d.delivered_at + make_interval(days => $1::int))     as now_at_or_past_eligible,
    f.status                                                             as fulfilment_status,
    exists (
      select 1 from returns r
       where r.fulfilment_id = l.fulfilment_id
         and r.status <> 'resolved_denied'
    )                                                                    as return_open,
    s.settled_on                                                         as settlement_on,
    s.bank_reference                                                     as settlement_reference,
    h.audit_entry_id                                                     as hold_audit_entry_id,
    h.reason                                                             as hold_reason,
    coalesce(adj.net, 0)::text                                           as adjustments_net
  from payout_ledger l
  join fulfilments f on f.id = l.fulfilment_id
  -- The clock. A LEFT JOIN, so an undelivered fulfilment yields a row with a
  -- null date rather than vanishing: an artist must be able to see a pending
  -- payout, not just an eligible one.
  left join lateral (
    select max(t.occurred_at) as delivered_at
      from order_transitions t
     where t.fulfilment_id = l.fulfilment_id
       and t.to_status = 'delivered'
  ) d on true
  -- Unique by partial index, so this cannot fan out.
  left join lateral (
    select x.settled_on, x.bank_reference
      from payout_ledger x
     where x.parent_entry_id = l.id and x.entry_type = 'settlement'
     limit 1
  ) s on true
  -- Holds are NOT unique: an account can be suspended more than once. The most
  -- recent one is the one in force.
  left join lateral (
    select x.audit_entry_id, x.reason
      from payout_ledger x
     where x.parent_entry_id = l.id and x.entry_type = 'hold'
     order by x.seq desc
     limit 1
  ) h on true
  left join lateral (
    select sum(x.net_agorot) as net
      from payout_ledger x
     where x.parent_entry_id = l.id and x.entry_type = 'adjustment'
  ) adj on true
  where l.entry_type = 'sale'
`;

/** Fulfilment states in which there is no sale left to pay for. */
const UNPAYABLE_FULFILMENT_STATES: ReadonlySet<string> = new Set([
  "return_requested",
  "returned",
  "cancelled",
]);

function toPayoutView(row: PayoutViewRow): PayoutView {
  const settled = row.settlement_on !== null;
  const held = row.hold_audit_entry_id !== null;

  const blockedBy = ((): PayoutBlockReason => {
    if (settled) return null;
    if (UNPAYABLE_FULFILMENT_STATES.has(row.fulfilment_status)) return "fulfilment_returned";
    if (row.return_open) return "return_open";
    if (row.delivered_at === null) return "awaiting_delivery";
    if (!row.now_at_or_past_eligible) return "within_return_window";
    if (held) return "flagged_for_operator";
    return null;
  })();

  const status: PayoutStatus = settled
    ? "settled"
    : held
      ? "held"
      : blockedBy === null
        ? "eligible"
        : "pending";

  const entry = toLedgerEntry(row);
  const adjustments = fromDbValue(row.adjustments_net);

  return {
    entry,
    status,
    blockedBy,
    deliveredAt: row.delivered_at === null ? null : row.delivered_at.toISOString(),
    eligibleAt: row.eligible_at === null ? null : row.eligible_at.toISOString(),
    adjustmentsNetAgorot: adjustments,
    payableNetAgorot: (entry.netAgorot + adjustments) as Agorot,
    settledOn: settledOnOf(row),
    bankReference: row.settlement_reference,
    heldByAuditEntryId: row.hold_audit_entry_id,
    heldReason: row.hold_reason,
  };
}

function settledOnOf(row: PayoutViewRow): string | null {
  const value = row.settlement_on;
  if (value === null) return null;
  if (typeof value === "string") return value.slice(0, 10);
  const year = value.getFullYear();
  const month = `${value.getMonth() + 1}`.padStart(2, "0");
  const day = `${value.getDate()}`.padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/** Every payout for one artist, newest first. */
export async function payoutViewsForArtist(
  sql: Sql,
  artistId: string,
  delayDays: number,
): Promise<readonly PayoutView[]> {
  const { rows } = await sql.query<PayoutViewRow>(
    `${PAYOUT_VIEW_SQL} and l.artist_id = $2 order by l.seq desc`,
    [delayDays, artistId],
  );
  return rows.map(toPayoutView);
}

/**
 * One payout, by the id of its `sale` entry.
 *
 * `forUpdate` takes a row lock on the sale entry. Settlement passes it, and that
 * is what makes two operators clicking the same button at the same moment
 * serialise: the second waits, then re-reads and finds the settlement the first
 * one appended. `select ... for update` does not fire the append-only trigger --
 * it locks the row, it does not write it -- so the lock and the immutability
 * coexist. The partial unique index is still there underneath as the structural
 * guarantee (SECURITY.md S1-10 item 4); the lock exists to turn a constraint
 * violation into a sentence an operator can read.
 */
export async function payoutViewById(
  sql: Sql,
  entryId: string,
  delayDays: number,
  options: { readonly forUpdate?: boolean } = {},
): Promise<PayoutView | null> {
  if (options.forUpdate) {
    // Locked first, in its own statement: `for update` cannot be applied to the
    // left-joined query above without also trying to lock the outer-joined
    // relations, which Postgres refuses.
    const locked = await sql.maybeOne<{ id: string }>(
      "select id from payout_ledger where id = $1 and entry_type = 'sale' for update",
      [entryId],
    );
    if (locked === null) return null;
  }

  const row = await sql.maybeOne<PayoutViewRow>(`${PAYOUT_VIEW_SQL} and l.id = $2`, [
    delayDays,
    entryId,
  ]);
  return row === null ? null : toPayoutView(row);
}

/** Every eligible, unsettled payout across all artists, oldest first. */
export async function eligiblePayoutViews(
  sql: Sql,
  delayDays: number,
  options: { readonly includeFlagged?: boolean; readonly artistId?: string } = {},
): Promise<readonly PayoutView[]> {
  const views = await (async () => {
    if (options.artistId !== undefined) {
      const { rows } = await sql.query<PayoutViewRow>(
        `${PAYOUT_VIEW_SQL} and l.artist_id = $2 order by l.seq asc`,
        [delayDays, options.artistId],
      );
      return rows.map(toPayoutView);
    }
    const { rows } = await sql.query<PayoutViewRow>(`${PAYOUT_VIEW_SQL} order by l.seq asc`, [
      delayDays,
    ]);
    return rows.map(toPayoutView);
  })();

  return views.filter((view) => {
    if (view.status === "eligible") return true;
    // A held payout IS eligible in every respect except that an admin action
    // parked it. It appears only when the caller asks, so the ordinary payable
    // queue is not quietly padded with entries nobody may pay yet.
    return options.includeFlagged === true && view.status === "held" && isPayableIgnoringHold(view);
  });
}

/** True when the only thing standing between this payout and settlement is a hold. */
export function isPayableIgnoringHold(view: PayoutView): boolean {
  return (
    view.settledOn === null &&
    view.deliveredAt !== null &&
    (view.blockedBy === null || view.blockedBy === "flagged_for_operator")
  );
}
