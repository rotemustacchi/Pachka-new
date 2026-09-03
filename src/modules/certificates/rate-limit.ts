/**
 * The rate limit on the public verification endpoint.
 *
 * `authenticity-certificate`, *Enumeration is refused*: "WHEN a client requests
 * many certificate identifiers in rapid succession THEN the endpoint rate
 * limits the client." SECURITY.md's cross-cutting table keys it on IP, because
 * the surface is anonymous and there is no account to key on.
 *
 * Counted in Postgres, not in memory. The same reason `accounts/rate-limit.ts`
 * gives: the application runs as serverless functions with no shared memory
 * between invocations, so an in-process counter resets on almost every request
 * and limits nothing at all.
 *
 * The subject is SHA-256 hashed before it is stored. Unhashed, this table
 * becomes a log of every address that has ever looked at a certificate —
 * SECURITY.md's log-redaction rule puts raw client IPs on the never-stored
 * list, and a rate limiter is not an exemption from it.
 *
 * COUNTED BEFORE THE LOOKUP, AND WHETHER OR NOT THE LOOKUP SUCCEEDS
 * -----------------------------------------------------------------
 * Both halves matter. Before, so the expensive work is behind the limit
 * (SECURITY.md: "the limit exists and is enforced server-side before the
 * expensive work"). Whether or not it succeeds, because an enumerator's
 * requests are exactly the ones that fail — a limiter that only counted hits
 * would let someone walk the keyspace at full speed and throttle only the
 * legitimate holder who found their certificate.
 */
import { createHash } from "node:crypto";
import type { Sql } from "@/shared/db";
import { AppError } from "@/shared/errors";
import type { VerificationRateLimit } from "./deps";

/**
 * Hash a subject for storage.
 *
 * Not a secret-keyed MAC, and `accounts/rate-limit.ts` explains why that is
 * enough: "the point is that the table does not become a directory of addresses
 * and IPs, not that the values are unguessable to someone who already holds the
 * database."
 */
export function hashVerificationSubject(value: string): string {
  return createHash("sha256").update(value.trim().toLowerCase(), "utf8").digest("hex");
}

/**
 * Record an attempt and reject it if the window is already full.
 *
 * Counts BEFORE recording, so the limit reads as "N attempts per window" rather
 * than "N-1" — the same arithmetic `accounts` settled on, kept identical so the
 * two limiters cannot be read as meaning different things.
 *
 * Throws `rate_limited`, which `shared/errors` maps to 429. Not `conflict`:
 * nothing about the request is wrong and the same request succeeds once the
 * window resets, which is what a 429 tells a client and a 409 does not.
 */
export async function consumeVerificationAttempt(
  db: Sql,
  clientIp: string,
  limit: VerificationRateLimit,
): Promise<void> {
  const subject = hashVerificationSubject(clientIp);

  const { count } = await db.one<{ count: string }>(
    `select count(*)::text as count
       from certificate_verification_events
      where subject = $1
        and occurred_at > now() - make_interval(mins => $2::int)`,
    [subject, limit.windowMinutes],
  );

  await db.query("insert into certificate_verification_events (subject) values ($1)", [subject]);

  if (Number(count) >= limit.maxPerWindow) {
    // The message says nothing about certificates. A refusal that named the
    // surface would confirm to a prober that the surface exists and that they
    // reached it — and this is the one response on the verification path that
    // is not the uniform not-found.
    throw AppError.rateLimited("Too many requests. Please wait and try again.", {
      code: "certificates.rate_limited",
    });
  }
}

/**
 * Drop expired counters, so the table stays bounded.
 *
 * Called by whatever sweeps the database; safe to run at any time. Not a
 * scheduled job here, because nothing in this module owns a scheduler — the
 * same arrangement `accounts.pruneRateLimitEvents` has.
 */
export async function pruneVerificationEvents(db: Sql, olderThanMinutes = 1440): Promise<number> {
  const { rowCount } = await db.query(
    "delete from certificate_verification_events where occurred_at < now() - make_interval(mins => $1::int)",
    [olderThanMinutes],
  );
  return rowCount;
}
