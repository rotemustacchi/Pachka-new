/**
 * Artwork takedown.
 *
 * moderation-admin, "Artwork takedown": an admin moves any artwork to
 * `removed`, which immediately withdraws it from the catalog, the matchmaker,
 * and the artist's ability to republish. The artist is notified with the
 * reason. Takedown does NOT affect orders already placed for that artwork.
 *
 * THIS MODULE DOES NOT WRITE `artworks`
 * ------------------------------------
 * `artworks` owns that table, and moderation -> artworks is an allowed edge, so
 * the status change goes through `artworks.removeArtwork`. Its own header
 * anticipated this call: "removeArtwork is one-way, by design. This module does
 * not write your audit row or send the artist's notice; do both alongside it."
 * That is exactly what happens below.
 *
 * `removeArtwork` opens a transaction on the `Database` it is handed. Handed
 * this action's transaction (via `txAsDatabase`), it runs on that one instead
 * of opening a second, so the status change and the audit row commit together
 * or not at all. That is the same coupling `suspension.ts` relies on, and the
 * same test catches it if it is broken.
 *
 * IN-FLIGHT ORDERS
 * ----------------
 * Nothing here reads or writes reservations, and `removeArtwork` deliberately
 * does not check them either. The asymmetry is intended: an artist may not pull
 * a listing out from under a buyer (unlisting is blocked while reserved), but
 * an admin removing stolen work must be able to, and the buyer's existing order
 * continues through its own lifecycle untouched.
 */
import { removeArtwork, type Artwork } from "@/modules/artworks";
import { AppError } from "@/shared/errors";
import type { Sql } from "@/shared/db";
import { withAdminAction } from "./admin";
import { recordAdminAction, type AuditEntry } from "./audit";
import type { ModerationDeps } from "./deps";
import { artworksDepsOn } from "./deps";
import { REPORT_REASON_LABELS, isReportReason } from "./reports";
import { txAsDatabase } from "./tx-database";

export interface TakeDownArtworkInput {
  readonly actorId: string;
  readonly artworkId: string;
  /**
   * Why it is coming down. Told to the artist verbatim, so it is required and
   * free text rather than a code: "the artist is notified with the reason".
   */
  readonly reason: string;
  /** Internal operator note for the audit entry. Not sent to the artist. */
  readonly note?: string;
}

export interface TakeDownArtworkResult {
  readonly artwork: Artwork;
  readonly audit: AuditEntry;
  /** False when the artist could not be emailed. The takedown still stands. */
  readonly artistNotified: boolean;
  readonly notificationError: string | null;
}

export async function takeDownArtwork(
  deps: ModerationDeps,
  input: TakeDownArtworkInput,
): Promise<TakeDownArtworkResult> {
  const reason = input.reason?.trim() ?? "";
  if (reason.length === 0) {
    throw AppError.validation("A takedown must state a reason", {
      code: "moderation.takedown_reason_required",
      fields: { reason: ["Required"] },
    });
  }

  const outcome = await withAdminAction(deps.db, input.actorId, async (tx, actor) => {
    // Runs on this transaction, not a second one. See the header.
    const artwork = await removeArtwork(
      artworksDepsOn(deps, txAsDatabase(tx)),
      actor.userId,
      input.artworkId,
    );

    const audit = await recordAdminAction(tx, {
      action: "artwork_takedown",
      targetType: "artwork",
      targetId: artwork.id,
      note: input.note ?? "",
      details: {
        reason,
        artist_id: artwork.artistId,
        previous_status: artwork.status,
      },
    });

    return { artwork, audit };
  });

  // Committed. The artist's notice is a courtesy, and losing it must not undo a
  // takedown -- the same reasoning `reports.ts` sets out for the operator email.
  const notification = await notifyArtist(deps, outcome.artwork, reason);

  return {
    artwork: outcome.artwork,
    audit: outcome.audit,
    artistNotified: notification.sent,
    notificationError: notification.error,
  };
}

/**
 * Tell the artist their work has been removed, and why.
 *
 * Never throws. The artist's address lives in `artist_contact_details`, which
 * has all grants revoked from anon and authenticated and is reachable only
 * through the privileged server connection -- which is the connection this runs
 * on. It is read here and passed straight to the mailer; it is not returned to
 * any caller, and it does not appear in the audit entry.
 */
async function notifyArtist(
  deps: ModerationDeps,
  artwork: Artwork,
  reason: string,
): Promise<{ sent: boolean; error: string | null }> {
  try {
    if (!deps.mailer) return { sent: false, error: "No mailer is wired in" };

    const to = await artistEmail(deps.db, artwork.artistId);
    if (to === null) {
      return { sent: false, error: "The artist has no contact address on file" };
    }

    await deps.mailer.send({
      to,
      subject: "Your PACHKA listing has been removed",
      body: [
        `Your listing${artwork.title ? ` "${artwork.title}"` : ""} has been removed from PACHKA.`,
        ``,
        `Reason: ${humanReason(reason)}`,
        ``,
        `A removed listing cannot be republished. If you believe this was a`,
        `mistake, reply to this message and the team will look at it again.`,
      ].join("\n"),
    });

    return { sent: true, error: null };
  } catch (cause) {
    return {
      sent: false,
      error: cause instanceof Error ? cause.message.slice(0, 500) : "Unknown mail failure",
    };
  }
}

async function artistEmail(sql: Sql, artistId: string): Promise<string | null> {
  const row = await sql.maybeOne<{ email: string | null }>(
    "select email from artist_contact_details where user_id = $1",
    [artistId],
  );
  const email = row?.email?.trim() ?? "";
  return email.length > 0 ? email : null;
}

/**
 * A takedown reason may be one of the report reasons or free text. Rendering
 * the label for the former means the artist reads the same words the reporter
 * chose from, rather than `not_original_work`.
 */
function humanReason(reason: string): string {
  return isReportReason(reason) ? REPORT_REASON_LABELS[reason] : reason;
}
