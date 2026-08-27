/**
 * What the moderation module needs handed to it.
 *
 * The database is real in every test (ARCHITECTURE.md test policy: the database
 * is never mocked, and neither is PACHKA's own code). `auth` and `mailer` are
 * the external boundaries -- Supabase Auth and the mail server -- and are the
 * only things a test is permitted to fake. `payouts` and `uploads` are ports
 * standing in for modules that have not shipped; see ./ports.
 *
 * `artworks` is NOT a port. It has shipped, and ARCHITECTURE.md's dependency
 * table allows moderation -> artworks, so takedown imports it directly. What it
 * needs handed to it is that module's own deps, because `removeArtwork` takes
 * an `ArtworksDeps` -- and once `orders` ships, the demand source in there must
 * be the real one rather than the zero-reporting stand-in.
 */
import { depsWithoutOrdersOrMatchmaker, type ArtworksDeps } from "@/modules/artworks";
import type { AuthGateway } from "@/modules/accounts";
import type { Database } from "@/shared/db";
import type { FlaggedUploadSource, Mailer, PayoutLedgerPort } from "./ports";

export interface ModerationDeps {
  readonly db: Database;
  /**
   * Passed straight through to `accounts`. Suspension has to end live sessions,
   * and session tokens belong to Supabase Auth, not to us.
   */
  readonly auth: AuthGateway;
  /** The mail server. Absent means notifications are recorded as undelivered. */
  readonly mailer?: Mailer;
  /** Absent until the payouts module ships; see `payoutLedgerUnavailable`. */
  readonly payouts?: PayoutLedgerPort;
  /** Absent until the uploads module ships; see `noFlaggedUploads`. */
  readonly uploads?: FlaggedUploadSource;
  /**
   * The artworks module's own dependencies, for the takedown path. Absent
   * means the stand-in demand source, which `removeArtwork` does not consult --
   * but `orders` must supply the real one when it ships.
   */
  readonly artworks?: ArtworksDeps;
  /**
   * Base URL for links in outbound mail. The composition root should pass
   * `publicEnv().NEXT_PUBLIC_SITE_URL`; see `queueItemUrl`.
   */
  readonly siteUrl?: string;
}

/**
 * `ArtworksDeps` pointed at a specific database handle.
 *
 * Takedown hands `removeArtwork` this action's transaction so the status change
 * and the audit row share it. The demand source and impression source come from
 * `deps.artworks` when the composition root supplied them, and from the
 * conspicuously-named stand-in when it did not.
 */
export function artworksDepsOn(deps: ModerationDeps, db: Database): ArtworksDeps {
  const base = deps.artworks ?? depsWithoutOrdersOrMatchmaker(db);
  return { db, demand: base.demand, impressions: base.impressions };
}
