/**
 * `upload_events` -- the append-only record of what the pipeline decided.
 *
 * This is not a debug log. Three things in the product read it:
 *
 *   1. The publication gate. `screening.ts` asks whether the row currently at
 *      position 0 has a passing verdict, and the answer is derived from these
 *      rows rather than from a status column somebody has to remember to set.
 *   2. The admin queue. `moderation` declares a `FlaggedUploadSource` port and
 *      `flaggedUploads` below implements it -- the module that owns the table
 *      supplying the module that needs to read it, which is what
 *      ARCHITECTURE.md's "cross-module effects go through the owning module's
 *      public API" means in practice.
 *   3. The artist. They are told why an image was rejected, and the SELECT
 *      policy on the table scopes them to their own artworks.
 *
 * THE CLOSED SET IS STATED TWICE
 * ------------------------------
 * Once here and once as a check constraint in the migration, with
 * `uploads-events.test.ts` reading `pg_constraint` and asserting the two agree
 * exactly. Same arrangement the artworks taxonomy uses, same reason: the
 * constraint is the backstop no code path can get around, and drift between it
 * and the application fails the suite rather than shipping.
 */
import type { Sql } from "@/shared/db";
import type { FlaggedUpload } from "./contracts";

export const UPLOAD_EVENTS = [
  /** The local gate refused the image. No paid call was made. */
  "quality_rejected",
  /** Display and thumbnail written to the store, original retained. */
  "derivatives_stored",
  /** Safety screening returned a usable verdict below the block threshold. */
  "screening_passed",
  /** Safety screening flagged the image at or above the threshold. */
  "screening_blocked",
  /**
   * Screening produced no usable verdict: the vendor was unreachable, the retry
   * budget was exhausted, or the response failed to parse. All three block
   * publication (SECURITY.md S2-20 item 3 and SPEC-C).
   */
  "screening_unavailable",
  /** An admin decided the image is fine despite the above. */
  "screening_cleared_by_admin",
  /** Taxonomy and colour suggestions the artist will see pre-filled. */
  "suggestions_recorded",
  /** Values the model returned that are outside the closed set, and were dropped. */
  "suggestions_rejected",
  /** The analysis half of the call produced nothing usable. Does NOT block the upload. */
  "analysis_failed",
  /** What the artist finally chose, and which fields they changed. */
  "classification_recorded",
  "embedding_stored",
  "embedding_failed",
] as const;

export type UploadEvent = (typeof UPLOAD_EVENTS)[number];

/** Events that put an item in front of an admin. */
export const FLAGGED_EVENTS: readonly UploadEvent[] = [
  "screening_blocked",
  "screening_unavailable",
  "analysis_failed",
];

export interface RecordEventInput {
  readonly artworkId: string;
  readonly artistId: string;
  readonly imageId?: string | null;
  readonly event: UploadEvent;
  readonly detail?: Readonly<Record<string, unknown>>;
}

export interface UploadEventRow {
  readonly id: string;
  readonly artworkId: string;
  readonly artistId: string;
  readonly imageId: string | null;
  readonly event: UploadEvent;
  readonly detail: Readonly<Record<string, unknown>>;
  readonly createdAt: Date;
}

interface Row {
  readonly id: string;
  readonly artwork_id: string;
  readonly artist_id: string;
  readonly image_id: string | null;
  readonly event: UploadEvent;
  readonly detail: Readonly<Record<string, unknown>>;
  readonly created_at: Date;
}

const COLUMNS = "id, artwork_id, artist_id, image_id, event, detail, created_at";

function toEvent(row: Row): UploadEventRow {
  return {
    id: row.id,
    artworkId: row.artwork_id,
    artistId: row.artist_id,
    imageId: row.image_id,
    event: row.event,
    detail: row.detail,
    createdAt: row.created_at,
  };
}

/**
 * Append one event.
 *
 * Takes an `Sql`, which a `Tx` satisfies, so a caller can put the event and the
 * thing it describes in one transaction. That coupling is the point for the
 * screening events in particular: a `screening_passed` row that commits without
 * the image it refers to, or an image that commits without its verdict, would
 * each be a way past the publication gate.
 */
export async function recordEvent(sql: Sql, input: RecordEventInput): Promise<UploadEventRow> {
  const row = await sql.one<Row>(
    `insert into upload_events (artwork_id, artist_id, image_id, event, detail)
     values ($1, $2, $3, $4, $5::jsonb)
     returning ${COLUMNS}`,
    [
      input.artworkId,
      input.artistId,
      input.imageId ?? null,
      input.event,
      JSON.stringify(input.detail ?? {}),
    ],
  );
  return toEvent(row);
}

/** Everything recorded for one artwork, newest first. */
export async function eventsFor(
  sql: Sql,
  artworkId: string,
): Promise<readonly UploadEventRow[]> {
  const { rows } = await sql.query<Row>(
    `select ${COLUMNS} from upload_events
      where artwork_id = $1
      order by created_at desc, id desc`,
    [artworkId],
  );
  return rows.map(toEvent);
}

/** The newest event of a given kind for one image, or null. */
export async function latestEventForImage(
  sql: Sql,
  imageId: string,
  events: readonly UploadEvent[],
): Promise<UploadEventRow | null> {
  const row = await sql.maybeOne<Row>(
    `select ${COLUMNS} from upload_events
      where image_id = $1 and event = any($2::text[])
      order by created_at desc, id desc
      limit 1`,
    [imageId, [...events]],
  );
  return row === null ? null : toEvent(row);
}

/**
 * The admin queue's view, implementing `moderation`'s `FlaggedUploadSource`.
 *
 * One row per artwork rather than per event: an artist who retries a broken
 * upload five times has one problem, and five queue items for it would bury
 * every other report. `distinct on` takes ONE flagged event per artwork, and
 * the ordering that picks it is by SEVERITY first and recency second.
 *
 * Severity first because a single upload produces several flagged events at
 * once -- a screening outage costs the analysis half of the same call, so
 * `screening_unavailable` and `analysis_failed` are written in one transaction
 * and share a `created_at` to the microsecond. Ordering by time alone would
 * pick between them arbitrarily, and the moderator would sometimes be told the
 * classification form was blank when the actual problem is that an unscreened
 * image is sitting in a draft.
 */
export async function flaggedUploads(
  sql: Sql,
  limit: number,
): Promise<readonly FlaggedUpload[]> {
  const bounded = Math.min(Math.max(Math.trunc(limit), 1), 200);
  const { rows } = await sql.query<{
    artwork_id: string;
    created_at: Date;
    event: UploadEvent;
    detail: Readonly<Record<string, unknown>>;
  }>(
    `select artwork_id, created_at, event, detail
       from (
         select distinct on (artwork_id)
                artwork_id, created_at, event, detail,
                case event
                  when 'screening_blocked'     then 0
                  when 'screening_unavailable' then 1
                  else 2
                end as severity
           from upload_events
          where event = any($1::text[])
          order by artwork_id, severity, created_at desc, id desc
       ) newest
      order by severity, created_at desc
      limit $2`,
    [[...FLAGGED_EVENTS], bounded],
  );

  return rows.map((row) => ({
    artworkId: row.artwork_id,
    flaggedAt: row.created_at,
    note: noteFor(row.event, row.detail),
  }));
}

/**
 * What the admin reads in the queue.
 *
 * Deliberately our own prose keyed on the event, not the model's words. The
 * detail column can contain the model's description of an attacker-controlled
 * image (SECURITY.md S2-20), and the queue is a place a moderator skims -- so
 * the summary line is written here and the raw detail is something they open
 * deliberately.
 */
function noteFor(event: UploadEvent, detail: Readonly<Record<string, unknown>>): string {
  switch (event) {
    case "screening_blocked": {
      const categories = Array.isArray(detail.categories) ? detail.categories.join(", ") : "";
      return categories === ""
        ? "סינון התוכן חסם את התמונה."
        : `סינון התוכן חסם את התמונה (${categories}).`;
    }
    case "screening_unavailable":
      return "שירות סינון התוכן לא היה זמין. הפרסום חסום עד לסינון מוצלח או אישור מנהל.";
    case "analysis_failed":
      return "ניתוח התמונה נכשל. הסיווג הושלם ידנית על ידי האמן.";
    default:
      return "העלאה מסומנת לבדיקה.";
  }
}
