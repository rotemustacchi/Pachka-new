/**
 * Rate limits on the anonymous auth surface.
 *
 * SECURITY.md's cross-cutting rate-limit table requires these on registration,
 * sign-in, password reset and the artist upgrade. SPEC-J records the reason it
 * had to be written down at all: not one of the ten specs contains the words
 * rate, throttle, quota or abuse, on a free-tier project with open self-service
 * registration.
 *
 * Counted in Postgres rather than in memory because the application runs as
 * serverless functions with no shared memory between invocations. An in-process
 * counter would reset on almost every request and limit nothing at all.
 *
 * Subjects are hashed before they are stored. SECURITY.md's log-redaction rule
 * puts raw client IPs on the never-stored list, and the same argument applies
 * to the addresses counted here: unhashed, this table becomes a list of every
 * email address that has ever tried to register.
 */
import { createHash } from "node:crypto";
import { getConfig, type ConfigKey } from "@/shared/config";
import type { Sql } from "@/shared/db";
import { AppError } from "@/shared/errors";

export type RateLimitBucket =
  | "registration"
  | "signin"
  | "password_reset"
  | "artist_upgrade";

interface BucketConfig {
  readonly windowKey: ConfigKey;
  readonly maxKey: ConfigKey;
}

const BUCKETS: Readonly<Record<RateLimitBucket, BucketConfig>> = {
  registration: {
    windowKey: "accounts.registration_window_minutes",
    maxKey: "accounts.registration_max_per_window",
  },
  signin: {
    windowKey: "accounts.signin_window_minutes",
    maxKey: "accounts.signin_max_per_window",
  },
  password_reset: {
    windowKey: "accounts.password_reset_window_minutes",
    maxKey: "accounts.password_reset_max_per_window",
  },
  artist_upgrade: {
    windowKey: "accounts.artist_upgrade_window_minutes",
    maxKey: "accounts.artist_upgrade_max_per_window",
  },
};

/**
 * Hash a subject for storage. Not a secret-keyed MAC: the point is that the
 * table does not become a directory of addresses and IPs, not that the values
 * are unguessable to someone who already holds the database.
 */
export function hashSubject(value: string): string {
  return createHash("sha256").update(value.trim().toLowerCase(), "utf8").digest("hex");
}

/**
 * Record an attempt and reject it if the window is already full.
 *
 * Counts BEFORE recording, so the limit is "N attempts per window" rather than
 * "N-1". Recording happens whether or not the attempt succeeds -- a limiter
 * that only counted failures would let an attacker with a valid address make
 * unlimited requests.
 */
export async function consumeRateLimit(
  db: Sql,
  bucket: RateLimitBucket,
  subject: string,
): Promise<void> {
  const { windowKey, maxKey } = BUCKETS[bucket];
  const [windowMinutes, max] = await Promise.all([
    getConfig(db, windowKey),
    getConfig(db, maxKey),
  ]);

  const hashed = hashSubject(subject);

  const { count } = await db.one<{ count: string }>(
    `select count(*)::text as count
       from auth_rate_limit_events
      where bucket = $1
        and subject = $2
        and occurred_at > now() - make_interval(mins => $3::int)`,
    [bucket, hashed, windowMinutes],
  );

  await db.query(
    "insert into auth_rate_limit_events (bucket, subject) values ($1, $2)",
    [bucket, hashed],
  );

  if (Number(count) >= Number(max)) {
    // `conflict` is the closest kind the taxonomy has. It maps to 409 where 429
    // would be right -- see the accounts README: `shared/errors` needs a
    // `rate_limited` kind, and that file belongs to the foundation.
    throw AppError.rateLimited("Too many attempts. Please wait and try again.", {
      code: "accounts.rate_limited",
      details: { bucket },
    });
  }
}

/**
 * Drop expired counters. Called by whatever sweeps the database; safe to run at
 * any time. Not a scheduled job here because nothing in this module owns a
 * scheduler.
 */
export async function pruneRateLimitEvents(db: Sql, olderThanMinutes = 1440): Promise<number> {
  const { rowCount } = await db.query(
    "delete from auth_rate_limit_events where occurred_at < now() - make_interval(mins => $1::int)",
    [olderThanMinutes],
  );
  return rowCount;
}
