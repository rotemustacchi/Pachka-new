"use client";

/**
 * The artwork upload form (task 3.3's tail).
 *
 * The module built the whole of this and nothing mounted it: `upload-steps`
 * holds the step model and the publish count, `TaxonomyPicker` renders the
 * closed set, `DeclarationsStep` asks the two questions, and `UploadStepper`
 * draws the rail and the publish button. This file is the host — state, layout,
 * and one form submission. It re-derives nothing.
 *
 * THE SUBMITTED PAYLOAD IS THE STATE, NOT THE VISIBLE CONTROLS.
 * One step is on screen at a time, so a form whose controls carried the `name`
 * attributes would post only the step the artist happened to be looking at, and
 * "save draft" from the declarations step would clear the specifications. Every
 * value is therefore posted by the hidden block at the bottom, which is
 * rendered from state whatever is visible. The visible controls are unnamed and
 * drive that state.
 *
 * WHY THE COUNT ON THE BUTTON IS NOT COMPUTED HERE.
 * `stepStatuses` derives it from `missingForPublication` — the exact function
 * the server runs at publish time. A second idea of "required" living in this
 * file would eventually say "ready" while the server said "four fields
 * missing", and the artist would have no way to reconcile the two.
 */
import { useActionState, useRef, useState } from "react";
import { Card, Input, Select } from "@/shared/ui";
import {
  AXIS_LABELS,
  DeclarationsStep,
  MEDIA,
  MEDIUM_LABELS,
  MOODS,
  MOOD_LABELS,
  SPECIFICATIONS_PROMPT,
  STEP_TITLES,
  STYLES,
  STYLE_LABELS,
  TARGET_SPACES,
  TARGET_SPACE_LABELS,
  TaxonomyPicker,
  UploadStepper,
  firstIncompleteStep,
  mediumRequiresDepth,
  mediumRequiresFraming,
  type ListingLimits,
  type Medium,
  type StepId,
  type UploadFormState,
} from "@/modules/artworks";
import { IDLE, type FormState } from "../../../_lib/form-state";
import { TextArea } from "../../../_lib/TextArea";
import { submitArtworkAction } from "../../actions";
import { ImageStep, type AttachedImage } from "./ImageStep";
import { toCandidate, type UploadFormValues } from "./values";

export interface UploadFormProps {
  readonly artworkId: string;
  readonly initialValues: UploadFormValues;
  readonly images: readonly AttachedImage[];
  readonly limits: ListingLimits;
  /** `removed` and `sold` are read-only; the module refuses the write anyway. */
  readonly editable: boolean;
  readonly statusLabel: string;
}

function options(values: readonly string[], labels: Readonly<Record<string, string>>) {
  return values.map((value) => ({ value, label: labels[value] ?? value }));
}

export function UploadForm({
  artworkId,
  initialValues,
  images,
  limits,
  editable,
  statusLabel,
}: UploadFormProps) {
  const [values, setValues] = useState<UploadFormValues>(initialValues);
  const [state, formAction, pending] = useActionState(submitArtworkAction, IDLE);

  const candidate = toCandidate(values);
  const formState: UploadFormState = { candidate, imageCount: images.length };

  const [step, setStep] = useState<StepId>(() => firstIncompleteStep(formState));

  const formRef = useRef<HTMLFormElement>(null);
  const intentRef = useRef<HTMLInputElement>(null);

  // The intent is written to the DOM rather than to state, because state set in
  // a click handler is not in the DOM by the time `requestSubmit` reads it.
  const submitWith = (intent: "save" | "publish"): void => {
    if (intentRef.current) intentRef.current.value = intent;
    formRef.current?.requestSubmit();
  };

  const set = <K extends keyof UploadFormValues>(key: K, value: UploadFormValues[K]): void =>
    setValues((previous) => ({ ...previous, [key]: value }));

  const errorFor = (field: string): string | undefined => state.fields?.[field]?.[0];

  const medium = values.medium === "" ? null : (values.medium as Medium);
  const needsDepth = medium !== null && mediumRequiresDepth(medium);
  const needsFraming = medium !== null && mediumRequiresFraming(medium);

  return (
    <form ref={formRef} action={formAction} className="flex flex-col gap-8">
      <Banner state={state} />

      <UploadStepper
        state={formState}
        currentStep={step}
        onStepChange={setStep}
        onSaveDraft={() => submitWith("save")}
        onPublish={() => submitWith("publish")}
        saving={pending}
        publishing={pending}
      />

      <Card className="flex flex-col gap-6 p-6">
        <h2 className="m-0 text-xl font-bold">{STEP_TITLES[step]}</h2>

        {step === "images" ? <ImageStep artworkId={artworkId} images={images} /> : null}

        {step === "classification" ? (
          <div className="flex flex-col gap-7">
            <TaxonomyPicker
              axis="medium"
              legend={AXIS_LABELS.medium}
              options={options([...MEDIA], MEDIUM_LABELS)}
              selected={values.medium === "" ? [] : [values.medium]}
              onChange={(chosen) => set("medium", chosen[0] ?? "")}
              error={errorFor("medium")}
            />
            <TaxonomyPicker
              axis="styles"
              legend={AXIS_LABELS.styles}
              options={options([...STYLES], STYLE_LABELS)}
              selected={values.styles}
              max={limits.maxStyles}
              onChange={(chosen) => set("styles", chosen)}
              error={errorFor("styles")}
            />
            <TaxonomyPicker
              axis="target_spaces"
              legend={AXIS_LABELS.target_spaces}
              options={options([...TARGET_SPACES], TARGET_SPACE_LABELS)}
              selected={values.targetSpaces}
              max={limits.maxTargetSpaces}
              onChange={(chosen) => set("targetSpaces", chosen)}
              error={errorFor("target_spaces")}
            />
            <TaxonomyPicker
              axis="moods"
              legend={AXIS_LABELS.moods}
              options={options([...MOODS], MOOD_LABELS)}
              selected={values.moods}
              max={limits.maxMoods}
              onChange={(chosen) => set("moods", chosen)}
              error={errorFor("moods")}
            />
          </div>
        ) : null}

        {step === "specifications" ? (
          <div className="flex flex-col gap-5">
            <p className="text-[15px] text-ink-soft">{SPECIFICATIONS_PROMPT}</p>

            <Input
              label="שם היצירה"
              value={values.title}
              onChange={(event) => set("title", event.target.value)}
              error={errorFor("title")}
            />

            <TextArea
              label="תיאור"
              rows={5}
              maxLength={limits.maxDescriptionLength}
              value={values.description}
              onChange={(event) => set("description", event.target.value)}
              error={errorFor("description")}
            />

            <div className="grid gap-4 sm:grid-cols-3">
              <Input
                label="גובה (ס״מ)"
                inputMode="decimal"
                value={values.heightCm}
                onChange={(event) => set("heightCm", event.target.value)}
                error={errorFor("heightMm")}
              />
              <Input
                label="רוחב (ס״מ)"
                inputMode="decimal"
                value={values.widthCm}
                onChange={(event) => set("widthCm", event.target.value)}
                error={errorFor("widthMm")}
              />
              <Input
                label="עומק (ס״מ)"
                inputMode="decimal"
                value={values.depthCm}
                onChange={(event) => set("depthCm", event.target.value)}
                hint={needsDepth ? "חובה למדיום תלת-ממדי" : undefined}
                error={errorFor("depthMm")}
              />
            </div>

            <div className="grid gap-4 sm:grid-cols-3">
              <Input
                label="משקל (גרם)"
                inputMode="numeric"
                value={values.weightGrams}
                onChange={(event) => set("weightGrams", event.target.value)}
                error={errorFor("weightGrams")}
              />
              <Input
                label="מחיר (₪)"
                inputMode="decimal"
                value={values.priceShekels}
                onChange={(event) => set("priceShekels", event.target.value)}
                error={errorFor("priceAgorot")}
              />
              <Input
                label="ימי אספקה"
                inputMode="numeric"
                value={values.leadTimeDays}
                onChange={(event) => set("leadTimeDays", event.target.value)}
                error={errorFor("leadTimeDays")}
              />
            </div>

            <Input
              label="חומרים"
              value={values.materials}
              onChange={(event) => set("materials", event.target.value)}
              error={errorFor("materials")}
            />

            <div className="grid gap-4 sm:grid-cols-3">
              <Input
                label="שנת יצירה"
                inputMode="numeric"
                value={values.yearCreated}
                onChange={(event) => set("yearCreated", event.target.value)}
                error={errorFor("yearCreated")}
              />
              {needsFraming ? (
                <Select
                  label="מסגור"
                  value={values.isFramed}
                  onChange={(event) =>
                    set("isFramed", event.target.value as UploadFormValues["isFramed"])
                  }
                  options={[
                    { value: "", label: "טרם נבחר" },
                    { value: "yes", label: "ממוסגרת" },
                    { value: "no", label: "מוכנה לתלייה, ללא מסגרת" },
                  ]}
                  error={errorFor("isFramed")}
                />
              ) : null}
              <Select
                label="סוג מלאי"
                value={values.inventoryType}
                onChange={(event) =>
                  set("inventoryType", event.target.value as UploadFormValues["inventoryType"])
                }
                options={[
                  { value: "unique", label: "יצירה יחידה" },
                  { value: "edition", label: "מהדורה" },
                ]}
              />
            </div>

            {values.inventoryType === "edition" ? (
              <div className="grid gap-4 sm:grid-cols-3">
                <Input
                  label="גודל המהדורה"
                  inputMode="numeric"
                  value={values.stock}
                  onChange={(event) => set("stock", event.target.value)}
                  hint={`עד ${limits.maxEditionSize}`}
                  error={errorFor("stock")}
                />
                <label className="flex items-center gap-2 self-end pb-2 text-[15px]">
                  <input
                    type="checkbox"
                    checked={values.madeToOrder}
                    onChange={(event) => set("madeToOrder", event.target.checked)}
                  />
                  <span>יצירה בהזמנה</span>
                </label>
                {values.madeToOrder ? (
                  <Input
                    label="ימי ייצור"
                    inputMode="numeric"
                    value={values.productionLeadTimeDays}
                    onChange={(event) => set("productionLeadTimeDays", event.target.value)}
                    error={errorFor("productionLeadTimeDays")}
                  />
                ) : null}
              </div>
            ) : null}
          </div>
        ) : null}

        {step === "declarations" ? (
          <DeclarationsStep
            affirmsOriginality={values.affirmsOriginality}
            onOriginalityChange={(affirmed) => set("affirmsOriginality", affirmed)}
            aiAssisted={values.aiAssisted}
            onAiAssistedChange={(answer) => set("aiAssisted", answer)}
            errors={{
              ...(errorFor("originality") ? { originality: errorFor("originality") as string } : {}),
              ...(errorFor("aiAssisted") ? { aiAssisted: errorFor("aiAssisted") as string } : {}),
            }}
          />
        ) : null}
      </Card>

      {!editable ? (
        <p className="border-s-4 border-alert bg-card px-4 py-3 text-[15px] text-alert">
          {`היצירה במצב "${statusLabel}" ואינה ניתנת לעריכה.`}
        </p>
      ) : null}

      {/*
        The submitted payload. Rendered from state, so it carries every step
        whether or not that step is on screen — see the header. The `.present`
        markers are what tell the parser that an axis was submitted and is
        genuinely empty, as opposed to not submitted at all.
      */}
      <div hidden>
        <input type="hidden" name="artworkId" value={artworkId} />
        <input type="hidden" name="intent" ref={intentRef} defaultValue="save" />

        <input type="hidden" name="title" value={values.title} />
        <input type="hidden" name="description" value={values.description} />
        <input type="hidden" name="priceShekels" value={values.priceShekels} />
        <input type="hidden" name="heightCm" value={values.heightCm} />
        <input type="hidden" name="widthCm" value={values.widthCm} />
        <input type="hidden" name="depthCm" value={values.depthCm} />
        <input type="hidden" name="weightGrams" value={values.weightGrams} />
        <input type="hidden" name="materials" value={values.materials} />
        <input type="hidden" name="leadTimeDays" value={values.leadTimeDays} />
        <input type="hidden" name="yearCreated" value={values.yearCreated} />
        <input type="hidden" name="isFramed" value={values.isFramed} />

        <input type="hidden" name="medium" value={values.medium} />
        <input type="hidden" name="styles.present" value="1" />
        {values.styles.map((value) => (
          <input key={value} type="hidden" name="styles" value={value} />
        ))}
        <input type="hidden" name="targetSpaces.present" value="1" />
        {values.targetSpaces.map((value) => (
          <input key={value} type="hidden" name="targetSpaces" value={value} />
        ))}
        <input type="hidden" name="moods.present" value="1" />
        {values.moods.map((value) => (
          <input key={value} type="hidden" name="moods" value={value} />
        ))}

        <input type="hidden" name="inventoryType" value={values.inventoryType} />
        <input type="hidden" name="stock" value={values.stock} />
        <input type="hidden" name="madeToOrder" value={values.madeToOrder ? "yes" : "no"} />
        <input
          type="hidden"
          name="productionLeadTimeDays"
          value={values.productionLeadTimeDays}
        />

        <input
          type="hidden"
          name="affirmsOriginality"
          value={values.affirmsOriginality ? "yes" : "no"}
        />
        {/* Omitted entirely while unanswered: absent means "leave it alone",
            and there is no way back to unanswered once it has been answered. */}
        {values.aiAssisted === null ? null : (
          <input type="hidden" name="aiAssisted" value={values.aiAssisted ? "yes" : "no"} />
        )}
      </div>
    </form>
  );
}

function Banner({ state }: { readonly state: FormState }) {
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
