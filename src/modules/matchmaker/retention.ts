/**
 * Bounded retention for the questionnaire log.
 *
 * SECURITY.md S2-22 item 3: "`match_queries` retention is bounded: rows older
 * than a configured window are deleted by a scheduled job, and rows tied to a
 * `notify_requests` entry are the only ones retained beyond it. Storage growth
 * is monitored."
 *
 * WHY A SWEEP IS A SECURITY CONTROL AND NOT HOUSEKEEPING
 * -----------------------------------------------------
 * Two reasons, and the second is the one that is easy to miss.
 *
 * The free tier has a hard storage ceiling, and the questionnaire is the
 * cheapest anonymous write in the system. Filling the database with
 * questionnaire rows breaks ORDERS — "a total outage caused by an
 * unauthenticated GET-shaped request".
 *
 * And S3-30: "PII accumulates with no retention or deletion path". A
 * `match_queries` row is a household's budget and the dimensions of their wall.
 * Keeping it for ever is a decision, and nobody made it.
 *
 * Nothing here is scheduled: this module owns no scheduler, exactly as
 * `moderation`'s prune does not. `src/app` or a cron route calls it.
 */
import type { Sql } from "@/shared/db";
import { matchmakerRateLimits } from "./config";

export interface SweepResult {
  readonly queriesDeleted: number;
  readonly rateLimitEventsDeleted: number;
}

/**
 * Delete questionnaire rows past the retention window.
 *
 * A row referenced by a `notify_requests` entry survives, because that
 * subscription exists precisely to be matched against those answers later. The
 * predicate says so directly rather than relying on the foreign key: the column
 * is `on delete set null`, so the FK would let the delete succeed and silently
 * empty the subscription of the thing it subscribed to.
 */
export async function pruneMatchQueries(db: Sql, olderThanDays?: number): Promise<number> {
  const { queryRetentionDays } = await matchmakerRateLimits(db);
  const days = olderThanDays ?? queryRetentionDays;

  const { rowCount } = await db.query(
    `delete from match_queries q
      where q.created_at < now() - make_interval(days => $1::int)
        and not exists (select 1 from notify_requests n where n.match_query_id = q.id)`,
    [days],
  );
  return rowCount;
}

/**
 * Delete impressions past the retention window.
 *
 * The artist's dashboard figure is a lifetime count, so this window is
 * deliberately the same one the questionnaires use rather than a shorter one:
 * an impression outliving the questionnaire that caused it is fine, and an
 * impression count that silently shrinks under an artist is not. What this
 * bounds is unbounded growth, which is the actual finding.
 */
export async function pruneMatchImpressions(db: Sql, olderThanDays: number): Promise<number> {
  const { rowCount } = await db.query(
    "delete from match_impressions where occurred_at < now() - make_interval(days => $1::int)",
    [olderThanDays],
  );
  return rowCount;
}
