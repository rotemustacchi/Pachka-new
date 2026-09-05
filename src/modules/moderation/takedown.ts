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
import type { NotificationRequest } from "@/shared/mail";
import { withAdminAction } from "./admin";
import { recordAdminAction, type AuditEntry } from "./audit";
import type { ModerationDeps } from "./deps";
import { artworksDepsOn } from "./deps";
import { MODERATION_TEMPLATES, REPORT_REASON_LABELS, isReportReason } from "./reports";
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
  /**
   * The artist's notice, for the caller to dispatch now that the takedown is
   * committed. Always exactly one: whether the artist has a contact address on
   * file is a question for the address book, not for this module, and a
   * takedown stands either way.
   */
  readonly notifications: readonly NotificationRequest<"artist">[];
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
  // takedown -- the same reasoning `reports.ts` sets out for the operator alert,
  // and the same conclusion: describe it, do not send it.
  return {
    artwork: outcome.artwork,
    audit: outcome.audit,
    notifications: [artistNotice(outcome.artwork, reason)],
  };
}

/**
 * Describe the artist's notice. Sends nothing, reads nothing.
 *
 * The artist's address is deliberately absent. It lives in
 * `artist_contact_details`, which has all grants revoked from anon and
 * authenticated; this used to read it here and hand it straight to a mailer,
 * which worked but put a private column in a module that has no other reason to
 * touch one. `recipientId` is the artist's account id, and the composition
 * root's address book -- which runs on the same privileged connection, and is
 * the one place that resolution is written down -- turns it into an address.
 * The address is not returned to any caller and does not appear in the audit
 * entry, exactly as before.
 */
function artistNotice(artwork: Artwork, reason: string): NotificationRequest<"artist"> {
  return {
    audience: "artist",
    template: MODERATION_TEMPLATES.artworkTakenDown,
    recipientId: artwork.artistId,
    data: {
      artworkId: artwork.id,
      artworkTitle: artwork.title ?? "",
      reason,
      // The reporter's own label rather than the enum, resolved here where the
      // set is defined: the artist reads "Undeclared AI generation", never
      // `undeclared_ai`.
      reasonLabel: humanReason(reason),
    },
  };
}

/**
 * A takedown reason may be one of the report reasons or free text. Rendering
 * the label for the former means the artist reads the same words the reporter
 * chose from, rather than `not_original_work`.
 */
function humanReason(reason: string): string {
  return isReportReason(reason) ? REPORT_REASON_LABELS[reason] : reason;
}
