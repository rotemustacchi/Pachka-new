"use server";

/**
 * The rate-table editor's Server Action. Session in, module out.
 */
import { revalidatePath } from "next/cache";
import { getDatabase } from "@/shared/db";
import { currentUserId } from "../../_lib/viewer";
import type { FormState } from "../../_lib/form-state";
import { setRateFromForm } from "./rate-forms";

export async function setRateAction(_prev: FormState, form: FormData): Promise<FormState> {
  const state = await setRateFromForm(getDatabase(), await currentUserId(), form);
  if (state.status === "ok") revalidatePath("/admin/shipping");
  return state;
}
