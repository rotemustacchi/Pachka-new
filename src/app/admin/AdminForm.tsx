"use client";

/**
 * The shell every admin form shares: a submit button and the banner that says
 * what happened.
 *
 * It takes an action and its children and no data row, for the reason
 * `(accounts)/AccountForm.tsx` states — React serialises a Client Component's
 * whole prop object into the payload embedded in the HTML (SECURITY.md S1-8),
 * so the way to keep a report or an artist's row out of the page is to never
 * hand it to a component like this one. The ids these forms post arrive as
 * plain strings from the URL the admin is already on.
 */
import { useActionState, type ReactNode } from "react";
import { Button } from "@/shared/ui";
import { IDLE, type FormState } from "../_lib/form-state";

export interface AdminFormProps {
  readonly action: (previous: FormState, form: FormData) => Promise<FormState>;
  readonly submitLabel: string;
  readonly title: string;
  readonly description?: string;
  readonly children: (state: FormState) => ReactNode;
}

export function AdminForm({
  action,
  submitLabel,
  title,
  description,
  children,
}: AdminFormProps) {
  const [state, formAction, pending] = useActionState(action, IDLE);

  return (
    <form action={formAction} className="flex flex-col gap-4 border border-rule bg-card p-5">
      <div>
        <h3 className="m-0 text-base font-bold">{title}</h3>
        {description ? <p className="m-0 mt-1 text-[13px] text-ink-muted">{description}</p> : null}
      </div>

      {state.status !== "idle" && state.message ? (
        <p
          role="status"
          aria-live="polite"
          className={[
            "m-0 border-s-4 px-3 py-2 text-[14px]",
            state.status === "error"
              ? "border-alert bg-paper text-alert"
              : "border-affirm bg-paper text-ink-soft",
          ].join(" ")}
        >
          {state.message}
        </p>
      ) : null}

      {children(state)}

      <div>
        <Button type="submit" disabled={pending}>
          {pending ? "רגע…" : submitLabel}
        </Button>
      </div>
    </form>
  );
}
