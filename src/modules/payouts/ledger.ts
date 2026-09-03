/**
 * Appending to the ledger: the sale entry, and how it gets there.
 *
 * `artist-payouts`, *Ledger entry created*: "WHEN a fulfilment is paid THEN a
 * ledger entry is created with gross, commission, net payable, and a status of
 * pending."
 *
 * WHY `orders` DOES NOT CALL THIS
 * -------------------------------
 * The obvious implementation is a hook inside `orders.markPaymentReceived`.
 * ARCHITECTURE.md's dependency table forbids it: `payouts` may call `orders`,
 * not the reverse, and an `orders -> payouts` import is the kind of edge that
 * turns a boundary into a suggestion.
 *
 * So the direction is inverted. `recordFulfilmentPaid` is called by the route
 * that has just taken payment, and `accrueUnrecordedSales` is the sweep that
 * makes the first call an optimisation rather than a correctness requirement.
 * Both are idempotent against the same partial unique index, so a payment
 * confirmed twice, a sweep racing a route, or a route that crashed after
 * committing the payment and before recording the payout all converge on
 * exactly one sale entry. That property is the reason the sweep exists: a
 * cross-module hook that silently fails to fire loses an artist their money,
 * and there would be nothing in the system that noticed.
 *
 * WHERE THE MONEY COMES FROM
 * --------------------------
 *   gross  = `fulfilments.items_subtotal_agorot`. NOT the order subtotal, which
 *            on a two-artist order is both artists' work, and NOT plus
 *            `shipping_agorot`, which `artist-payouts` excludes from commission
 *            and `orders` keeps in a separate column so the mistake has to be
 *            deliberate.
 *   rate   = `orders.commission_rate_bp`, snapshotted at placement. Never
 *            `app_config` as it stands now: SECURITY.md S0-5 item 3, and
 *            `artist-payouts`, *Rate changes later* -- "existing orders retain
 *            the rate stored at their placement".
 *
 * The split itself is `commission.ts`, in integer basis points, proved there.
 */
import { AppError } from "@/shared/errors";
import type { Sql, Tx } from "@/shared/db";
import { fromDbValue, nonNegativeAgorot } from "@/shared/money";
import { splitCommissionBp } from "./commission";
import type { PayoutsDeps } from "./deps";
import { hasPayoutDetails } from "./bank-details";
import { payoutDetailsNeededNotification } from "./notifications";
import type { PayoutNotificationRequest } from "./ports";
import { LEDGER_COLUMNS, toLedgerEntry, type LedgerEntry, type LedgerEntryRow } from "./types";

/**
 * Fulfilment states in which the artist has earned the money.
 *
 * A positive list, so a state added to `orders` later defaults to NOT accruing.
 * `returned` and `cancelled` are absent because the sale was undone;
 * `awaiting_payment` because it has not happened yet. `return_requested` IS
 * present: the sale happened and a return may still be denied, and an entry that
 * exists but is never eligible is a truer record than no entry at all -- it is
 * also what lets the artist see the case rather than watch a payout vanish.
 */
const ACCRUABLE_FULFILMENT_STATES: ReadonlySet<string> = new Set([
  "paid",
  "shipped",
  "delivered",
  "return_requested",
]);

interface AccruableRow {
  readonly id: string;
  readonly artist_id: string;
  readonly order_id: string;
  readonly status: string;
  readonly items_subtotal_agorot: string;
  readonly commission_rate_bp: number;
}

const ACCRUABLE_SELECT = `
  select f.id, f.artist_id, f.order_id, f.status,
         f.items_subtotal_agorot, o.commission_rate_bp
    from fulfilments f
    join orders o on o.id = f.order_id
`;

export interface RecordFulfilmentPaidResult {
  readonly entry: LedgerEntry;
  /** False when an entry already existed -- a re-run, not an error. */
  readonly created: boolean;
  readonly notifications: readonly PayoutNotificationRequest[];
}

/**
 * Record what an artist earned on one fulfilment.
 *
 * Idempotent. Calling it twice returns the same entry with `created: false`,
 * because the second insert hits `payout_ledger_one_sale_per_fulfilment` and is
 * absorbed. That is the constraint doing the work rather than a read-then-write
 * check, which would have a window in it.
 *
 * Pass `tx` to join an open transaction -- the route that confirmed the payment
 * should, so the ledger entry and the payment commit together or not at all.
 */
export async function recordFulfilmentPaid(
  deps: PayoutsDeps,
  fulfilmentId: string,
  tx?: Tx,
): Promise<RecordFulfilmentPaidResult> {
  const run = async (handle: Tx): Promise<RecordFulfilmentPaidResult> => {
    const row = await handle.maybeOne<AccruableRow>(`${ACCRUABLE_SELECT} where f.id = $1`, [
      fulfilmentId,
    ]);
    if (row === null) {
      throw AppError.notFound("Fulfilment not found", {
        code: "payouts.fulfilment_not_found",
        details: { fulfilmentId },
      });
    }
    if (!ACCRUABLE_FULFILMENT_STATES.has(row.status)) {
      throw AppError.conflict(
        `A payout is recorded when a fulfilment is paid; this one is "${row.status}".`,
        {
          code: "payouts.fulfilment_not_paid",
          details: { fulfilmentId, status: row.status },
        },
      );
    }

    const existing = await handle.maybeOne<LedgerEntryRow>(
      `select ${LEDGER_COLUMNS} from payout_ledger
        where fulfilment_id = $1 and entry_type = 'sale'`,
      [fulfilmentId],
    );
    if (existing !== null) {
      return { entry: toLedgerEntry(existing), created: false, notifications: [] };
    }

    const entry = await appendSale(handle, row);

    // `artist-payouts`, *Artist prompted after first sale*. The prompt is
    // returned, not sent: see ./notifications.
    const notifications = (await hasPayoutDetails(handle, row.artist_id))
      ? []
      : [
          payoutDetailsNeededNotification({
            artistId: row.artist_id,
            netAgorot: entry.netAgorot,
          }),
        ];

    return { entry, created: true, notifications };
  };

  return tx ? run(tx) : deps.db.withTransaction(run);
}

/**
 * The reconciliation sweep: every accruable fulfilment with no sale entry.
 *
 * Run it on a schedule. It is what makes a missed call from the payment route
 * a delay rather than an artist never being paid, and it is cheap enough to run
 * often because the partial index makes "has a sale entry" a single lookup.
 */
export async function accrueUnrecordedSales(
  deps: PayoutsDeps,
  options: { readonly artistId?: string; readonly limit?: number } = {},
): Promise<{ readonly created: readonly LedgerEntry[] }> {
  const limit = options.limit ?? 500;

  return deps.db.withTransaction(async (tx) => {
    const { rows } = await tx.query<AccruableRow>(
      `${ACCRUABLE_SELECT}
        where f.status = any($1::text[])
          and ($2::uuid is null or f.artist_id = $2::uuid)
          and not exists (
            select 1 from payout_ledger l
             where l.fulfilment_id = f.id and l.entry_type = 'sale'
          )
        order by f.created_at
        limit $3`,
      [[...ACCRUABLE_FULFILMENT_STATES], options.artistId ?? null, limit],
    );

    const created: LedgerEntry[] = [];
    for (const row of rows) {
      created.push(await appendSale(tx, row));
    }
    return { created };
  });
}

/**
 * The insert.
 *
 * `on conflict ... do nothing` targets the partial unique index by restating its
 * predicate, so a concurrent accrual loses the race quietly instead of raising.
 * When it does lose, the row is read back rather than assumed, because the entry
 * the caller gets must be the one that actually exists.
 */
async function appendSale(sql: Sql, row: AccruableRow): Promise<LedgerEntry> {
  const subtotal = nonNegativeAgorot(fromDbValue(row.items_subtotal_agorot));
  const { commissionAgorot, netAgorot } = splitCommissionBp(subtotal, row.commission_rate_bp);

  const inserted = await sql.maybeOne<LedgerEntryRow>(
    `insert into payout_ledger (
       artist_id, fulfilment_id, order_id, entry_type,
       gross_agorot, commission_rate_bp, commission_agorot, net_agorot, reason
     ) values ($1, $2, $3, 'sale', $4, $5, $6, $7, $8)
     on conflict (fulfilment_id) where entry_type = 'sale' do nothing
     returning ${LEDGER_COLUMNS}`,
    [
      row.artist_id,
      row.id,
      row.order_id,
      String(subtotal),
      row.commission_rate_bp,
      String(commissionAgorot),
      String(netAgorot),
      "Sale recorded when the fulfilment was paid.",
    ],
  );
  if (inserted !== null) return toLedgerEntry(inserted);

  const existing = await sql.one<LedgerEntryRow>(
    `select ${LEDGER_COLUMNS} from payout_ledger
      where fulfilment_id = $1 and entry_type = 'sale'`,
    [row.id],
  );
  return toLedgerEntry(existing);
}

/** Every entry against one sale, oldest first: the sale, then what happened to it. */
export async function ledgerHistoryFor(
  sql: Sql,
  saleEntryId: string,
): Promise<readonly LedgerEntry[]> {
  const { rows } = await sql.query<LedgerEntryRow>(
    `select ${LEDGER_COLUMNS} from payout_ledger
      where id = $1 or parent_entry_id = $1
      order by seq`,
    [saleEntryId],
  );
  return rows.map(toLedgerEntry);
}
