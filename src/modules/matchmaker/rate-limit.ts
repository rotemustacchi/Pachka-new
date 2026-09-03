/**
 * Rate limiting on the two anonymous matchmaker surfaces.
 *
 * SECURITY.md's cross-cutting rate-limit table lists both: the matchmaker
 * submission, keyed on IP and session, "Free-tier exhaustion (S2-22),
 * impression inflation (S2-23)"; and notify-me, keyed on IP and address, "Mail
 * bomb (S2-21)".
 *
 * THE ORDERING THAT MATTERS
 * -------------------------
 * The attempt is counted and recorded OUTSIDE the transaction that does the
 * work, and this is the whole design rather than an oversight — the argument is
 * `moderation/rate-limit.ts`'s and it applies here unchanged:
 *
 *   - Counted inside the transaction, refusing an attempt would roll back the
 *     row recording the refused attempt. An attacker could then hammer the
 *     endpoint forever, because every refusal erases its own evidence and the
 *     window never fills.
 *   - Recording before the work means an attempt that later fails for some
 *     other reason still consumed its slot. That is the safe direction to be
 *     wrong in: slightly more limiting than required, rather than slightly
 *     less.
 *
 * SECURITY.md S2-22's test is explicit that a refused submission must not leave
 * a `match_queries` row behind — "Assert rejection with a rate-limit error and
 * assert no additional `match_queries` row is written" — which is why the limit
 * is consumed BEFORE the questionnaire is persisted and not after.
 *
 * Subjects are hashed, for the reason `accounts` and `moderation` both record:
 * unhashed, this table becomes a directory of every client that has ever used
 * the questionnaire and every address that has ever asked to be notified.
 */
import { createHash } from "node:crypto";
import type { Sql } from "@/shared/db";
import { AppError } from "@/shared/errors";
import { matchmakerRateLimits, type RateLimitSetting } from "./config";

export type MatchmakerRateLimitBucket = "questionnaire" | "notify";

/**
 * Hash a subject for storage.
 *
 * Not a secret-keyed MAC, and the same choice `accounts.hashSubject` and
 * `moderation.hashSubject` make: the point is that the table does not become a
 * list of addresses and IPs, not that the values are unguessable to someone who
 * already holds the database.
 */
export function hashSubject(value: string): string {
  return createHash("sha256").update(value.trim().toLowerCase(), "utf8").digest("hex");
}

async function consume(
  db: Sql,
  bucket: MatchmakerRateLimitBucket,
  subjectHash: string,
  limit: RateLimitSetting,
  message: string,
  code: string,
): Promise<void> {
  const { count } = await db.one<{ count: string }>(
    `select count(*)::text as count
       from matchmaker_rate_limit_events
      where bucket = $1
        and subject = $2
        and occurred_at > now() - make_interval(mins => $3::int)`,
    [bucket, subjectHash, limit.windowMinutes],
  );

  // Recorded whether or not the attempt is allowed. A limiter that only counted
  // refusals would let a client sitting exactly at the threshold continue for
  // ever.
  await db.query(
    "insert into matchmaker_rate_limit_events (bucket, subject) values ($1, $2)",
    [bucket, subjectHash],
  );

  if (Number(count) >= limit.maxPerWindow) {
    // `rate_limited` maps to 429, not `conflict`/409. Nothing about the request
    // is wrong and the identical request succeeds once the window resets; a
    // client written against 409 has no reason to back off, and flood control
    // that does not make the flooder wait is not flood control.
    throw AppError.rateLimited(message, {
      code,
      details: { bucket, retryAfterMinutes: limit.windowMinutes },
    });
  }
}

/**
 * Consume a questionnaire slot for this client.
 *
 * `clientFingerprint` is already hashed — the caller hashes whatever identifies
 * the client (an IP, a session id) at the edge, so a raw address never reaches
 * this module at all.
 */
export async function consumeQuestionnaireRateLimit(
  db: Sql,
  clientFingerprint: string,
): Promise<void> {
  const limits = await matchmakerRateLimits(db);
  await consume(
    db,
    "questionnaire",
    clientFingerprint,
    limits.questionnaire,
    "יותר מדי חיפושים מהמכשיר הזה. נסו שוב עוד מעט.",
    "matchmaker.rate_limited",
  );
}

/**
 * Consume a notify-me slot.
 *
 * Two subjects, both counted: the client, and the address. The address matters
 * on its own because SECURITY.md S2-21's attack is `victim@example.com`
 * submitted a thousand times — and a distributed submitter would pass a
 * per-client limit while still aiming every one of those messages at one
 * mailbox.
 *
 * The refusal message is deliberately the same regardless of WHICH limit was
 * hit, and identical to the message a first-time submitter would never see,
 * because "the response is identical both times and does not disclose that the
 * address was already stored" is broken just as thoroughly by a distinguishable
 * error as by a distinguishable success.
 */
export async function consumeNotifyRateLimit(
  db: Sql,
  clientFingerprint: string,
  emailHash: string,
): Promise<void> {
  const limits = await matchmakerRateLimits(db);
  const message = "יותר מדי בקשות. נסו שוב מאוחר יותר.";

  await consume(db, "notify", clientFingerprint, limits.notify, message, "matchmaker.rate_limited");
  await consume(db, "notify", emailHash, limits.notify, message, "matchmaker.rate_limited");
}

/**
 * Drop expired counters. Safe to run at any time; called by whatever sweeps the
 * database. Not scheduled here, because nothing in this module owns a scheduler.
 */
export async function pruneMatchmakerRateLimitEvents(
  db: Sql,
  olderThanMinutes?: number,
): Promise<number> {
  const limits = await matchmakerRateLimits(db);
  // A generous multiple of the longest window, so a counter outlives its own
  // window by a wide margin and the sweep can run on any schedule at all.
  const cutoff =
    olderThanMinutes ??
    Math.max(limits.questionnaire.windowMinutes, limits.notify.windowMinutes) * 24;

  const { rowCount } = await db.query(
    "delete from matchmaker_rate_limit_events where occurred_at < now() - make_interval(mins => $1::int)",
    [cutoff],
  );
  return rowCount;
}
