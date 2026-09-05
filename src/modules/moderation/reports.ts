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
 * WHY THE ALERT IS NOT SENT HERE AT ALL, WHEN THE AUDIT ROW IS WRITTEN HERE
 * -------------------------------------------------------------------------
 * `suspension.ts` goes to some trouble to put the audit row inside the action's
 * transaction, and this file deliberately does not do that with the operator
 * alert. They are not inconsistent: the audit row is a CONTROL -- an action
 * that commits unaudited is the failure SECURITY.md S1-14 is about -- whereas
 * the notification is a COURTESY, and the spec is explicit that losing it must
 * not lose the report: "the notification email cannot be sent -> the report is
 * still recorded in the admin queue and the failure is logged".
 *
 * This file used to honour that with a `try`/`catch` around a `Mailer.send`,
 * which meant the guarantee held only as long as nobody deleted the `catch`.
 * `fileReport` now RETURNS the alert as a `NotificationRequest` and sends
 * nothing, so the report is committed and the function has returned before any
 * mail is attempted. The guarantee is structural: there is no send here to
 * fail, and no database connection held open across an SMTP round trip either.
 *
 * The outcome still reaches the row. `recordReportNotification` is how -- the
 * caller dispatches, gets back what happened, and writes it here -- because
 * "and the failure is logged" needs to be something an operator can query for
 * ("which reports did we never hear about") and something a test can assert.
 */
import { AppError } from "@/shared/errors";
import type { Sql, Tx } from "@/shared/db";
import type { NotificationRequest } from "@/shared/mail";
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
  /**
   * The operator's alert, for the caller to dispatch now that the report is
   * committed. Always exactly one; the operator's address is configuration, so
   * whether one is configured is not a question this module can answer.
   */
  readonly notifications: readonly NotificationRequest<"admin">[];
  /** What the visitor is shown. The spec asks for a confirmation of receipt. */
  readonly message: string;
}

/** Every template this module emits. */
export const MODERATION_TEMPLATES = {
  reportFiled: "moderation.report_filed",
  artworkTakenDown: "moderation.artwork_taken_down",
} as const;

export type ModerationTemplate =
  (typeof MODERATION_TEMPLATES)[keyof typeof MODERATION_TEMPLATES];

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

  // Committed. Nothing from here on can cost the report, because nothing from
  // here on does anything but describe it.
  return {
    ...recorded,
    reportCount: await openReportCount(deps.db, recorded.subjectType, recorded.subjectId),
    notifications: [
      {
        audience: "admin",
        template: MODERATION_TEMPLATES.reportFiled,
        // No `recipientId`: the operator queue is not a person, and its address
        // is `moderation.operator_email` in `app_config`.
        data: {
          reportId: recorded.reportId,
          subjectType: recorded.subjectType,
          subjectId: recorded.subjectId,
          reason,
          // The label as well as the enum, because the operator reads the words
          // the reporter chose from and not `undeclared_ai`. Resolved here,
          // where the set is defined, rather than in a mail layer that would
          // have to import this module to know it.
          reasonLabel: REPORT_REASON_LABELS[reason],
          ...(details === null ? {} : { details }),
        },
      },
    ],
    message: RECEIPT,
  };
}

/**
 * Write what happened to the alert onto the report row.
 *
 * Called by whoever dispatched the descriptor, with what the dispatch reported.
 * Separate from `fileReport` on purpose: this module does not send, so it
 * cannot know, and a function that pretended to would be back to composing its
 * own answer. `notified_at` is set only on success, which keeps the query an
 * operator actually wants -- "which reports were we never told about" -- a
 * plain `where notified_at is null`.
 */
export async function recordReportNotification(
  sql: Sql,
  reportId: string,
  outcome: { readonly sent: boolean; readonly error: string | null },
): Promise<void> {
  const error = outcome.sent ? null : (outcome.error ?? "Unknown mail failure");
  await sql.query(
    `update reports
        set notified_at = case when $2::text is null then now() else null end,
            notification_error = $2
      where id = $1`,
    [reportId, error],
  );
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
