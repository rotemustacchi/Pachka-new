"use client";

/**
 * A multi-line field, in the design system's clothes.
 *
 * `shared/ui` has `Input` and `Select` and no textarea, and three surfaces need
 * one: an artwork description, a moderation resolution note, and a takedown
 * reason. This is deliberately ONE local control rather than three copies of
 * `Input`'s markup, and it reuses `Input`'s exact classes rather than inventing
 * a second look — same border, same focus ring, same error treatment.
 *
 * It lives in `app/_lib` and not in `shared/ui` because `shared/ui` is not this
 * agent's file. If the design system takes a textarea, this should be deleted
 * in favour of it rather than kept alongside.
 */
import { useId, type TextareaHTMLAttributes } from "react";

export interface TextAreaProps extends Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, "id"> {
  readonly label: string;
  readonly error?: string;
  readonly hint?: string;
  readonly id?: string;
}

export function TextArea({ label, error, hint, id, required, className, ...rest }: TextAreaProps) {
  const generatedId = useId();
  const fieldId = id ?? generatedId;
  const hintId = hint ? `${fieldId}-hint` : undefined;
  const errorId = error ? `${fieldId}-error` : undefined;
  const describedBy = [hintId, errorId].filter(Boolean).join(" ") || undefined;

  const classes = [
    "rounded-button border bg-card px-3 py-2 text-base text-ink placeholder:text-ink-muted",
    "focus:outline-none focus:ring-2 focus:ring-ink",
    error ? "border-alert" : "border-rule",
    className,
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={fieldId} className="text-sm font-medium text-ink-soft">
        {label}
        {required ? <span className="text-alert"> *</span> : null}
      </label>
      <textarea
        id={fieldId}
        required={required}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy}
        className={classes}
        {...rest}
      />
      {hint && !error ? (
        <p id={hintId} className="text-xs text-ink-muted">
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={errorId} role="alert" className="text-xs text-alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
