/**
 * What the moderation module needs handed to it.
 *
 * The database is real in every test (ARCHITECTURE.md test policy: the database
 * is never mocked, and neither is PACHKA's own code). `auth` and `mailer` are
 * the external boundaries; `payouts` and `artworks` are ports standing in for
 * modules that have not shipped -- see ./ports.
 */
import type { Database } from "@/shared/db";
import type { AuthGateway } from "@/modules/accounts";
import type { ArtworkModerationPort, Mailer, PayoutLedgerPort } from "./ports";

export interface ModerationDeps {
  readonly db: Database;
  /**
   * Passed straight through to `accounts`. Suspension has to end live sessions,
   * and session tokens belong to Supabase Auth, not to us.
   */
  readonly auth: AuthGateway;
  /** Absent until the payouts module ships; see `payoutLedgerUnavailable`. */
  readonly payouts?: PayoutLedgerPort;
  /** Absent until the artworks module ships. Takedown requires it. */
  readonly artworks?: ArtworkModerationPort;
  readonly mailer?: Mailer;
}
