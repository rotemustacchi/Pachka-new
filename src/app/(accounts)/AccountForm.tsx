"use client";

/**
 * The shared shell for the four account forms.
 *
 * This is the only Client Component in the accounts surface, and it receives
 * exactly two things: a Server Action reference and its own children. No data
 * row is ever a prop to it. That is deliberate — React serialises the entire
 * prop object of a Client Component into the RSC payload embedded in the HTML,
 * whatever the JSX renders (SECURITY.md S1-8), so the way to keep a row out of
 * the HTML is to never hand it to a component like this one.
 */
import { useActionState } from "react";
import { Button } from "@/shared/ui";
import { IDLE, type FormState } from "@/app/_lib/form-state";

export interface AccountFormProps {
  readonly action: (previous: FormState, form: FormData) => Promise<FormState>;
  readonly submitLabel: string;
  readonly children: (state: FormState) => React.ReactNode;
}

/**
 * Renders the banner above the form.
 *
 * Both outcomes get a banner rather than only failures: a successful
 * registration has nothing else to show, since the whole point is that it does
 * not say whether an account was created.
 */
export function FormMessage({ state }: { readonly state: FormState }) {
  if (state.status === "idle" || !state.message) return null;

  const isError = state.status === "error";
  return (
    <p
      role="status"
      aria-live="polite"
      className={[
        "m-0 border-s-4 px-4 py-3 text-[15px]",
        isError ? "border-alert bg-card text-alert" : "border-affirm bg-card text-ink-soft",
      ].join(" ")}
    >
      {state.message}
    </p>
  );
}

export function AccountForm({ action, submitLabel, children }: AccountFormProps) {
  const [state, formAction, pending] = useActionState(action, IDLE);

  return (
    <form action={formAction} className="flex w-full max-w-[420px] flex-col gap-5">
      <FormMessage state={state} />
      {children(state)}
      <Button type="submit" disabled={pending}>
        {pending ? "רגע…" : submitLabel}
      </Button>
    </form>
  );
}
