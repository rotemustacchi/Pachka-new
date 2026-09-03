/**
 * Reading the admin queue's forms and handing them to `moderation`.
 *
 * Wiring only. Every decision belongs to the module and is left there:
 *
 *   • whether the caller may act at all — `withAdminAction` re-authorises
 *     inside the transaction that writes the audit row, so an action cannot
 *     succeed unaudited (SECURITY.md S1-14);
 *   • whether a note is required — `resolveQueueItem` refuses an empty one;
 *   • what a takedown does to in-flight orders — nothing, by design;
 *   • what happens to a suspended artist's published work and payouts.
 *
 * AUTHORISATION HAPPENS FIRST, BEFORE THE INPUT IS LOOKED AT. Not because the
 * module forgets to check — every one of these re-authorises inside the
 * transaction that writes its audit row — but because some of them validate
 * their input first, and a non-admin who posts an empty note would otherwise be
 * told "say why you are closing this item". That is a different answer from
 * "not found", and a different answer is the leak. Refusing before parsing
 * makes every refusal identical whatever was posted.
 *
 * THE REFUSAL MESSAGE IS THE MODULE'S, VERBATIM. A non-admin gets `not_found`
 * with the message "Not found", identically for an absent account, a signed-out
 * visitor, a buyer, an artist, and an admin whose own account is suspended.
 * Nothing here inspects the kind and rephrases it — a friendlier "you are not
 * an admin" would undo the module's care by confirming the surface exists.
 */
import { AppError } from "@/shared/errors";
import {
  reinstateAccount,
  requireAdmin,
  resolveQueueItem,
  suspendAccount,
  takeDownArtwork,
  type ModerationDeps,
  type QueueResolution,
  type QueueSubjectType,
} from "@/modules/moderation";
import { text, toFormState, type FormState } from "../_lib/form-state";

function subjectType(value: string): QueueSubjectType {
  if (value === "artwork" || value === "artist") return value;
  throw AppError.validation("Unknown queue subject", {
    code: "admin.unknown_subject_type",
    details: { subjectType: value },
  });
}

function outcome(value: string): QueueResolution {
  if (value === "dismissed" || value === "actioned") return value;
  throw AppError.validation("Choose dismissed or actioned", {
    code: "admin.unknown_outcome",
    fields: { outcome: ["בחרו בין דחייה לטיפול"] },
  });
}

function required(form: FormData, field: string, message: string): string {
  const value = text(form, field).trim();
  if (value === "") {
    throw AppError.validation(message, {
      code: "admin.missing_field",
      fields: { [field]: [message] },
    });
  }
  return value;
}

/** Close every open report against one subject with a single decision. */
export async function resolveFromForm(
  deps: ModerationDeps,
  actorId: string | null,
  form: FormData,
): Promise<FormState> {
  try {
    await requireAdmin(deps.db, actorId);

    const result = await resolveQueueItem(deps, {
      actorId: actorId ?? "",
      subjectType: subjectType(text(form, "subjectType")),
      subjectId: text(form, "subjectId"),
      outcome: outcome(text(form, "outcome")),
      note: text(form, "note"),
    });

    return {
      status: "ok",
      message:
        result.outcome === "dismissed"
          ? `הדיווחים נדחו (${result.resolvedCount}).`
          : `הדיווחים סומנו כטופלו (${result.resolvedCount}).`,
    };
  } catch (error) {
    return toFormState(error);
  }
}

/**
 * Remove an artwork from every public surface. One-way, by design: `removed` is
 * terminal for every role, admins included (ARCHITECTURE.md).
 */
export async function takeDownFromForm(
  deps: ModerationDeps,
  actorId: string | null,
  form: FormData,
): Promise<FormState> {
  try {
    await requireAdmin(deps.db, actorId);

    const result = await takeDownArtwork(deps, {
      actorId: actorId ?? "",
      artworkId: text(form, "artworkId"),
      reason: required(form, "reason", "יש לציין סיבה להסרה"),
      note: text(form, "note") || undefined,
    });

    // The notification outcome is reported rather than hidden: with no mailer
    // wired, the artist has not actually been told, and an admin who assumes
    // otherwise will not follow up.
    return {
      status: "ok",
      message: result.artistNotified
        ? "היצירה הוסרה והאמן קיבל הודעה."
        : "היצירה הוסרה. הודעת הדוא״ל לא נשלחה — יש ליידע את האמן ידנית.",
    };
  } catch (error) {
    return toFormState(error);
  }
}

/** Suspend an account: sessions end, published work leaves the catalog. */
export async function suspendFromForm(
  deps: ModerationDeps,
  actorId: string | null,
  form: FormData,
): Promise<FormState> {
  try {
    await requireAdmin(deps.db, actorId);

    const result = await suspendAccount(deps, {
      actorId: actorId ?? "",
      userId: text(form, "userId"),
      reason: required(form, "reason", "יש לציין סיבה להשעיה"),
      note: text(form, "note") || undefined,
    });

    return {
      status: "ok",
      message: `החשבון הושעה. תשלומים ממתינים שסומנו: ${result.payoutsFlagged}.`,
    };
  } catch (error) {
    return toFormState(error);
  }
}

/**
 * Lift a suspension.
 *
 * Restores previously published artworks "excluding any individually removed",
 * which the module handles. That exclusion is only stable because `removed` is
 * one-way; nothing here may offer to reinstate a removed artwork.
 */
export async function reinstateFromForm(
  deps: ModerationDeps,
  actorId: string | null,
  form: FormData,
): Promise<FormState> {
  try {
    await requireAdmin(deps.db, actorId);

    await reinstateAccount(deps, {
      actorId: actorId ?? "",
      userId: text(form, "userId"),
      note: text(form, "note") || undefined,
    });
    return { status: "ok", message: "ההשעיה בוטלה." };
  } catch (error) {
    return toFormState(error);
  }
}
