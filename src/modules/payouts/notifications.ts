/**
 * What needs telling, handed back rather than sent.
 *
 * Nothing in this module sends anything. Every function that has news returns
 * `PayoutNotificationRequest[]` and the caller dispatches them once its
 * transaction has committed -- the contract `orders` and `shipping` both use,
 * for the reason `orders` gives: nobody is told about something that then rolled
 * back, and this module therefore needs no external dependency and no fake in
 * any of its tests. Asserting what a message SAYS, from a pure function, is a
 * test; asserting that a mailer object was called is not (ARCHITECTURE.md test
 * policy).
 *
 * WHAT A PAYOUT MESSAGE MAY NOT CONTAIN
 * -------------------------------------
 * SECURITY.md S1-11 item 3, on the settlement notification: "It does not contain
 * the account number, branch, or bank." The finding names email as the second
 * most likely exposure path after logs, precisely because a helpful template
 * echoes the destination account so the artist can verify it.
 *
 * The defence here is structural rather than remembered. No function below
 * accepts a bank detail as an argument, so there is no value in scope that could
 * be interpolated into one. `data` carries the amount, the date and the
 * operator's transfer reference -- which is what actually lets an artist
 * reconcile against their own statement -- plus ids the mail layer resolves.
 */
import { formatAgorot, type Agorot } from "@/shared/money";
import type { PayoutNotificationRequest } from "./ports";

/**
 * Every template this module emits, as a constant, so the mail layer can be
 * checked against it exhaustively rather than by grepping for strings.
 */
export const PAYOUT_TEMPLATES = {
  /** The artist has money owed and no bank details on file yet. */
  payoutDetailsNeeded: "payouts.payout_details_needed",
  /** A transfer was recorded. Amount, date and reference -- never an account. */
  payoutSettled: "payouts.payout_settled",
  /** An adjusting entry changed what an artist is owed. */
  payoutCorrected: "payouts.payout_corrected",
  /**
   * `artist-payouts`, *No automated transfer*: "the system notifies the operator
   * but initiates no financial transaction." This is that notification, and it
   * is the whole of what becoming eligible causes to happen.
   */
  operatorPayoutEligible: "payouts.operator_payout_eligible",
} as const;

export type PayoutTemplate = (typeof PAYOUT_TEMPLATES)[keyof typeof PAYOUT_TEMPLATES];

/**
 * `artist-payouts`, *Artist prompted after first sale*: "WHEN an artist's first
 * fulfilment reaches paid and no payout details are on file THEN the system
 * prompts the artist to supply them."
 */
export function payoutDetailsNeededNotification(input: {
  readonly artistId: string;
  readonly netAgorot: Agorot;
}): PayoutNotificationRequest {
  return {
    audience: "artist",
    template: PAYOUT_TEMPLATES.payoutDetailsNeeded,
    recipientId: input.artistId,
    data: {
      netAgorot: input.netAgorot,
      netFormatted: formatAgorot(input.netAgorot),
    },
  };
}

/**
 * `artist-payouts`, *Operator settles a payout*: "the payout is marked settled,
 * the artist is notified, and the reference is stored on the ledger entry."
 *
 * The signature is the control. There is no parameter here that could hold an
 * account number, so S1-11 item 3 cannot be breached by a template edit -- only
 * by changing this function, which is a diff a reviewer sees.
 */
export function payoutSettledNotification(input: {
  readonly artistId: string;
  readonly ledgerEntryId: string;
  readonly netAgorot: Agorot;
  readonly settledOn: string;
  readonly bankReference: string;
}): PayoutNotificationRequest {
  return {
    audience: "artist",
    template: PAYOUT_TEMPLATES.payoutSettled,
    recipientId: input.artistId,
    data: {
      ledgerEntryId: input.ledgerEntryId,
      netAgorot: input.netAgorot,
      netFormatted: formatAgorot(input.netAgorot),
      settledOn: input.settledOn,
      // The operator's own reference for the transfer. Not a bank identifier:
      // it is what the operator typed so that the two sides can be reconciled.
      bankReference: input.bankReference,
    },
  };
}

export function payoutCorrectedNotification(input: {
  readonly artistId: string;
  readonly originalEntryId: string;
  readonly adjustmentEntryId: string;
  readonly netDeltaAgorot: Agorot;
  readonly reason: string;
}): PayoutNotificationRequest {
  return {
    audience: "artist",
    template: PAYOUT_TEMPLATES.payoutCorrected,
    recipientId: input.artistId,
    data: {
      originalEntryId: input.originalEntryId,
      adjustmentEntryId: input.adjustmentEntryId,
      netDeltaAgorot: input.netDeltaAgorot,
      netDeltaFormatted: formatAgorot(input.netDeltaAgorot),
      reason: input.reason,
    },
  };
}

/**
 * The operator's queue notification. No `recipientId`: this is an operator
 * queue, not a person, exactly as `orders` treats its admin audience.
 */
export function operatorPayoutEligibleNotification(input: {
  readonly ledgerEntryId: string;
  readonly artistId: string;
  readonly netAgorot: Agorot;
  readonly eligibleAt: string;
  readonly hasPayoutDetails: boolean;
}): PayoutNotificationRequest {
  return {
    audience: "admin",
    template: PAYOUT_TEMPLATES.operatorPayoutEligible,
    data: {
      ledgerEntryId: input.ledgerEntryId,
      artistId: input.artistId,
      netAgorot: input.netAgorot,
      netFormatted: formatAgorot(input.netAgorot),
      eligibleAt: input.eligibleAt,
      // A boolean, not the details. The operator learns whether they can pay,
      // and looks the account up through the audited reveal when they do.
      hasPayoutDetails: input.hasPayoutDetails,
    },
  };
}
