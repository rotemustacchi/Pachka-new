/**
 * The payouts domain types, and the one place a `payout_ledger` row becomes one.
 *
 * Two rules borrowed from `orders/types.ts` because they are the same two rules
 * and a second answer would be a bug:
 *
 * 1. Every money column is `bigint`, which node-postgres hands back as a STRING
 *    so values above 2^53 survive the trip. `shared/money`'s `fromDbValue` is
 *    the only sanctioned way to turn that string into money, so no other file in
 *    this module is tempted to reach for `Number()`.
 *
 * 2. Mapping is explicit, key by key, with no spread. In this module the reason
 *    is sharper than usual: the shapes below are handed to an artist's dashboard
 *    and to an operator's queue, and a spread would make what reaches them
 *    depend on whatever a query happened to select. SECURITY.md S1-11's entire
 *    finding is about bank details arriving somewhere nobody looked -- and the
 *    defence it asks for is an allowlist serializer, which is what an explicit
 *    key-by-key mapper is.
 *
 * There is deliberately NO bank detail on any type in this file. `payout_ledger`
 * has no such column, and `artist_payout_details` is never joined into a ledger
 * read. See `bank-details.ts`, which is the only file in the module that touches
 * that table at all.
 */
import { fromDbValue, type Agorot } from "@/shared/money";

/**
 * What an entry does.
 *
 * `sale` is the only one that creates money owed. The other three all reference
 * an earlier entry, which is what `artist-payouts` means by "corrections SHALL
 * be recorded as new adjusting entries rather than edits".
 */
export const LEDGER_ENTRY_TYPES = ["sale", "settlement", "adjustment", "hold"] as const;
export type LedgerEntryType = (typeof LEDGER_ENTRY_TYPES)[number];

/**
 * The status of a payout, which is DERIVED and never stored.
 *
 * See the migration header for why there is no status column. In short: the
 * table is append-only, a status column would have to be updated, and the
 * update is exactly what the trigger refuses.
 *
 *   pending   the sale is recorded; the return window has not closed, or the
 *             parcel has not been delivered at all yet
 *   eligible  delivered plus the full return window, no return outstanding,
 *             not settled, not held
 *   settled   an operator recorded a bank transfer against it
 *   held      an admin action parked it for an operator decision -- a
 *             suspension, per SECURITY.md S1-13
 */
export const PAYOUT_STATUSES = ["pending", "eligible", "settled", "held"] as const;
export type PayoutStatus = (typeof PAYOUT_STATUSES)[number];

export interface LedgerEntry {
  readonly id: string;
  /** Append order. Quoted in the append-only trigger's error, and in operator reports. */
  readonly seq: number;
  readonly artistId: string;
  readonly fulfilmentId: string;
  readonly orderId: string;
  readonly entryType: LedgerEntryType;
  /** The entry this one acts on. Null only on a `sale`. */
  readonly parentEntryId: string | null;

  /** A signed delta to the artist's balance -- see the migration header. */
  readonly grossAgorot: Agorot;
  /** Snapshotted from the order at placement. Never the current configured rate. */
  readonly commissionRateBp: number;
  readonly commissionAgorot: Agorot;
  readonly netAgorot: Agorot;

  /** `YYYY-MM-DD`. The day the operator says the transfer went out. */
  readonly settledOn: string | null;
  readonly bankReference: string | null;
  readonly settledBy: string | null;

  readonly auditEntryId: string | null;
  readonly reason: string;
  readonly createdAt: string;
}

export interface LedgerEntryRow {
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
}

/**
 * The column list every ledger query uses.
 *
 * Exported so the query and the mapper cannot drift, and so `select *` never
 * appears against this table. `seq` is cast to text for the same reason the
 * money columns are strings: it is a `bigint`.
 */
export const LEDGER_COLUMNS = [
  "id",
  "seq::text as seq",
  "artist_id",
  "fulfilment_id",
  "order_id",
  "entry_type",
  "parent_entry_id",
  "gross_agorot",
  "commission_rate_bp",
  "commission_agorot",
  "net_agorot",
  "settled_on",
  "bank_reference",
  "settled_by",
  "audit_entry_id",
  "reason",
  "created_at",
].join(", ");

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

/** `settled_on` is a DATE. Rendering it as an instant would move it by a timezone. */
function isoDateOrNull(value: Date | string | null): string | null {
  if (value === null) return null;
  if (typeof value === "string") return value.slice(0, 10);
  // node-postgres parses `date` into a Date at local midnight, so the UTC
  // rendering can land on the previous day. Read the local parts back out.
  const year = value.getFullYear();
  const month = `${value.getMonth() + 1}`.padStart(2, "0");
  const day = `${value.getDate()}`.padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function toLedgerEntry(row: LedgerEntryRow): LedgerEntry {
  return {
    id: row.id,
    seq: Number(row.seq),
    artistId: row.artist_id,
    fulfilmentId: row.fulfilment_id,
    orderId: row.order_id,
    entryType: row.entry_type as LedgerEntryType,
    parentEntryId: row.parent_entry_id,
    grossAgorot: fromDbValue(row.gross_agorot),
    commissionRateBp: row.commission_rate_bp,
    commissionAgorot: fromDbValue(row.commission_agorot),
    netAgorot: fromDbValue(row.net_agorot),
    settledOn: isoDateOrNull(row.settled_on),
    bankReference: row.bank_reference,
    settledBy: row.settled_by,
    auditEntryId: row.audit_entry_id,
    reason: row.reason,
    createdAt: iso(row.created_at),
  };
}
