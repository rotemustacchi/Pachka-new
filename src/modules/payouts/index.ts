/**
 * `payouts` — what the platform owes each artist, when it becomes payable, and
 * the append-only record of paying it.
 *
 * This file is the module's entire surface. ARCHITECTURE.md: nothing outside a
 * module may import a deeper path than its `index.ts`.
 *
 * THE ONE BUG THIS MODULE EXISTS TO PREVENT
 * -----------------------------------------
 * An agora that is invented or lost. Every other module in this system can be
 * wrong and then corrected; a ledger that does not balance cannot be corrected,
 * because there is no record of what the truth was. So there is exactly one
 * rounding decision in the module (`commission.ts`), it is made in integer basis
 * points, and `commission + net = gross` is a CHECK constraint on every row
 * rather than a property somebody remembers.
 *
 * WHAT THIS MODULE DOES NOT DO
 * ----------------------------
 * **It moves no money.** `artist-payouts`: "the system notifies the operator but
 * initiates no financial transaction." There is no payment provider here, no
 * bank integration, and no scheduled transfer. A human pays, then records the
 * date and their reference. `settlePayout` writes a row; that is the whole
 * mechanism, and the absence of anything else is the feature.
 *
 * **It never writes `artist_payout_details`.** That table is `accounts`', and
 * this module only reads it -- masked by default, revealed only through an
 * audited action (SECURITY.md S1-11, which puts the READ path here in as many
 * words). Collecting an artist's bank details needs a writer on the `accounts`
 * side that does not exist yet; reported to the lead architect rather than
 * built here, because a second module writing that table is exactly the
 * ownership violation the architecture contract forbids.
 *
 * **It never writes `orders`' tables.** Fulfilments, orders and transitions are
 * read through this module's own queries and through `orders`' public API. The
 * eligibility clock is the server-stamped `order_transitions` row for the
 * `-> delivered` edge, never a column any client can influence (S1-10 item 2).
 *
 * FOR THE MODULES THAT DEPEND ON THIS ONE
 * ---------------------------------------
 * `moderation` — `sqlPayoutLedger` is the `PayoutLedgerPort` you declared and
 * have been running without. Wire it into `ModerationDeps.payouts` and
 * `suspendAccount` starts recording `outstanding_payouts_known: true` instead of
 * "nobody checked", and flags the artist's eligible unsettled payouts by
 * APPENDING a hold entry against each -- retained and flagged, never cancelled,
 * per SECURITY.md S1-13.
 *
 * WHAT THIS MODULE NEEDS AND CANNOT IMPORT
 * ----------------------------------------
 * `AdminActionPort` (./ports). Settlement and bank-detail reveal are both
 * audited admin actions, and the audit writer lives with `admin_audit` in
 * `moderation` — a module this one has no dependency edge to. So the interface
 * is written down and the composition root supplies it, the same move
 * `moderation` made for this module's ledger. Its stand-in RAISES rather than
 * shrugging: an unwired audit writer would mean money leaving the platform with
 * no record of who released it.
 *
 * `app/` — routes parse input, call one of these functions, and render. Every
 * function with something to tell somebody returns `PayoutNotificationRequest[]`
 * and the route dispatches them AFTER the call returns, so nobody is emailed
 * about a settlement that rolled back.
 */

// ---- The arithmetic. One rounding decision, in integer basis points.
export {
  BASIS_POINTS_PER_UNIT,
  commissionOnFulfilment,
  splitCommissionBp,
  type CommissionSplit,
} from "./commission";

// ---- The domain types, and the one place a row becomes one.
export {
  LEDGER_COLUMNS,
  LEDGER_ENTRY_TYPES,
  PAYOUT_STATUSES,
  toLedgerEntry,
  type LedgerEntry,
  type LedgerEntryRow,
  type LedgerEntryType,
  type PayoutStatus,
} from "./types";

// ---- Eligibility: derived, never stored, from the server-stamped transition.
export {
  eligiblePayoutViews,
  isPayableIgnoringHold,
  payoutViewById,
  payoutViewsForArtist,
  type PayoutBlockReason,
  type PayoutView,
} from "./eligibility";

// ---- Appending: the sale entry, and the sweep that makes it self-healing.
export {
  accrueUnrecordedSales,
  ledgerHistoryFor,
  recordFulfilmentPaid,
  type RecordFulfilmentPaidResult,
} from "./ledger";

// ---- The operator's two actions. Both audited, both appends.
export {
  payableOf,
  recordCorrection,
  settlePayout,
  type RecordCorrectionInput,
  type RecordCorrectionResult,
  type SettlePayoutInput,
  type SettlePayoutResult,
} from "./settlement";

// ---- Bank details: masked by default, revealed only with an audit row.
export {
  hasPayoutDetails,
  maskedPayoutDetails,
  revealPayoutDetails,
  type MaskedPayoutDetails,
  type PayoutDetails,
  type RevealPayoutDetailsInput,
  type RevealPayoutDetailsResult,
} from "./bank-details";

// ---- The two screens.
export {
  artistPayouts,
  outstandingNet,
  payableQueue,
  type ArtistPayoutTotals,
  type ArtistPayoutsView,
  type PayableQueueItem,
  type PayableQueueOptions,
} from "./views";

// ---- What needs telling. Returned, never sent from inside a transaction.
export {
  operatorPayoutEligibleNotification,
  payoutCorrectedNotification,
  payoutDetailsNeededNotification,
  payoutSettledNotification,
  PAYOUT_TEMPLATES,
  type PayoutTemplate,
} from "./notifications";

// ---- Configuration this module reads. It adds no new keys.
export { currentCommissionRateBp, eligibilityDelayDays } from "./config";

// ---- What this module is handed, and the port it cannot import.
export { adminPort, type PayoutsDeps } from "./deps";
export {
  auditUnavailable,
  type AdminActionPort,
  type PayoutAdminActor,
  type PayoutAuditEntry,
  type PayoutAuditRecord,
  type PayoutNotificationAudience,
  type PayoutNotificationRequest,
} from "./ports";

// ---- The port `moderation` declared. Wire this into `ModerationDeps.payouts`.
export {
  sqlPayoutLedger,
  type OutstandingPayouts,
  type PayoutLedgerPort,
} from "./moderation-port";
