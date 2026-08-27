/**
 * What `moderation` needs from modules that do not exist yet.
 *
 * ARCHITECTURE.md is explicit that a module owns its tables and that nobody
 * else writes them. `payout_ledger` belongs to `payouts` and `artworks` belongs
 * to `artworks`; neither has shipped. The alternative to a port here would be
 * for moderation to create those tables itself, which would put two owners on
 * one table and guarantee a collision when the real migration lands.
 *
 * So: the interface is written down, the moderation side is finished and
 * tested against it, and the owning module implements it when it arrives.
 * Every method takes an `Sql` -- which a `Tx` satisfies -- because these are
 * called from inside the admin action's transaction. An implementation that
 * opens its own transaction breaks the coupling SECURITY.md S1-14 item 3
 * requires, and the atomicity test will catch it.
 */
import type { Sql } from "@/shared/db";

// ---------------------------------------------------------------------------
// payouts
// ---------------------------------------------------------------------------

export interface OutstandingPayouts {
  /**
   * False when the payouts module is not wired in. Distinguished from
   * "wired in and found nothing", because the two must not be recorded the
   * same way: one is a fact about the artist, the other is a gap in the system.
   */
  readonly known: boolean;
  readonly entryCount: number;
  /** Agorot. ARCHITECTURE.md: money is an integer count of agorot, never a float. */
  readonly totalAgorot: bigint;
}

export interface PayoutLedgerPort {
  /** Eligible but unsettled ledger entries for an artist. */
  outstandingFor(sql: Sql, artistId: string): Promise<OutstandingPayouts>;
  /**
   * Mark them as needing an operator decision, and return how many were
   * flagged. The spec is emphatic that this RETAINS the entries: "the ledger
   * entries are retained and flagged for operator decision rather than
   * cancelled". An implementation that deletes or zeroes a row is wrong.
   */
  flagForOperatorDecision(sql: Sql, artistId: string, auditEntryId: string): Promise<number>;
}

/**
 * The stand-in until `payouts` ships. It is not a fake and not a no-op: it
 * reports that the answer is unknown, and `suspendAccount` records that fact on
 * the audit entry so the operator can see that the payout question was never
 * asked for this suspension. Silently reporting "no outstanding payouts" would
 * be the dangerous option.
 */
export const payoutLedgerUnavailable: PayoutLedgerPort = {
  async outstandingFor(): Promise<OutstandingPayouts> {
    return { known: false, entryCount: 0, totalAgorot: 0n };
  },
  async flagForOperatorDecision(): Promise<number> {
    return 0;
  },
};

// ---------------------------------------------------------------------------
// artworks
// ---------------------------------------------------------------------------

export interface RemovedArtwork {
  readonly artworkId: string;
  readonly artistId: string;
  /** The state it was in before the takedown, for the audit entry. */
  readonly previousStatus: string;
}

export interface ArtworkModerationPort {
  /**
   * Move one artwork to `removed`, inside the caller's transaction.
   *
   * `removed` must be terminal for the artist: ARCHITECTURE.md task 3.8 and the
   * moderation spec both require that the artist cannot republish it. That rule
   * belongs to the artworks lifecycle state machine, not here.
   *
   * Must NOT touch orders. The spec: "Takedown SHALL NOT affect orders already
   * placed for that artwork."
   */
  remove(sql: Sql, artworkId: string, reason: string): Promise<RemovedArtwork>;
  /** Artist ids for artworks currently `published`. Used to size a suspension. */
  publishedCountFor(sql: Sql, artistId: string): Promise<number>;
}

// ---------------------------------------------------------------------------
// mail
// ---------------------------------------------------------------------------

/**
 * The one genuinely external boundary in this module. ARCHITECTURE.md's test
 * policy allows a deterministic fake for mail and for nothing else.
 */
export interface OutboundMessage {
  readonly to: string;
  readonly subject: string;
  readonly body: string;
}

export interface Mailer {
  /** Rejects when delivery fails. Callers must survive that (spec: "Notification delivery fails"). */
  send(message: OutboundMessage): Promise<void>;
}
