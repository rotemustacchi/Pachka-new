/**
 * What a Server Action hands back to a form, and the one place that decides
 * what a caught error is allowed to say.
 *
 * `(accounts)/actions.ts` grew its own copy of this before there was a second
 * form to share it with. It is stated here rather than imported from there for
 * a mechanical reason: a `"use server"` module may only export async functions,
 * so a constant and a type cannot live alongside the actions that use them.
 *
 * `AppError` is the only error shape that crosses back to the client. Anything
 * else becomes an opaque message: an unexpected error may carry a connection
 * string or a row of somebody else's data (SECURITY.md S2-26).
 */
import { isAppError, type FieldErrors } from "@/shared/errors";

export interface FormState {
  readonly status: "idle" | "ok" | "error";
  /** Shown at the top of the form. Safe to display verbatim. */
  readonly message?: string;
  readonly fields?: FieldErrors;
}

export const IDLE: FormState = { status: "idle" };

/**
 * Turn a thrown value into something a form can render.
 *
 * Note what is NOT branched on: the error's kind. A route that renders a form
 * shows the message and the field errors whatever the kind was, and the kind is
 * what `httpStatusFor` turns into a status code for the API surfaces. Both read
 * the same error; neither reinterprets it.
 */
export function toFormState(error: unknown): FormState {
  if (isAppError(error)) {
    return {
      status: "error",
      message: error.message,
      ...(error.fields ? { fields: error.fields } : {}),
    };
  }
  return { status: "error", message: "משהו השתבש. נסו שוב." };
}

/** Read a text field. Absent or non-text reads as the empty string. */
export function text(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === "string" ? value : "";
}
