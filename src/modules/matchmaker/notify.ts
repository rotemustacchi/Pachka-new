/**
 * Notify-me: the escape hatch that takes an email address, which is to say the
 * most dangerous endpoint in this module.
 *
 * art-matchmaker, "Escape hatch from the results": "the system stores the
 * answers with the address and confirms the request". And, from "Anonymous
 * submissions are rate limited": the capture "SHALL require a verified email
 * before any message is sent to that address. Exceeding a limit SHALL be
 * refused with a clear message and SHALL NOT reveal whether an address is
 * already stored."
 *
 * WHAT AN ANONYMOUS "SEND MAIL TO THIS ADDRESS" ENDPOINT IS
 * --------------------------------------------------------
 * SECURITY.md S2-21: "Submit `victim@example.com` a thousand times and PACHKA is
 * a mail-bomb relay wearing PACHKA's own DKIM signature. The domain is
 * blocklisted within hours, which breaks order confirmations and payout
 * notifications — the transactional mail the business depends on." So the
 * capture is defended in four independent ways, and none of them is sufficient
 * alone:
 *
 *   1. Rate limited on the client AND on the address (`rate-limit.ts`), because
 *      a distributed submitter passes a per-client limit while still aiming
 *      every message at one mailbox.
 *   2. One row per address, upserted. Twenty submissions are one subscription.
 *   3. One confirmation message per address per window, gated on
 *      `confirmation_sent_at`, so even twenty ALLOWED submissions are one email.
 *   4. Double opt-in. Nothing but the confirmation is ever sent to an address
 *      that has not confirmed, so the worst an attacker achieves against a
 *      victim's mailbox is a single message they can ignore.
 *
 * THE RESPONSE IS THE SAME SHAPE, ALWAYS
 * --------------------------------------
 * "the response is identical both times and does not disclose that the address
 * was already stored." `acknowledged` is the only thing a caller may put in
 * front of a visitor, it is `true` in every case, and `NOTIFY_ACKNOWLEDGEMENT`
 * is a constant phrased conditionally. A timing difference remains
 * theoretically observable; an observable response difference does not exist,
 * because there is nothing for the route to vary on.
 *
 * `notifications` is the other field, and it is NOT a response. It is the work
 * list the composition root dispatches after this returns, and it is empty in
 * exactly the cases where nothing should be sent — an address already
 * confirmed, or one whose confirmation window has not reopened. A route that
 * branched on its length would rebuild the membership oracle by hand; the rule
 * is that it goes to `dispatchAppNotifications` and nowhere else, and the route
 * that does this is a dozen lines long so that the rule is checkable by eye.
 *
 * THIS MODULE NO LONGER SENDS, WHICH REMOVES THE LAST WAY TO LEAK
 * --------------------------------------------------------------
 * It used to compose the confirmation and hand it to a `Mailer`, wrapping the
 * call in a `catch` that swallowed everything — because a provider outage that
 * produced a 502 for stored addresses and a 200 for new ones would be the very
 * oracle the rest of this file exists to prevent. That `catch` is now
 * structural rather than remembered: the send happens in
 * `dispatchNotifications`, which never throws, on the far side of a function
 * that has already returned the same value either way.
 */
import { randomBytes } from "node:crypto";
import type { Database, Sql } from "@/shared/db";
import { AppError } from "@/shared/errors";
import type { NotificationRequest } from "@/shared/mail";
import { matchmakerRateLimits } from "./config";
import { consumeNotifyRateLimit, hashSubject } from "./rate-limit";

/** Every template this module emits. */
export const MATCHMAKER_TEMPLATES = {
  notifyConfirmation: "matchmaker.notify_confirmation",
} as const;

export type MatchmakerTemplate =
  (typeof MATCHMAKER_TEMPLATES)[keyof typeof MATCHMAKER_TEMPLATES];

/**
 * What the capture returns.
 *
 * `acknowledged` is the visitor-facing half and is deliberately constant: a
 * field is a thing that can differ, and every difference between the two cases
 * is a membership oracle. `notifications` is the caller-facing half and is
 * deliberately NOT visitor-facing; see the header.
 */
export interface NotifyCaptureResult {
  readonly acknowledged: true;
  /**
   * Zero or one descriptor, for the composition root to dispatch after this
   * returns. Empty means nothing is to be sent, which is a normal outcome and
   * not a failure.
   */
  readonly notifications: readonly NotificationRequest<"subscriber">[];
}

const ACKNOWLEDGED_ONLY: NotifyCaptureResult = { acknowledged: true, notifications: [] };

/** What a buyer sees either way. One string, so there is only one to read. */
export const NOTIFY_ACKNOWLEDGEMENT =
  "אם הכתובת תקינה, נעדכן אתכם כשיגיעו עבודות שמתאימות לתשובות שלכם.";

/**
 * A token that is random and not derived from anything.
 *
 * SECURITY.md S2-21 item 4 requires this of the unsubscribe token specifically —
 * "random and not derived from the address" — because a token computed from the
 * address can be computed for someone else's address. The confirmation token
 * gets the same treatment: it is the thing that turns an unconfirmed row into a
 * mailable one.
 */
function token(): string {
  return randomBytes(32).toString("hex");
}

/**
 * Normalise an address, and reject one that cannot be an address at all.
 *
 * Deliberately a shape check, not a validity check: the only thing that
 * establishes an address is real is the confirmation round trip, which is
 * already required. A stricter regex here would reject valid addresses and
 * still not prove anything about the ones it let through.
 */
export function normaliseEmail(raw: unknown): string {
  const value = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  const looksLikeAddress = /^[^\s@]+@[^\s@.]+\.[^\s@]+$/.test(value);
  if (!looksLikeAddress || value.length > 254) {
    throw AppError.validation("That does not look like an email address.", {
      code: "matchmaker.email_invalid",
      // No `details.value`: SECURITY.md's log-redaction list names notify-me
      // addresses, and an error object is a thing that gets logged.
      fields: { email: ["כתובת אימייל לא תקינה"] },
    });
  }
  return value;
}

export interface NotifyCaptureInput {
  /** The raw address as submitted. Normalised here, never stored otherwise. */
  readonly email: unknown;
  /** The questionnaire whose answers this subscription is for, if there was one. */
  readonly matchQueryId: string | null;
  /** Already-hashed client identifier. A raw IP never reaches this module. */
  readonly clientFingerprint: string;
}

/**
 * A database, and nothing else.
 *
 * There is no `confirmUrl` here any more either. The token travels in the
 * descriptor's `data` and the root builds the link, which is where the
 * deployment's origin already lived — the function this used to take was only
 * ever a way to borrow it.
 */
export interface NotifyDeps {
  readonly db: Database;
}

/**
 * Capture a notify-me request.
 *
 * Rate limit first, on the pool and outside the transaction below, so a refused
 * attempt still consumes its slot (see `rate-limit.ts`).
 */
export async function captureNotifyRequest(
  deps: NotifyDeps,
  input: NotifyCaptureInput,
): Promise<NotifyCaptureResult> {
  const email = normaliseEmail(input.email);
  await consumeNotifyRateLimit(deps.db, input.clientFingerprint, hashSubject(email));

  const { notify } = await matchmakerRateLimits(deps.db);

  const outcome = await deps.db.withTransaction(async (tx) => {
    const row = await tx.one<{
      id: string;
      confirmation_token: string;
      confirmed_at: Date | null;
      confirmation_sent_at: Date | null;
    }>(
      `insert into notify_requests
         (email, match_query_id, confirmation_token, unsubscribe_token)
       values ($1, $2, $3, $4)
       on conflict (email) do update
          set match_query_id = coalesce(excluded.match_query_id, notify_requests.match_query_id)
       returning id, confirmation_token, confirmed_at, confirmation_sent_at`,
      [email, input.matchQueryId, token(), token()],
    );

    // Already confirmed: nothing to send, and nothing to say about it.
    if (row.confirmed_at !== null) return null;

    // One confirmation per address per window (SECURITY.md S2-21 item 4). The
    // stamp is claimed INSIDE the transaction and before the send, so two
    // concurrent submissions cannot both decide they are the one that mails.
    const claimed = await tx.query(
      `update notify_requests
          set confirmation_sent_at = now()
        where id = $1
          and (confirmation_sent_at is null
               or confirmation_sent_at < now() - make_interval(mins => $2::int))`,
      [row.id, notify.windowMinutes],
    );
    if (claimed.rowCount === 0) return null;

    return { subscriptionId: row.id, confirmationToken: row.confirmation_token };
  });

  if (outcome === null) return ACKNOWLEDGED_ONLY;

  return {
    acknowledged: true,
    notifications: [
      {
        audience: "subscriber",
        template: MATCHMAKER_TEMPLATES.notifyConfirmation,
        // The subscription's row id, not the address. SECURITY.md's redaction
        // list names notify-me addresses, and a descriptor is a thing that gets
        // logged; the root reads the address back out of `notify_requests`,
        // which also means an address that unsubscribed in between is simply
        // not there to be written to.
        recipientId: outcome.subscriptionId,
        data: { confirmationToken: outcome.confirmationToken },
      },
    ],
  };
}

/**
 * Confirm a subscription. Idempotent, and silent about a token that matches
 * nothing — a confirmation endpoint that distinguished "wrong token" from
 * "already confirmed" would be an oracle for which tokens exist.
 */
export async function confirmNotifyRequest(db: Sql, confirmationToken: string): Promise<void> {
  await db.query(
    `update notify_requests
        set confirmed_at = coalesce(confirmed_at, now())
      where confirmation_token = $1`,
    [confirmationToken],
  );
}

/**
 * Unsubscribe. Removes the row rather than tombstoning it: SECURITY.md S3-30 is
 * about PII accumulating with no deletion path, and an address that has asked
 * not to be contacted is the clearest case there is for not keeping it.
 */
export async function unsubscribeNotifyRequest(db: Sql, unsubscribeToken: string): Promise<number> {
  const { rowCount } = await db.query("delete from notify_requests where unsubscribe_token = $1", [
    unsubscribeToken,
  ]);
  return rowCount;
}
