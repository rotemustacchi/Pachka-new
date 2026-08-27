"use server";

/**
 * Server Actions for registration, sign-in, sign-out, password reset, and the
 * artist upgrade — tasks 2.2 and 2.4.
 *
 * Each one does the same three things: read the form, call the module, turn a
 * thrown `AppError` into something a form can render. No decision is made here.
 * In particular, nothing here decides whether an address is already registered
 * or whether a role may be granted; `registration.ts` and
 * `accounts.grant_artist_role()` own those, which is what keeps the answer
 * uniform and the role literal out of reach of the request body.
 *
 * `AppError` is the only error shape that crosses back to the client. Anything
 * else becomes an opaque message: an unexpected error may carry a connection
 * string or a row of somebody else's data (SECURITY.md S2-26).
 */
import { redirect } from "next/navigation";
import { isAppError, type FieldErrors } from "@/shared/errors";
import {
  register,
  requestPasswordReset,
  signIn,
  signOut,
  upgradeToArtist,
} from "@/modules/accounts";
import { accountsDeps, requestIp, requireUserId } from "./deps";

export interface FormState {
  readonly status: "idle" | "ok" | "error";
  /** Shown at the top of the form. Safe to display verbatim. */
  readonly message?: string;
  readonly fields?: FieldErrors;
}

export const IDLE: FormState = { status: "idle" };

/** One place that decides what a caught error is allowed to say. */
function toFormState(error: unknown): FormState {
  if (isAppError(error)) {
    return { status: "error", message: error.message, fields: error.fields };
  }
  return {
    status: "error",
    message: "Something went wrong. Please try again.",
  };
}

function text(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === "string" ? value : "";
}

export async function registerAction(_prev: FormState, form: FormData): Promise<FormState> {
  try {
    const result = await register(await accountsDeps(), {
      email: text(form, "email"),
      password: text(form, "password"),
      displayName: text(form, "displayName"),
      ipAddress: await requestIp(),
    });
    // The same sentence whether or not the address was already registered.
    return { status: "ok", message: result.message };
  } catch (error) {
    return toFormState(error);
  }
}

export async function signInAction(_prev: FormState, form: FormData): Promise<FormState> {
  try {
    await signIn(await accountsDeps(), {
      email: text(form, "email"),
      password: text(form, "password"),
      ipAddress: await requestIp(),
    });
  } catch (error) {
    return toFormState(error);
  }
  // Outside the try: `redirect()` works by throwing, and catching it here would
  // turn a successful sign-in into "Something went wrong".
  redirect("/");
}

export async function signOutAction(): Promise<void> {
  await signOut(await accountsDeps());
  redirect("/");
}

export async function passwordResetAction(_prev: FormState, form: FormData): Promise<FormState> {
  try {
    const result = await requestPasswordReset(await accountsDeps(), {
      email: text(form, "email"),
      ipAddress: await requestIp(),
    });
    return { status: "ok", message: result.message };
  } catch (error) {
    return toFormState(error);
  }
}

/**
 * The artist upgrade.
 *
 * Two things are NOT read from the form. A role: the form could post
 * `role=admin` and it would be ignored, because the literal 'artist' lives
 * inside `accounts.grant_artist_role()` and nothing here passes a role at all
 * (SECURITY.md S0-2). And an account id: identity comes from the session via
 * `requireUserId()`, so this action can only ever upgrade the caller.
 */
export async function upgradeToArtistAction(
  _prev: FormState,
  form: FormData,
): Promise<FormState> {
  try {
    // Identity comes from the session, never from the form or a bound argument.
    const userId = await requireUserId();
    await upgradeToArtist(await accountsDeps(), userId, {
      displayName: text(form, "displayName"),
      biography: text(form, "biography"),
      city: text(form, "city") || null,
      avatarPath: text(form, "avatarPath") || null,
    });
    return { status: "ok", message: "Your artist profile is live." };
  } catch (error) {
    return toFormState(error);
  }
}
