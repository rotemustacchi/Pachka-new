"use server";

/**
 * Server Actions for the artist's studio -- the upload form (task 3.3) and the
 * dashboard's lifecycle buttons (task 3.10).
 *
 * Each one does the same three things and nothing else: read the session, call
 * the module, hand back something a form can render. Every rule they appear to
 * enforce is enforced inside `artworks`: ownership, suspension, the state
 * machine, the completeness survey, the reservation check that blocks
 * unlisting. A rule restated here would be a second copy to keep in step.
 *
 * Identity is never a parameter and never a form field. `currentUserId()` reads
 * it from the session on every call; see `(accounts)/deps.ts` for what binding
 * it into the action would cost.
 */
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { AppError } from "@/shared/errors";
import { returnToDraft, unlistArtwork } from "@/modules/artworks";
import { currentUserId } from "../_lib/viewer";
import { text, toFormState, type FormState } from "../_lib/form-state";
import { submitArtworkForm, startDraft } from "./artwork-form";
import { artworksDeps } from "./deps";

/**
 * The acting artist, or a refusal.
 *
 * A page redirects an unauthenticated visitor to sign in; an ACTION cannot,
 * because the submission has already happened and the artist would lose what
 * they typed. So an expired session becomes a message in the banner they are
 * already looking at.
 */
async function actingArtist(): Promise<string> {
  const userId = await currentUserId();
  if (userId === null) {
    throw AppError.forbidden("פג תוקף החיבור. היכנסו שוב ונסו לשמור מחדש.", {
      code: "studio.not_signed_in",
    });
  }
  return userId;
}

/** Save a draft, or publish it -- whichever button was pressed. */
export async function submitArtworkAction(_prev: FormState, form: FormData): Promise<FormState> {
  let state: FormState;
  try {
    state = await submitArtworkForm(artworksDeps(), await actingArtist(), form);
  } catch (error) {
    return toFormState(error);
  }

  if (state.status === "ok") {
    const id = text(form, "artworkId");
    revalidatePath(`/studio/artworks/${id}`);
    revalidatePath("/studio");
  }
  return state;
}

/**
 * Start a new listing.
 *
 * Outside any `try`: `redirect()` works by throwing, and catching it here would
 * turn a created draft into "something went wrong" -- with the draft already in
 * the database.
 */
export async function createDraftAction(): Promise<void> {
  const artwork = await startDraft(artworksDeps(), await actingArtist());
  revalidatePath("/studio");
  redirect(`/studio/artworks/${artwork.id}`);
}

/** Withdraw a published listing. Refused while an order holds it. */
export async function unlistArtworkAction(_prev: FormState, form: FormData): Promise<FormState> {
  try {
    await unlistArtwork(artworksDeps(), await actingArtist(), text(form, "artworkId"));
  } catch (error) {
    return toFormState(error);
  }
  revalidatePath("/studio");
  return { status: "ok", message: "היצירה הוסרה מהקטלוג." };
}

/** Take a listing back to draft, so it can be reworked. */
export async function returnToDraftAction(_prev: FormState, form: FormData): Promise<FormState> {
  try {
    await returnToDraft(artworksDeps(), await actingArtist(), text(form, "artworkId"));
  } catch (error) {
    return toFormState(error);
  }
  revalidatePath("/studio");
  return { status: "ok", message: "היצירה חזרה לטיוטה." };
}
