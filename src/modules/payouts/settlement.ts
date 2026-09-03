/**
 * Settlement and correction: the two things an operator does to the ledger.
 *
 * THE SYSTEM INITIATES NO TRANSFER
 * --------------------------------
 * `artist-payouts`, *No automated transfer*: "WHEN a payout becomes eligible
 * THEN the system notifies the operator but initiates no financial transaction."
 * There is no payment provider in this file, no bank API, no queue of pending
 * transfers. A human moves the money in their bank's own interface and then
 * records two facts here: the date it went out and their reference for it.
 * `settlePayout` writes a row. That is the entire mechanism, and the absence of
 * anything else is the feature.
 *
 * WHY ELIGIBILITY IS CHECKED AGAIN, HERE, INSIDE THE TRANSACTION
 * --------------------------------------------------------------
 * SECURITY.md S1-10 item 3: "Eligibility is re-evaluated inside the settlement
 * transaction, not read from a cached view. A return requested at the same
 * moment as a settlement must be resolved by the transaction, not by whichever
 * query ran first."
 *
 * So the operator's queue is a display and never an authority. The sale entry is
 * locked, the same query the queue used is re-run against the locked row, and
 * the decision is made from that. Two operators submitting at once serialise on
 * the lock; the second re-reads, sees the settlement the first appended, and is
 * refused with a sentence rather than a constraint violation -- though the
 * partial unique index is still underneath as the structural guarantee, because
 * a lock is a promise about this process and an index is a promise about the
 * database.
 *
 * WHY A CORRECTION IS AN INSERT
 * -----------------------------
 * `artist-payouts`, *Correction recorded*: "the system appends an adjusting
 * entry referencing the original and does not modify it." Nothing in this file
 * issues an UPDATE against `payout_ledger`, and nothing could: the grants are
 * revoked and the trigger raises. That is deliberate belt-and-braces. The reason
 * `moderation` gives for `admin_audit` applies here with money attached -- "the
 * application only ever calls INSERT" is a coding style, not a control, and the
 * application holds the service-role key.
 */
import { AppError } from "@/shared/errors";

import { agorot, type Agorot } from "@/shared/money";
import { hasPayoutDetails } from "./bank-details";
import { splitCommissionBp } from "./commission";
import { eligibilityDelayDays } from "./config";
import { adminPort, type PayoutsDeps } from "./deps";
import { isPayableIgnoringHold, payoutViewById, type PayoutView } from "./eligibility";
import { payoutCorrectedNotification, payoutSettledNotification } from "./notifications";
import type { PayoutNotificationRequest } from "./ports";
import { LEDGER_COLUMNS, toLedgerEntry, type LedgerEntry, type LedgerEntryRow } from "./types";

export interface SettlePayoutInput {
  /** The operator performing it. Authorised here, not by the caller. */
  readonly actorId: string;
  /** The `sale` entry being settled. */
  readonly ledgerEntryId: string;
  /** `YYYY-MM-DD`. The day the transfer left the bank, as the operator saw it. */
  readonly settledOn: string;
  /** The operator's reference for the transfer, for reconciliation. */
  readonly bankReference: string;
  /**
   * Required when the payout is flagged from a suspension. Settling a flagged
   * payout is the "operator decision" SECURITY.md S1-13 asks for; making it a
   * separate, explicit argument is what stops it being made by accident.
   */
  readonly acknowledgeHold?: boolean;
}

export interface SettlePayoutResult {
  /** The appended `settlement` entry. */
  readonly entry: LedgerEntry;
  /** The sale as it now stands. */
  readonly payout: PayoutView;
  readonly auditEntryId: string;
  readonly notifications: readonly PayoutNotificationRequest[];
}

export async function settlePayout(
  deps: PayoutsDeps,
  input: SettlePayoutInput,
): Promise<SettlePayoutResult> {
  const settledOn = normaliseSettlementDate(input.settledOn);
  const bankReference = normaliseReference(input.bankReference);
  const admin = adminPort(deps);

  return deps.db.withTransaction(async (tx) => {
    const actor = await admin.authorise(tx, input.actorId);
    const delayDays = await eligibilityDelayDays(tx);

    // The lock, then the recheck. Both on this transaction, in this order.
    const payout = await payoutViewById(tx, input.ledgerEntryId, delayDays, { forUpdate: true });
    if (payout === null) {
      throw AppError.notFound("Payout not found", {
        code: "payouts.entry_not_found",
        details: { ledgerEntryId: input.ledgerEntryId },
      });
    }

    assertSettleable(payout, input.acknowledgeHold === true);

    // `artist-payouts`, *Settlement blocked without details*. Checked here
    // rather than at the queue, because the queue is a display: an artist could
    // delete their details between the page load and the click.
    if (!(await hasPayoutDetails(tx, payout.entry.artistId))) {
      throw AppError.conflict(
        "This artist has no bank details on file, so a payout cannot be recorded against them.",
        {
          code: "payouts.no_payout_details",
          details: { ledgerEntryId: payout.entry.id, artistId: payout.entry.artistId },
        },
      );
    }

    const payable = payout.payableNetAgorot;
    if (payable <= 0) {
      throw AppError.conflict(
        `There is nothing to pay on this entry: the net payable is ${payable} agorot.`,
        {
          code: "payouts.nothing_payable",
          details: { ledgerEntryId: payout.entry.id, payableNetAgorot: payable },
        },
      );
    }

    // The audit entry FIRST, because the settlement row carries its id -- and
    // because `payout_ledger_settlement_shape` makes `audit_entry_id` NOT NULL
    // for a settlement, so an unaudited one is refused by the schema and not
    // merely by this function.
    const audit = await admin.record(tx, {
      action: "payout_settlement",
      targetType: "payout",
      targetId: payout.entry.id,
      note: `Settled ${payable} agorot on ${settledOn}, reference ${bankReference}.`,
      details: {
        artist_id: payout.entry.artistId,
        fulfilment_id: payout.entry.fulfilmentId,
        net_payable_agorot: payable,
        settled_on: settledOn,
        // The operator's own reference. NOT a bank identifier: SECURITY.md
        // S1-11 keeps account numbers out of every derived record, and the
        // audit chain is the most permanent record in the system.
        bank_reference: bankReference,
        acknowledged_hold: input.acknowledgeHold === true,
      },
    });

    const row = await tx.one<LedgerEntryRow>(
      `insert into payout_ledger (
         artist_id, fulfilment_id, order_id, entry_type, parent_entry_id,
         gross_agorot, commission_rate_bp, commission_agorot, net_agorot,
         settled_on, bank_reference, settled_by, audit_entry_id, reason
       ) values ($1, $2, $3, 'settlement', $4, $5, $6, 0, $5, $7, $8, $9, $10, $11)
       returning ${LEDGER_COLUMNS}`,
      [
        payout.entry.artistId,
        payout.entry.fulfilmentId,
        payout.entry.orderId,
        payout.entry.id,
        // The money LEAVES the balance, so both figures are negative and equal:
        // commission does not move at settlement -- it was taken at the sale.
        String(-payable),
        payout.entry.commissionRateBp,
        settledOn,
        bankReference,
        actor.userId,
        audit.id,
        `Bank transfer recorded by operator, reference ${bankReference}.`,
      ],
    );

    const settled = await payoutViewById(tx, payout.entry.id, delayDays);

    return {
      entry: toLedgerEntry(row),
      payout: settled ?? payout,
      auditEntryId: audit.id,
      notifications: [
        payoutSettledNotification({
          artistId: payout.entry.artistId,
          ledgerEntryId: payout.entry.id,
          netAgorot: payable,
          settledOn,
          bankReference,
        }),
      ],
    };
  });
}

/**
 * The rejection paths, in the order an operator would hit them.
 *
 * `artist-payouts`, *Settling an ineligible payout*: "the system rejects the
 * action and states the eligibility date." So the date is in `details`, not only
 * in the prose, because a route renders the structured field and a human reads
 * the sentence.
 */
function assertSettleable(payout: PayoutView, acknowledgedHold: boolean): void {
  if (payout.status === "settled") {
    throw AppError.conflict(
      `This payout was already settled on ${payout.settledOn} (reference ${payout.bankReference}).`,
      {
        code: "payouts.already_settled",
        details: {
          ledgerEntryId: payout.entry.id,
          settledOn: payout.settledOn,
          bankReference: payout.bankReference,
        },
      },
    );
  }

  if (payout.status === "held" && !acknowledgedHold) {
    throw AppError.conflict(
      "This payout is flagged for an operator decision following an admin action on the artist's account. " +
        "Settle it only after deciding, by acknowledging the flag.",
      {
        code: "payouts.flagged_for_operator",
        details: {
          ledgerEntryId: payout.entry.id,
          heldByAuditEntryId: payout.heldByAuditEntryId,
          heldReason: payout.heldReason,
        },
      },
    );
  }

  // A held payout that is otherwise payable passes once acknowledged; anything
  // else must be genuinely eligible.
  if (!isPayableIgnoringHold(payout)) {
    throw AppError.conflict(ineligibleMessage(payout), {
      code: "payouts.not_eligible",
      details: {
        ledgerEntryId: payout.entry.id,
        status: payout.status,
        blockedBy: payout.blockedBy,
        // THE DATE THE SPEC REQUIRES THE REJECTION TO STATE.
        eligibleAt: payout.eligibleAt,
        deliveredAt: payout.deliveredAt,
      },
    });
  }
}

function ineligibleMessage(payout: PayoutView): string {
  switch (payout.blockedBy) {
    case "awaiting_delivery":
      return "This payout is not eligible: the parcel has not been confirmed delivered, so the return window has not started.";
    case "within_return_window":
      return `This payout is not eligible until ${payout.eligibleAt}, when the return window closes.`;
    case "return_open":
      return "This payout is not eligible: a return is open on this fulfilment and is held pending resolution.";
    case "fulfilment_returned":
      return "This payout is not eligible: the fulfilment was returned or cancelled, so there is no sale to pay for.";
    default:
      return `This payout is not eligible${payout.eligibleAt === null ? "" : ` until ${payout.eligibleAt}`}.`;
  }
}

// ---------------------------------------------------------------------------
// Corrections
// ---------------------------------------------------------------------------

export interface RecordCorrectionInput {
  readonly actorId: string;
  /** The `sale` entry being corrected. */
  readonly ledgerEntryId: string;
  /**
   * The change to the GROSS, signed. Negative reduces what the artist earned.
   * Commission is re-split from it at the original's snapshotted rate, so a
   * correction cannot quietly change the commission the sale was made at.
   */
  readonly grossDeltaAgorot: number;
  /** Mandatory. The schema refuses an adjusting entry with no reason. */
  readonly reason: string;
}

export interface RecordCorrectionResult {
  /** The appended `adjustment`. The original is untouched, and provably so. */
  readonly entry: LedgerEntry;
  readonly original: LedgerEntry;
  readonly payout: PayoutView;
  readonly auditEntryId: string;
  readonly notifications: readonly PayoutNotificationRequest[];
}

/**
 * Correct an amount by appending, never by editing.
 *
 * The delta is split at `original.commissionRateBp` -- the rate snapshotted onto
 * the order at placement -- so reversing a sale in full produces exactly the
 * negation of it and the two sum to nothing. That identity is not an accident of
 * this function; it is the sign rule proved in `commission.test.ts`, and it is
 * the reason the split truncates toward zero below zero rather than flooring.
 *
 * Permitted after settlement. That is when a correction is most often needed --
 * a transfer that bounced, an amount typed wrong -- and refusing it would leave
 * an operator with a wrong figure and no way to state the truth.
 */
export async function recordCorrection(
  deps: PayoutsDeps,
  input: RecordCorrectionInput,
): Promise<RecordCorrectionResult> {
  const reason = input.reason?.trim() ?? "";
  if (reason.length === 0) {
    throw AppError.validation("A correction must state why it was made", {
      code: "payouts.correction_reason_required",
      fields: { reason: ["Required"] },
    });
  }
  const delta = agorot(input.grossDeltaAgorot);
  if (delta === 0) {
    throw AppError.validation("A correction of zero changes nothing and would not be a correction", {
      code: "payouts.correction_zero",
    });
  }

  const admin = adminPort(deps);

  return deps.db.withTransaction(async (tx) => {
    await admin.authorise(tx, input.actorId);
    const delayDays = await eligibilityDelayDays(tx);

    const payout = await payoutViewById(tx, input.ledgerEntryId, delayDays, { forUpdate: true });
    if (payout === null) {
      throw AppError.notFound("Payout not found", {
        code: "payouts.entry_not_found",
        details: { ledgerEntryId: input.ledgerEntryId },
      });
    }

    const split = splitCommissionBp(delta, payout.entry.commissionRateBp);

    const audit = await admin.record(tx, {
      action: "payout_settlement",
      targetType: "payout",
      targetId: payout.entry.id,
      note: `Correction of ${delta} agorot gross: ${reason}`,
      details: {
        artist_id: payout.entry.artistId,
        fulfilment_id: payout.entry.fulfilmentId,
        gross_delta_agorot: delta,
        commission_delta_agorot: split.commissionAgorot,
        net_delta_agorot: split.netAgorot,
        corrects_entry_id: payout.entry.id,
      },
    });

    const row = await tx.one<LedgerEntryRow>(
      `insert into payout_ledger (
         artist_id, fulfilment_id, order_id, entry_type, parent_entry_id,
         gross_agorot, commission_rate_bp, commission_agorot, net_agorot,
         audit_entry_id, reason
       ) values ($1, $2, $3, 'adjustment', $4, $5, $6, $7, $8, $9, $10)
       returning ${LEDGER_COLUMNS}`,
      [
        payout.entry.artistId,
        payout.entry.fulfilmentId,
        payout.entry.orderId,
        payout.entry.id,
        String(delta),
        payout.entry.commissionRateBp,
        String(split.commissionAgorot),
        String(split.netAgorot),
        audit.id,
        reason,
      ],
    );

    const corrected = await payoutViewById(tx, payout.entry.id, delayDays);

    return {
      entry: toLedgerEntry(row),
      original: payout.entry,
      payout: corrected ?? payout,
      auditEntryId: audit.id,
      notifications: [
        payoutCorrectedNotification({
          artistId: payout.entry.artistId,
          originalEntryId: payout.entry.id,
          adjustmentEntryId: row.id,
          netDeltaAgorot: split.netAgorot,
          reason,
        }),
      ],
    };
  });
}

// ---------------------------------------------------------------------------
// Input normalisation
// ---------------------------------------------------------------------------

const SETTLEMENT_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * A settlement date is a calendar day, and it is in the past.
 *
 * Not a CHECK constraint, because a CHECK cannot call `current_date` -- Postgres
 * requires immutability there. So the rule lives here, where the reason it
 * exists can be written down: a future settlement date would record a transfer
 * that has not happened, which is the one fact this row is supposed to attest.
 */
function normaliseSettlementDate(value: string): string {
  const trimmed = (value ?? "").trim();
  if (!SETTLEMENT_DATE.test(trimmed)) {
    throw AppError.validation("A settlement date must be written as YYYY-MM-DD", {
      code: "payouts.settlement_date_invalid",
      fields: { settledOn: ["Use the form YYYY-MM-DD"] },
    });
  }
  const parsed = new Date(`${trimmed}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== trimmed) {
    throw AppError.validation(`There is no such date as ${trimmed}`, {
      code: "payouts.settlement_date_invalid",
      fields: { settledOn: ["Not a real date"] },
    });
  }
  const today = new Date().toISOString().slice(0, 10);
  if (trimmed > today) {
    throw AppError.validation(
      "A settlement date records a transfer that has already been made; it cannot be in the future.",
      {
        code: "payouts.settlement_date_future",
        fields: { settledOn: ["Cannot be in the future"] },
      },
    );
  }
  return trimmed;
}

function normaliseReference(value: string): string {
  const trimmed = (value ?? "").trim();
  if (trimmed.length === 0) {
    throw AppError.validation(
      "A settlement must carry the operator's transfer reference, so the payment can be reconciled.",
      {
        code: "payouts.bank_reference_required",
        fields: { bankReference: ["Required"] },
      },
    );
  }
  if (trimmed.length > 120) {
    throw AppError.validation("A transfer reference may be at most 120 characters", {
      code: "payouts.bank_reference_too_long",
      fields: { bankReference: ["At most 120 characters"] },
    });
  }
  return trimmed;
}

/** Re-exported for callers that want the payable figure without settling. */
export function payableOf(payout: PayoutView): Agorot {
  return payout.payableNetAgorot;
}
