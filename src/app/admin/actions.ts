"use server";

/**
 * Server Actions for the admin surfaces.
 *
 * Session in, module out. Identity is read from the session on every call and
 * is never a form field: an admin action whose actor came from the request
 * would let one admin file another admin's name against a takedown, and the
 * audit chain would faithfully record the lie.
 */
import { revalidatePath } from "next/cache";
import { currentUserId } from "../_lib/viewer";
import type { FormState } from "../_lib/form-state";
import { moderationDepsForAction } from "./deps";
import {
  reinstateFromForm,
  resolveFromForm,
  suspendFromForm,
  takeDownFromForm,
} from "./queue-forms";

function refresh(): void {
  revalidatePath("/admin/queue");
}

export async function resolveQueueItemAction(
  _prev: FormState,
  form: FormData,
): Promise<FormState> {
  const state = await resolveFromForm(await moderationDepsForAction(), await currentUserId(), form);
  if (state.status === "ok") refresh();
  return state;
}

export async function takeDownArtworkAction(
  _prev: FormState,
  form: FormData,
): Promise<FormState> {
  const state = await takeDownFromForm(await moderationDepsForAction(), await currentUserId(), form);
  if (state.status === "ok") refresh();
  return state;
}

export async function suspendAccountAction(_prev: FormState, form: FormData): Promise<FormState> {
  const state = await suspendFromForm(await moderationDepsForAction(), await currentUserId(), form);
  if (state.status === "ok") refresh();
  return state;
}

export async function reinstateAccountAction(
  _prev: FormState,
  form: FormData,
): Promise<FormState> {
  const state = await reinstateFromForm(
    await moderationDepsForAction(),
    await currentUserId(),
    form,
  );
  if (state.status === "ok") refresh();
  return state;
}
