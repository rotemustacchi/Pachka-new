/**
 * The step rail and the publish button for the artwork creation form.
 *
 * design/Upload.dc.html: four sections, an autosave note, and a publish button
 * that says how many required fields are left -- "נותרו 2 שדות חובה לפני פרסום".
 *
 * The count comes from `upload-steps`, which derives it from the same
 * `missingForPublication` the server runs at publish time. That identity is the
 * point: if the button computed its own idea of "required", it would eventually
 * say "ready" while the server said "four fields missing", and an artist would
 * have no way to reconcile the two.
 *
 * Every step stays reachable whether or not it is complete. A stepper that
 * locks completed steps stops an artist going back to change the price, which
 * is the most common thing they will want to do.
 */
"use client";

import { Button } from "@/shared/ui";
import {
  STEP_ORDER,
  publishButtonCaption,
  canPublish,
  stepStatuses,
  type StepId,
  type UploadFormState,
} from "./upload-steps";

export interface UploadStepperProps {
  readonly state: UploadFormState;
  readonly currentStep: StepId;
  readonly onStepChange: (step: StepId) => void;
  readonly onSaveDraft: () => void;
  readonly onPublish: () => void;
  /** True while an autosave is in flight, for the "נשמר אוטומטית" note. */
  readonly saving?: boolean;
  readonly publishing?: boolean;
}

export function UploadStepper({
  state,
  currentStep,
  onStepChange,
  onSaveDraft,
  onPublish,
  saving = false,
  publishing = false,
}: UploadStepperProps) {
  const statuses = stepStatuses(state);
  const ready = canPublish(state);

  return (
    <div className="flex flex-col gap-6">
      <nav aria-label="שלבי היצירה">
        <ol className="flex flex-wrap gap-2">
          {statuses.map((step, index) => {
            const current = step.id === currentStep;
            return (
              <li key={step.id}>
                <button
                  type="button"
                  aria-current={current ? "step" : undefined}
                  onClick={() => onStepChange(step.id)}
                  className={[
                    "flex items-center gap-2 border px-4 py-2 text-sm",
                    current ? "border-ink bg-ink text-paper" : "border-rule bg-card text-ink",
                    "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink",
                  ].join(" ")}
                >
                  <span aria-hidden="true">{index + 1}</span>
                  <span>{step.title}</span>
                  {/* The count is in the accessible name too -- a rail that
                      communicates completeness only through colour tells a
                      screen-reader user nothing. */}
                  <span className="sr-only">
                    {step.complete
                      ? "הושלם"
                      : `${step.missing.length} שדות חובה חסרים`}
                  </span>
                  {step.complete ? <span aria-hidden="true">✓</span> : null}
                </button>
              </li>
            );
          })}
        </ol>
      </nav>

      <p aria-live="polite" className="text-sm text-ink-muted">
        {saving ? "טיוטה · שומר…" : "טיוטה · נשמר אוטומטית"}
      </p>

      <div className="flex flex-wrap items-center gap-3">
        <Button variant="secondary" onClick={onSaveDraft} disabled={saving}>
          שמירה כטיוטה
        </Button>

        {/*
          Not disabled when fields are missing. The caption already says what is
          left, and a disabled button gives an artist nothing to press and no
          error to read -- pressing it takes them to the first step that is
          waiting for something.
        */}
        <Button onClick={onPublish} disabled={publishing}>
          {publishing ? "מפרסם…" : publishButtonCaption(state)}
        </Button>
      </div>

      {!ready ? (
        <p className="text-xs text-ink-muted">
          {`נותרו ${STEP_ORDER.filter((id) => !statuses.find((s) => s.id === id)?.complete).length} שלבים להשלמה`}
        </p>
      ) : null}
    </div>
  );
}
