/**
 * Rate limiting on the anonymous reporting surface.
 *
 * moderation-admin: "a client files reports beyond the configured rate limit ->
 * further reports are refused, and the report count already recorded is not
 * inflated by the refused attempts". Both halves are load-bearing, and the
 * second is the one an implementation gets wrong.
 *
 * THE ORDERING THAT MATTERS
 * -------------------------
 * The attempt is counted and recorded on the POOL, outside the transaction that
 * writes the report. That is not an oversight, it is the whole design:
 *
 *   - If the counter were written inside the report's transaction, then
 *     refusing a report would roll back the very row that records the refused
 *     attempt. An attacker could then hammer the endpoint forever, because
 *     every refusal erases its own evidence and the window never fills.
 *   - Recording the attempt before the report is written means a report that
 *     later fails for some other reason still consumed its slot. That direction
 *     is the safe one to be wrong in: it limits slightly more than it must,
 *     rather than slightly less.
 *
 * The count the queue shows is derived from the `reports` rows that exist
 * (see the migration), so a refused attempt cannot inflate it -- there is no
 * counter for it to increment.
 *
 * Subjects are hashed before they are stored, for the reason `accounts`
 * records for its own limiter: unhashed, this table becomes a directory of
 * every client that has ever used the endpoint.
 */
import { createHash } from "node:crypto";
import type { Sql } from "@/shared/db";
import { AppError } from "@/shared/errors";

export type ModerationRateLimitBucket = "report";

// TODO(config): register `moderation.report_window_minutes` (integer, default
// 60) and `moderation.report_max_per_window` (integer, default 10) in
// shared/config/registry.ts, then read them with getConfig here. Reported to
// the lead architect; these literals are the placeholder in the meantime and
// are the only two magic numbers in this module.
export const REPORT_WINDOW_MINUTES = 60;
export const REPORT_MAX_PER_WINDOW = 10;

/**
 * Hash a subject for storage.
 *
 * Not a secret-keyed MAC, and the same choice `accounts.hashSubject` makes: the
 * point is that the table does not become a list of addresses, not that the
 * values are unguessable to someone who already holds the database.
 */
export function hashSubject(value: string): string {
  return createHash("sha256").update(value.trim().toLowerCase(), "utf8").digest("hex");
}

/**
 * Record an attempt and refuse it if the window is already full.
 *
 * Counts BEFORE recording, so the limit reads as "N attempts per window" rather
 * than "N-1". Records whether or not the attempt is allowed -- a limiter that
 * only counted refusals would let a client at the threshold continue forever.
 *
 * Takes an `Sql` that must NOT be the report's transaction. See the header.
 */
export async function consumeReportRateLimit(
  db: Sql,
  clientFingerprint: string,
): Promise<void> {
  const { count } = await db.one<{ count: string }>(
    `select count(*)::text as count
       from moderation_rate_limit_events
      where bucket = 'report'
        and subject = $1
        and occurred_at > now() - make_interval(mins => $2::int)`,
    [clientFingerprint, REPORT_WINDOW_MINUTES],
  );

  await db.query(
    "insert into moderation_rate_limit_events (bucket, subject) values ('report', $1)",
    [clientFingerprint],
  );

  if (Number(count) >= REPORT_MAX_PER_WINDOW) {
    // `rate_limited`, which maps to 429 -- not `conflict`/409. The distinction
    // is not pedantry: 409 tells a client its request disagrees with the
    // current state, when in fact the identical request succeeds once the
    // window resets. A client written against 409 has no reason to back off,
    // and a flood-control refusal that does not make the flooder wait is not
    // flood control.
    throw AppError.rateLimited("Too many reports from this client. Please wait and try again.", {
      code: "moderation.rate_limited",
      details: {
        bucket: "report" satisfies ModerationRateLimitBucket,
        retryAfterMinutes: REPORT_WINDOW_MINUTES,
      },
    });
  }
}

/**
 * Drop expired counters. Safe to run at any time; called by whatever sweeps the
 * database. Not scheduled here because nothing in this module owns a scheduler.
 */
export async function pruneModerationRateLimitEvents(
  db: Sql,
  olderThanMinutes = REPORT_WINDOW_MINUTES * 24,
): Promise<number> {
  const { rowCount } = await db.query(
    "delete from moderation_rate_limit_events where occurred_at < now() - make_interval(mins => $1::int)",
    [olderThanMinutes],
  );
  return rowCount;
}
