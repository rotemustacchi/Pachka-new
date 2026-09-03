/**
 * The two screens' worth of data: the artist's, and the operator's.
 *
 * Neither function decides who may see what by inspecting a role. Each takes the
 * subject as an argument and scopes the query by it, the way `orders.views`
 * does, so a route that passed the wrong id gets that artist's data and not
 * everybody's -- and `payout_ledger`'s RLS policy is the second layer underneath,
 * covering the PostgREST path where no PACHKA code runs at all.
 *
 * WHAT IS NOT IN EITHER SHAPE
 * ---------------------------
 * A bank detail. The operator's queue carries `MaskedPayoutDetails`, which has
 * no field wide enough for an account number (SECURITY.md S1-11 item 2), and the
 * artist's view carries none at all -- an artist looking at their own payouts
 * does not need their account read back to them, and a shape that could carry it
 * is a shape that could be handed to the wrong renderer.
 */
import type { Sql } from "@/shared/db";
import { agorot, type Agorot } from "@/shared/money";
import { maskedPayoutDetails, type MaskedPayoutDetails } from "./bank-details";
import { eligibilityDelayDays } from "./config";
import {
  eligiblePayoutViews,
  payoutViewsForArtist,
  type PayoutView,
} from "./eligibility";
import type { PayoutsDeps } from "./deps";

/**
 * `artist-payouts`, *Artist views their balance*: "they see totals for pending,
 * eligible, and settled amounts, with the underlying entries."
 */
export interface ArtistPayoutTotals {
  readonly pendingAgorot: Agorot;
  readonly eligibleAgorot: Agorot;
  readonly settledAgorot: Agorot;
  /** Parked by an admin action. Broken out so it is not silently inside `pending`. */
  readonly heldAgorot: Agorot;
  /**
   * What is still owed, over every entry type: `sum(net_agorot)`. Equal to
   * pending + eligible + held when nothing has been corrected after settlement,
   * and the authority when something has.
   */
  readonly outstandingAgorot: Agorot;
}

export interface ArtistPayoutsView {
  readonly artistId: string;
  readonly totals: ArtistPayoutTotals;
  /**
   * Every payout, newest first, each carrying `eligibleAt` -- the exact date
   * required by `artist-payouts`, *Artist sees the date*.
   */
  readonly payouts: readonly PayoutView[];
  /**
   * Whether the artist still needs to supply bank details. A boolean, not the
   * details: this shape is rendered in the artist's own dashboard and there is
   * no reason for an account number to make the trip.
   */
  readonly payoutDetailsOnFile: boolean;
}

export async function artistPayouts(
  deps: PayoutsDeps,
  artistId: string,
): Promise<ArtistPayoutsView> {
  const delayDays = await eligibilityDelayDays(deps.db);
  const payouts = await payoutViewsForArtist(deps.db, artistId, delayDays);
  const masked = await maskedPayoutDetails(deps.db, artistId);

  return {
    artistId,
    totals: totalsOf(payouts, await outstandingNet(deps.db, artistId)),
    payouts,
    payoutDetailsOnFile: masked.onFile,
  };
}

function totalsOf(payouts: readonly PayoutView[], outstanding: Agorot): ArtistPayoutTotals {
  let pending = 0;
  let eligible = 0;
  let settled = 0;
  let held = 0;

  for (const payout of payouts) {
    switch (payout.status) {
      case "pending":
        pending += payout.payableNetAgorot;
        break;
      case "eligible":
        eligible += payout.payableNetAgorot;
        break;
      case "held":
        held += payout.payableNetAgorot;
        break;
      case "settled":
        // What was actually paid, which after a correction is not the same as
        // the sale's net. The settlement row records the movement; this reads
        // the sale plus its adjustments, which is what the artist received.
        settled += payout.payableNetAgorot;
        break;
    }
  }

  return {
    pendingAgorot: agorot(pending),
    eligibleAgorot: agorot(eligible),
    settledAgorot: agorot(settled),
    heldAgorot: agorot(held),
    outstandingAgorot: outstanding,
  };
}

/**
 * The balance, straight from the table.
 *
 * `sum(net_agorot)` over every entry an artist has. Because a settlement is
 * stored as the negative of what it paid, this is exactly what is still owed --
 * one arithmetic fact rather than four buckets added up in application code,
 * and therefore the figure to trust if the two ever disagree.
 */
export async function outstandingNet(sql: Sql, artistId: string): Promise<Agorot> {
  const row = await sql.one<{ net: string }>(
    "select coalesce(sum(net_agorot), 0)::text as net from payout_ledger where artist_id = $1",
    [artistId],
  );
  return agorot(Number(row.net));
}

// ---------------------------------------------------------------------------
// The operator's payable queue
// ---------------------------------------------------------------------------

/**
 * `artist-payouts`, *Manual settlement recorded by an operator*: "an admin view
 * listing every eligible, unsettled payout with the amount and the artist's
 * payout details."
 *
 * The spec says "the artist's payout details"; SECURITY.md S1-11 item 2 says
 * masked by default, with an audited reveal. The security document wins where
 * the two disagree, and it does not actually cost the operator anything: they
 * need the last four to recognise the account in a list, and the reveal action
 * for the one they are about to pay.
 */
export interface PayableQueueItem {
  readonly payout: PayoutView;
  readonly artistId: string;
  /** What settling this would pay: the sale's net plus every adjustment. */
  readonly payableNetAgorot: Agorot;
  readonly payoutDetails: MaskedPayoutDetails;
  /**
   * False when the artist has not supplied bank details. The row still appears
   * -- an operator needs to see that someone is owed money and cannot be paid --
   * but `settlePayout` will refuse it, which is the spec's *Settlement blocked
   * without details*.
   */
  readonly settleable: boolean;
}

export interface PayableQueueOptions {
  /** Include payouts parked by an admin action. Off by default. */
  readonly includeFlagged?: boolean;
  readonly artistId?: string;
}

export async function payableQueue(
  deps: PayoutsDeps,
  options: PayableQueueOptions = {},
): Promise<readonly PayableQueueItem[]> {
  const delayDays = await eligibilityDelayDays(deps.db);
  const views = await eligiblePayoutViews(deps.db, delayDays, options);

  // One masked lookup per artist, not per payout: an artist with forty eligible
  // parcels is one account, and forty reads of a sensitive table where one would
  // do is forty chances for one of them to end up somewhere it should not.
  const byArtist = new Map<string, MaskedPayoutDetails>();
  const items: PayableQueueItem[] = [];

  for (const payout of views) {
    const artistId = payout.entry.artistId;
    let details = byArtist.get(artistId);
    if (details === undefined) {
      details = await maskedPayoutDetails(deps.db, artistId);
      byArtist.set(artistId, details);
    }
    items.push({
      payout,
      artistId,
      payableNetAgorot: payout.payableNetAgorot,
      payoutDetails: details,
      settleable: details.onFile && payout.payableNetAgorot > 0,
    });
  }

  return items;
}
