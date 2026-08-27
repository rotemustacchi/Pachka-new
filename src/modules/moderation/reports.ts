/**
 * Public reporting.
 *
 * moderation-admin, "Public reporting": a report action on every artwork detail
 * page and artist profile, available to any visitor whether signed in or not,
 * requiring a reason from a fixed set and accepting optional free text.
 *
 * This is one of exactly two surfaces where an anonymous stranger writes to the
 * database, so the shape of the function is mostly refusals: a reason from the
 * set or nothing, a client identifier or nothing, a subject that actually
 * exists, and a rate limit that survives its own refusal.
 *
 * WHY THE MAIL IS SENT AFTER THE COMMIT, WHEN THE AUDIT ROW IS NOT
 * ----------------------------------------------------------------
 * `suspension.ts` goes to some trouble to put the audit row inside the action's
 * transaction, and this file deliberately does the opposite with the operator
 * email. They are not inconsistent: the audit row is a CONTROL -- an action
 * that commits unaudited is the failure SECURITY.md S1-14 is about -- whereas
 * the notification is a COURTESY, and the spec is explicit that losing it must
 * not lose the report: "the notification email cannot be sent -> the report is
 * still recorded in the admin queue and the failure is logged". Sending inside
 * the transaction would also hold a database connection open across an SMTP
 * round trip, which is its own problem.
 *
 * The outcome is written onto the report row rather than only logged, because
 * "and the failure is logged" needs to be something an operator can query for
 * -- "which reports did we never hear about" -- and something a test can assert.
 */
import { getConfig } from "@/shared/config";
import { AppError } from "@/shared/errors";
import type { Sql, Tx } from "@/shared/db";
import type { ModerationDeps } from "./deps";
import { consumeReportRateLimit, hashSubject } from "./rate-limit";

/**
 * The fixed set, exactly as the spec enumerates it: "not original work,
 * mass-produced item, undeclared AI generation, offensive content, misleading
 * listing, other". Mirrors the CHECK constraint on `reports.reason`.
 */
export const REPORT_REASONS = [
  "not_original_work",
  "mass_produced",
  "undeclared_ai",
  "offensive_content",
  "misleading_listing",
  "other",
] as const;

export type ReportReason = (typeof REPORT_REASONS)[number];

/** What a visitor sees next to each radio button. */
export const REPORT_REASON_LABELS: Readonly<Record<ReportReason, string>> = {
  not_original_work: "Not the artist's own work",
  mass_produced: "Mass-produced item",
  undeclared_ai: "Undeclared AI generation",
  offensive_content: "Offensive content",
  misleading_listing: "Misleading listing",
  other: "Something else",
};

export function isReportReason(value: unknown): value is ReportReason {
  return typeof value === "string" && (REPORT_REASONS as readonly string[]).includes(value);
}

export type ReportSubject =
  | { readonly type: "artwork"; readonly artworkId: string }
  | { readonly type: "artist"; readonly artistId: string };

export interface FileReportInput {
  readonly subject: ReportSubject;
  /** Must be one of REPORT_REASONS. Anything else, including absent, is refused. */
  readonly reason: string | null | undefined;
  readonly details?: string | null;
  /** Present when the reporter happens to be signed in. Most are not. */
  readonly reporterId?: string | null;
  /**
   * Whatever identifies the client for rate limiting -- an IP address, in
   * practice. Hashed before it is stored or counted; the raw value never
   * reaches a column. Required: a report nobody can rate-limit is the flood.
   */
  readonly clientId?: string | null;
}

export interface FileReportResult {
  readonly reportId: string;
  readonly subjectType: "artwork" | "artist";
  readonly subjectId: string;
  /**
   * Open reports against this subject, INCLUDING this one, counted from the
   * rows that exist. Never a stored counter -- see the migration header.
   */
  readonly reportCount: number;
  readonly notified: boolean;
  readonly notificationError: string | null;
  /** What the visitor is shown. The spec asks for a confirmation of receipt. */
  readonly message: string;
}

const RECEIPT = "Thank you. Your report has been sent to the PACHKA team for review.";

export async function fileReport(
  deps: ModerationDeps,
  input: FileReportInput,
): Promise<FileReportResult> {
  const reason = requireReason(input.reason);
  const details = normaliseDetails(input.details);

  // A report that cannot be rate-limited is the flooding the spec requires be
  // refused, so an unidentifiable client is refused before anything is written.
  // A signed-in reporter identifies themselves by definition, so their account
  // id is a usable fallback when the request carries no address.
  const clientId = input.clientId?.trim() || input.reporterId?.trim() || "";
  if (clientId.length === 0) {
    throw AppError.validation("A report must come from an identifiable client", {
      code: "moderation.report_client_required",
    });
  }
  const fingerprint = hashSubject(clientId);

  // Deliberately on the pool, not in the transaction below. See rate-limit.ts.
  await consumeReportRateLimit(deps.db, fingerprint);

  const recorded = await deps.db.withTransaction(async (tx) => {
    const subject = await resolveSubject(tx, input.subject);

    const row = await tx.one<{ id: string }>(
      `insert into reports
         (subject_type, artwork_id, artist_id, reason, details, reporter_id, reporter_fingerprint)
       values ($1, $2, $3, $4, $5, $6, $7)
       returning id`,
      [
        subject.type,
        subject.type === "artwork" ? subject.id : null,
        subject.type === "artist" ? subject.id : null,
        reason,
        details,
        input.reporterId ?? null,
        fingerprint,
      ],
    );

    return { reportId: row.id, subjectType: subject.type, subjectId: subject.id };
  });

  // Committed. Everything from here on can fail without costing the report.
  const notification = await notifyOperator(deps, {
    reportId: recorded.reportId,
    subjectType: recorded.subjectType,
    subjectId: recorded.subjectId,
    reason,
    details,
  });

  return {
    ...recorded,
    reportCount: await openReportCount(deps.db, recorded.subjectType, recorded.subjectId),
    notified: notification.sent,
    notificationError: notification.error,
    message: RECEIPT,
  };
}

/** Open reports against one subject. Derived on every read; never stored. */
export async function openReportCount(
  sql: Sql,
  subjectType: "artwork" | "artist",
  subjectId: string,
): Promise<number> {
  const row = await sql.one<{ count: string }>(
    `select count(*)::text as count
       from reports
      where subject_type = $1 and subject_id = $2 and status = 'open'`,
    [subjectType, subjectId],
  );
  return Number(row.count);
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function requireReason(value: string | null | undefined): ReportReason {
  // "A visitor attempts to submit a report with no reason selected -> the
  // system rejects the submission." Absent and unrecognised are the same
  // refusal: a reason outside the set is not a reason.
  if (value === null || value === undefined || value.trim().length === 0) {
    throw AppError.validation("Choose a reason for this report", {
      code: "moderation.report_reason_required",
      fields: { reason: ["Required"] },
    });
  }
  if (!isReportReason(value)) {
    throw AppError.validation("That is not one of the reasons a report may give", {
      code: "moderation.report_reason_unknown",
      fields: { reason: ["Not a permitted reason"] },
      details: { permitted: REPORT_REASONS },
    });
  }
  return value;
}

function normaliseDetails(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  if (trimmed.length === 0) return null;
  if (trimmed.length > 2000) {
    throw AppError.validation("That description is too long", {
      code: "moderation.report_details_too_long",
      fields: { details: ["Keep it under 2000 characters"] },
    });
  }
  return trimmed;
}

/**
 * Check the subject exists before writing a row that references it.
 *
 * The foreign keys would refuse a bad reference anyway; this turns that into a
 * `not_found` naming the subject rather than a constraint violation surfacing
 * from three frames away. Neither artworks nor artist profiles are secret, so
 * saying "no such artwork" reveals nothing a catalogue page does not.
 */
async function resolveSubject(
  tx: Tx,
  subject: ReportSubject,
): Promise<{ type: "artwork" | "artist"; id: string }> {
  if (subject.type === "artwork") {
    const row = await tx.maybeOne<{ id: string }>("select id from artworks where id = $1", [
      subject.artworkId,
    ]);
    if (!row) {
      throw AppError.notFound("No such artwork", { code: "moderation.subject_not_found" });
    }
    return { type: "artwork", id: row.id };
  }

  const row = await tx.maybeOne<{ user_id: string }>(
    "select user_id from artist_profiles where user_id = $1",
    [subject.artistId],
  );
  if (!row) {
    throw AppError.notFound("No such artist", { code: "moderation.subject_not_found" });
  }
  return { type: "artist", id: row.user_id };
}

interface NotificationSubject {
  readonly reportId: string;
  readonly subjectType: "artwork" | "artist";
  readonly subjectId: string;
  readonly reason: ReportReason;
  readonly details: string | null;
}

/**
 * Tell the operator, and record what happened either way.
 *
 * Never throws. The report is already committed by the time this runs, and the
 * spec requires that it stay committed whatever the mail server does.
 */
async function notifyOperator(
  deps: ModerationDeps,
  subject: NotificationSubject,
): Promise<{ sent: boolean; error: string | null }> {
  const record = async (error: string | null): Promise<{ sent: boolean; error: string | null }> => {
    await deps.db.query(
      `update reports
          set notified_at = case when $2::text is null then now() else null end,
              notification_error = $2
        where id = $1`,
      [subject.reportId, error],
    );
    return { sent: error === null, error };
  };

  try {
    const to = (await getConfig(deps.db, "moderation.operator_email")).trim();
    if (to.length === 0) {
      // Registered with an empty default and "Must be set before launch". An
      // unset address is an operational failure, recorded like any other rather
      // than silently reported as a successful notification.
      return record("No operator address is configured (moderation.operator_email)");
    }
    if (!deps.mailer) {
      return record("No mailer is wired in");
    }

    await deps.mailer.send({
      to,
      subject: `New PACHKA report: ${subject.subjectType} ${subject.subjectId}`,
      body: notificationBody(deps, subject),
    });
    return record(null);
  } catch (cause) {
    return record(cause instanceof Error ? cause.message.slice(0, 500) : "Unknown mail failure");
  }
}

function notificationBody(deps: ModerationDeps, subject: NotificationSubject): string {
  return [
    `A new report has been filed against ${subject.subjectType} ${subject.subjectId}.`,
    ``,
    `Reason: ${REPORT_REASON_LABELS[subject.reason]}`,
    ...(subject.details ? [`Details: ${subject.details}`] : []),
    ``,
    `Queue item: ${queueItemUrl(deps, subject.subjectType, subject.subjectId)}`,
  ].join("\n");
}

/**
 * A direct link to the admin queue item, which the spec requires the email to
 * carry.
 */
export function queueItemUrl(
  deps: ModerationDeps,
  subjectType: "artwork" | "artist",
  subjectId: string,
): string {
  // TODO(config): the composition root should pass
  // `publicEnv().NEXT_PUBLIC_SITE_URL` as `deps.siteUrl`. Reading it here would
  // couple this module to a parsed environment that every test would then have
  // to populate, for a string that only appears in an email body.
  const base = (deps.siteUrl ?? "http://localhost:3000").replace(/\/+$/, "");
  return `${base}/admin/queue/${subjectType}/${subjectId}`;
}
