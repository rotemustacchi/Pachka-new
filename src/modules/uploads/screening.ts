/**
 * Safety screening, and the publication gate that depends on it.
 *
 * upload-pipeline, "Safety screening": screen every accepted image for adult,
 * violent and hateful content; block anything flagged at or above the
 * configured confidence; record a blocked upload for admin review. And the
 * sentence this whole file exists for:
 *
 *   "No image SHALL reach a public surface without a successful screening
 *    verdict: a screening failure blocks publication, never merely warns."
 *
 * WHY "PROCEED WITH A WARNING" IS NOT AVAILABLE
 * --------------------------------------------
 * SECURITY.md S0-7 / SPEC-C: the screening service being unreachable is
 * ATTACKER-TRIGGERABLE. Anyone who can burn the vision API's rate limit can
 * decide when screening is "unavailable", so a design where unavailability
 * means "publish anyway with a flag" is a design where the attacker chooses
 * whether their image is screened. The spec was changed accordingly and now
 * says: accept the upload into the artist's draft, block publication until
 * screening succeeds or an admin clears it, flag for admin review, record the
 * failure. That is what `screen` and `assertPublishable` implement between
 * them, and the split is the important part -- the UPLOAD proceeds so the
 * artist does not lose their work, and PUBLICATION does not.
 *
 * S0-7 item 2 is implemented too: a 429 is retryable, not unavailable.
 * Retrying absorbs transient rate limiting, so an attacker inducing 429s buys
 * a delay rather than a bypass. Only once the retry budget is exhausted does
 * the item become genuinely unscreened and go to the admin queue.
 */
import { AppError } from "@/shared/errors";
import type { Sql } from "@/shared/db";
import type { UploadThresholds } from "./config";
import { latestEventForImage, recordEvent } from "./events";
import { isRetryable, type VisionAnalyst, type VisionRequest } from "./ports";
import { parseAnalysis, type ParsedAnalysis } from "./analysis";
import type { ListingLimits } from "@/modules/artworks";

/**
 * The retry budget, and why it is not in `app_config`.
 *
 * It bounds how long one request may spend inside one vendor call before
 * giving up, which is a resource decision about our own server rather than a
 * quality threshold an operator tunes. An operator who could set it to 50
 * could make every upload hang for minutes. `deps.screening` overrides it for
 * tests, which is also how the backoff becomes zero there -- ARCHITECTURE.md
 * forbids a sleeping test, and a test that waits three real seconds to prove
 * a retry happened is exactly the kind it forbids.
 */
export interface RetryPolicy {
  /** Total attempts, including the first. */
  readonly attempts: number;
  /** Milliseconds to wait before attempt n+1. Indexed from 0. */
  readonly backoffMs: readonly number[];
}

export const DEFAULT_RETRY: RetryPolicy = { attempts: 3, backoffMs: [250, 1000] };

/** Screening produced a usable verdict, or it did not. Three outcomes, no fourth. */
export type ScreeningOutcome =
  | { readonly status: "passed"; readonly analysis: ParsedAnalysis }
  | { readonly status: "blocked"; readonly analysis: ParsedAnalysis }
  | { readonly status: "unavailable"; readonly reason: string };

function wait(ms: number): Promise<void> {
  return ms <= 0 ? Promise.resolve() : new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Call the model, retrying only what is worth retrying, and decide.
 *
 * A response that fails to parse is `unavailable`, not `passed`. SECURITY.md
 * S2-20 item 3: with one combined call rather than a separate safety call, "the
 * safety field is parsed from a strictly typed schema and ... any parse
 * deviation is treated as a screening failure (which, per S0-7, blocks
 * publication rather than allowing it)".
 */
export async function screen(
  analyst: VisionAnalyst,
  request: VisionRequest,
  thresholds: UploadThresholds,
  limits: ListingLimits,
  retry: RetryPolicy = DEFAULT_RETRY,
): Promise<ScreeningOutcome> {
  let lastReason = "screening did not run";

  for (let attempt = 0; attempt < Math.max(1, retry.attempts); attempt += 1) {
    let raw: unknown;
    try {
      raw = await analyst.analyse(request);
    } catch (error) {
      lastReason = error instanceof Error ? error.message : String(error);
      // Only rate limiting is worth another attempt. A malformed request or a
      // hard vendor error will fail the same way three times in a row, and
      // retrying it just makes the artist wait to be told the same thing.
      if (isRetryable(error) && attempt + 1 < retry.attempts) {
        await wait(retry.backoffMs[attempt] ?? 0);
        continue;
      }
      return { status: "unavailable", reason: lastReason };
    }

    const analysis = parseAnalysis(raw, limits);
    if (analysis === null) {
      return {
        status: "unavailable",
        reason: "the screening response did not match the expected schema",
      };
    }

    const blocked =
      analysis.safety.verdict === "unsafe" &&
      analysis.safety.confidence >= thresholds.safetyConfidenceThreshold;

    return blocked ? { status: "blocked", analysis } : { status: "passed", analysis };
  }

  return { status: "unavailable", reason: lastReason };
}

/**
 * Whether this artwork's CURRENT primary image has been cleared for publication.
 *
 * Derived, every time, from the event log. Not cached, not stored on the
 * artwork, and not passed in by the caller -- three things that would each
 * reintroduce the failure mode the spec is guarding against, which is a
 * publication path that does not consult screening at all.
 *
 * Reads the row at position 0 rather than "the image the pipeline just
 * processed", so replacing the primary image with an unscreened one re-arms the
 * gate without anybody having to remember to.
 */
export async function primaryImageIsScreened(sql: Sql, artworkId: string): Promise<boolean> {
  const row = await sql.maybeOne<{ screened: boolean }>(
    "select uploads.primary_image_is_screened($1) as screened",
    [artworkId],
  );
  return row?.screened === true;
}

/**
 * The gate. Throws unless this artwork may go public.
 *
 * `conflict` rather than `forbidden`: nothing is wrong with the artist or the
 * request, and the same request succeeds once screening does. `forbidden` would
 * tell an artist they are not allowed to publish their own work.
 */
export async function assertPublishable(sql: Sql, artworkId: string): Promise<void> {
  if (await primaryImageIsScreened(sql, artworkId)) return;

  throw AppError.conflict(
    "התמונה הראשית עדיין לא עברה סינון תוכן, ולכן לא ניתן לפרסם את היצירה. " +
      "היצירה נשמרה כטיוטה ותשוחרר לפרסום לאחר סינון מוצלח או אישור מנהל.",
    {
      code: "uploads.screening_incomplete",
      details: { artworkId },
    },
  );
}

/**
 * An admin decides a blocked or unscreened image is fine.
 *
 * Appends rather than editing: `upload_events` has no UPDATE policy for any
 * role, so the `screening_blocked` row stays and the clearance sits next to it.
 * A moderator looking at this artwork in six months sees both, which is what
 * makes the clearance auditable rather than a hole in the record.
 *
 * `moderation` owns writing the `admin_audit` row for the admin action itself;
 * this only records the pipeline's side of it. The caller passes its own
 * transaction so the two commit together.
 */
export async function clearScreening(
  sql: Sql,
  input: {
    readonly artworkId: string;
    readonly artistId: string;
    readonly imageId: string;
    readonly adminId: string;
    readonly reason: string;
  },
): Promise<void> {
  await recordEvent(sql, {
    artworkId: input.artworkId,
    artistId: input.artistId,
    imageId: input.imageId,
    event: "screening_cleared_by_admin",
    detail: { adminId: input.adminId, reason: input.reason },
  });
}

/** The screening verdict recorded for one image, if any. For the admin view. */
export async function screeningVerdictFor(sql: Sql, imageId: string) {
  return latestEventForImage(sql, imageId, [
    "screening_passed",
    "screening_blocked",
    "screening_unavailable",
    "screening_cleared_by_admin",
  ]);
}
