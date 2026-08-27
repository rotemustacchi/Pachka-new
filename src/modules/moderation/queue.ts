/**
 * The admin queue.
 *
 * moderation-admin, "Admin queue": an admin-only queue listing open reports and
 * uploads flagged by the automated pipeline, sorted by recency, each showing
 * the subject, reason, report count, and current status; each resolvable as
 * dismissed or actioned with a recorded operator note.
 *
 * GROUPING IS A QUERY, NOT A TABLE
 * --------------------------------
 * "Several reports are filed against the same artwork -> the system groups them
 * into a single admin queue item showing the report count." The obvious
 * implementation is a `queue_items` table with a counter, kept in step with
 * `reports` by application code. That is two sources of truth for one number,
 * and the number is the one an operator uses to decide whether to take an
 * artist's livelihood away. Grouping in the read means the count is the rows,
 * always, and the "flooding must not inflate the count" requirement is
 * satisfied by construction rather than by remembering.
 *
 * Everything here is admin-only and refuses with `not_found`, never `forbidden`
 * -- see ./admin for why.
 */
import { AppError } from "@/shared/errors";
import type { Sql, Tx } from "@/shared/db";
import { requireAdmin, withAdminAction } from "./admin";
import { recordAdminAction, type AuditEntry } from "./audit";
import type { ModerationDeps } from "./deps";
import { REPORT_REASON_LABELS, type ReportReason } from "./reports";
import { noFlaggedUploads } from "./ports";

export type QueueItemKind = "report" | "flagged_upload";
export type QueueSubjectType = "artwork" | "artist";
export type QueueResolution = "dismissed" | "actioned";

export interface QueueReason {
  readonly reason: ReportReason;
  readonly label: string;
  readonly count: number;
}

export interface QueueItem {
  readonly kind: QueueItemKind;
  readonly subjectType: QueueSubjectType;
  readonly subjectId: string;
  /** Open reports against this subject. Zero for a pipeline-flagged upload. */
  readonly reportCount: number;
  /** Every distinct reason given, commonest first. */
  readonly reasons: readonly QueueReason[];
  /** What the item is waiting for. Open is the only state that appears here. */
  readonly status: "open";
  /** Newest report, or the moment the pipeline flagged the upload. */
  readonly latestAt: Date;
  /** For a flagged upload: why the pipeline could not clear it. */
  readonly flagNote: string | null;
}

export interface ListQueueOptions {
  readonly limit?: number;
}

/**
 * The queue, newest first.
 *
 * Two sources merged: open reports grouped by subject, and uploads the pipeline
 * flagged. The second arrives through a port because `upload_events` belongs to
 * the `uploads` module, which has not shipped -- see ./ports.
 */
export async function listQueue(
  deps: ModerationDeps,
  actorId: string | null | undefined,
  options: ListQueueOptions = {},
): Promise<QueueItem[]> {
  await requireAdmin(deps.db, actorId);

  const limit = Math.min(Math.max(options.limit ?? 100, 1), 500);

  const reported = await groupedOpenReports(deps.db, limit);
  const flagged = await (deps.uploads ?? noFlaggedUploads).flaggedForReview(deps.db, limit);

  const flaggedItems: QueueItem[] = flagged.map((upload) => ({
    kind: "flagged_upload",
    subjectType: "artwork",
    subjectId: upload.artworkId,
    reportCount: 0,
    reasons: [],
    status: "open",
    latestAt: upload.flaggedAt,
    flagNote: upload.note,
  }));

  return [...reported, ...flaggedItems]
    .sort((a, b) => b.latestAt.getTime() - a.latestAt.getTime())
    .slice(0, limit);
}

interface GroupRow {
  readonly subject_type: QueueSubjectType;
  readonly subject_id: string;
  readonly report_count: string;
  readonly latest_at: Date;
  readonly reasons: ReadonlyArray<{ reason: ReportReason; count: number }>;
}

async function groupedOpenReports(sql: Sql, limit: number): Promise<QueueItem[]> {
  const { rows } = await sql.query<GroupRow>(
    `with per_reason as (
       select subject_type, subject_id, reason,
              count(*)      as reason_count,
              max(created_at) as reason_latest
         from reports
        where status = 'open'
        group by subject_type, subject_id, reason
     )
     select subject_type,
            subject_id,
            sum(reason_count)::text as report_count,
            max(reason_latest)      as latest_at,
            jsonb_agg(
              jsonb_build_object('reason', reason, 'count', reason_count)
              order by reason_count desc, reason
            )                       as reasons
       from per_reason
      group by subject_type, subject_id
      order by latest_at desc
      limit $1`,
    [limit],
  );

  return rows.map((row) => ({
    kind: "report" as const,
    subjectType: row.subject_type,
    subjectId: row.subject_id,
    reportCount: Number(row.report_count),
    reasons: row.reasons.map((entry) => ({
      reason: entry.reason,
      label: REPORT_REASON_LABELS[entry.reason],
      count: Number(entry.count),
    })),
    status: "open" as const,
    latestAt: row.latest_at,
    flagNote: null,
  }));
}

export interface ResolveQueueItemInput {
  readonly actorId: string;
  readonly subjectType: QueueSubjectType;
  readonly subjectId: string;
  readonly outcome: QueueResolution;
  /**
   * Required. "Each item SHALL be resolvable as dismissed or actioned, with a
   * recorded operator note" -- and a dismissal with no stated reason is
   * unreviewable by the next admin who sees the same subject reported again.
   */
  readonly note: string;
}

export interface ResolveQueueItemResult {
  readonly subjectType: QueueSubjectType;
  readonly subjectId: string;
  readonly outcome: QueueResolution;
  /** How many open reports the one decision closed. */
  readonly resolvedCount: number;
  readonly audit: AuditEntry;
}

/**
 * Close every open report against one subject with a single decision.
 *
 * One queue item is a group, so resolving it resolves the group -- otherwise a
 * dismissed item reappears the moment the page is refreshed, carrying the
 * reports the admin just decided about.
 *
 * "The item closes, the artwork is unaffected": nothing here touches the
 * subject. Taking an artwork down is `takeDownArtwork`, a separate, separately
 * audited decision, and keeping them apart is what lets an admin dismiss
 * without acting and act without pretending the reports were justified.
 */
export async function resolveQueueItem(
  deps: ModerationDeps,
  input: ResolveQueueItemInput,
): Promise<ResolveQueueItemResult> {
  const note = input.note?.trim() ?? "";
  if (note.length === 0) {
    throw AppError.validation("Say why you are closing this item", {
      code: "moderation.resolution_note_required",
      fields: { note: ["Required"] },
    });
  }

  return withAdminAction(deps.db, input.actorId, async (tx, actor) => {
    const resolvedIds = await closeOpenReports(tx, input, actor.userId, note);

    if (resolvedIds.length === 0) {
      // Nothing open for this subject: either it was never reported or another
      // admin got there first. `not_found` rather than a silent success, so two
      // admins working the queue at once do not both think they decided it.
      throw AppError.notFound("No open queue item for that subject", {
        code: "moderation.queue_item_not_found",
        details: { subjectType: input.subjectType, subjectId: input.subjectId },
      });
    }

    const audit = await recordAdminAction(tx, {
      action: "report_resolution",
      targetType: "report",
      targetId: input.subjectId,
      note,
      details: {
        subject_type: input.subjectType,
        outcome: input.outcome,
        resolved_report_ids: resolvedIds,
        resolved_count: resolvedIds.length,
      },
    });

    return {
      subjectType: input.subjectType,
      subjectId: input.subjectId,
      outcome: input.outcome,
      resolvedCount: resolvedIds.length,
      audit,
    };
  });
}

async function closeOpenReports(
  tx: Tx,
  input: ResolveQueueItemInput,
  actorId: string,
  note: string,
): Promise<string[]> {
  const { rows } = await tx.query<{ id: string }>(
    `update reports
        set status = $3, resolved_by = $4, resolved_at = now(), resolution_note = $5
      where subject_type = $1 and subject_id = $2 and status = 'open'
      returning id`,
    [input.subjectType, input.subjectId, input.outcome, actorId, note],
  );
  return rows.map((row) => row.id);
}
