/**
 * The questionnaire, as a form.
 *
 * art-matchmaker: at most seven questions, every one optional except budget,
 * and submittable without an account.
 *
 * NO `"use client"`, HERE OR BELOW
 * -------------------------------
 * A Server Component, like every view in `catalog`, for the reason SECURITY.md
 * S1-8 gives: a Client Component's props are serialized into the RSC flight
 * payload and land in the HTML, where anyone can read them. Nothing on this
 * page needs that risk — the form posts, the server answers.
 *
 * It also means the questionnaire works with JavaScript disabled, which is not
 * a nicety on a page whose whole purpose is to be the first thing an
 * uncommitted visitor tries.
 *
 * THE BUDGET FIELD IS `required`, AND THAT IS NOT THE VALIDATION
 * -------------------------------------------------------------
 * `required` here saves a round trip for a buyer who forgot. The actual rule is
 * `parseAnswers`, on the server, because an attribute in the DOM is a
 * suggestion to a browser and nothing more — "Budget omitted -> the system
 * blocks submission and explains that budget is required" has to be true of a
 * hand-rolled POST too.
 */
import {
  MEDIA,
  MEDIUM_LABELS,
  MOODS,
  MOOD_LABELS,
  STYLES,
  STYLE_LABELS,
  TARGET_SPACES,
  TARGET_SPACE_LABELS,
} from "@/modules/artworks";
import { PALETTES, PALETTE_LABELS, QUESTION_LABELS } from "../questionnaire";

export interface QuestionnaireFormProps {
  /** Where the answers go. A Server Action or a route, supplied by `src/app`. */
  readonly action: string;
  /** Field-level messages from a rejected submission, keyed as `parseAnswers` keys them. */
  readonly fieldErrors?: Readonly<Record<string, readonly string[]>>;
  /**
   * What the buyer answered last time, keyed as the form names them.
   *
   * Revising used to mean re-answering from scratch, which is the worst place
   * to lose someone: they revise precisely when the matches missed, and being
   * handed a blank form is a reason to give up rather than adjust. Multi-value
   * axes arrive as arrays because a checkbox group posts one name many times.
   */
  readonly initial?: Readonly<Record<string, string | readonly string[] | undefined>>;
}

/** Whether `value` was among the previous answers for `name`. */
function wasChosen(
  initial: QuestionnaireFormProps["initial"],
  name: string,
  value: string,
): boolean {
  const answered = initial?.[name];
  if (answered === undefined) return false;
  return Array.isArray(answered) ? answered.includes(value) : answered === value;
}

/** The previous single-valued answer for `name`, for a text or number input. */
function previous(initial: QuestionnaireFormProps["initial"], name: string): string | undefined {
  const answered = initial?.[name];
  return Array.isArray(answered) ? answered[0] : (answered as string | undefined);
}

function FieldError({ messages }: { readonly messages: readonly string[] | undefined }) {
  if (messages === undefined || messages.length === 0) return null;
  return (
    <p role="alert" className="mt-2 text-[13px] font-bold text-ink">
      {messages.join(" ")}
    </p>
  );
}

function CheckboxGroup({
  name,
  legend,
  options,
  errors,
  initial,
}: {
  readonly name: string;
  readonly legend: string;
  readonly options: readonly (readonly [string, string])[];
  /**
   * `parseAnswers` returns field errors for these axes too, not only for the
   * budget and the dimensions. Without somewhere to put them they surfaced
   * only in the top-level banner — and in English, since the module's messages
   * for a value outside a closed set are written for a developer.
   */
  readonly errors?: readonly string[] | undefined;
  readonly initial?: QuestionnaireFormProps["initial"];
}) {
  return (
    <fieldset className="border-0 p-0">
      <legend className="mb-3 text-[17px] font-black text-ink">{legend}</legend>
      <div className="flex flex-wrap gap-2">
        {options.map(([value, label]) => (
          <label
            key={value}
            className="inline-flex cursor-pointer items-center gap-2 rounded-button border border-rule px-4 py-2 text-[14px] font-light text-ink-soft hover:border-ink"
          >
            <input
              type="checkbox"
              name={name}
              value={value}
              defaultChecked={wasChosen(initial, name, value)}
              className="accent-ink"
            />
            {label}
          </label>
        ))}
      </div>
      <FieldError messages={errors} />
    </fieldset>
  );
}

function RadioGroup({
  name,
  legend,
  options,
  errors,
  initial,
}: {
  readonly name: string;
  readonly legend: string;
  readonly options: readonly (readonly [string, string])[];
  /**
   * `parseAnswers` returns field errors for these axes too, not only for the
   * budget and the dimensions. Without somewhere to put them they surfaced
   * only in the top-level banner — and in English, since the module's messages
   * for a value outside a closed set are written for a developer.
   */
  readonly errors?: readonly string[] | undefined;
  readonly initial?: QuestionnaireFormProps["initial"];
}) {
  return (
    <fieldset className="border-0 p-0">
      <legend className="mb-3 text-[17px] font-black text-ink">{legend}</legend>
      <div className="flex flex-wrap gap-2">
        {options.map(([value, label]) => (
          <label
            key={value}
            className="inline-flex cursor-pointer items-center gap-2 rounded-button border border-rule px-4 py-2 text-[14px] font-light text-ink-soft hover:border-ink"
          >
            <input
              type="radio"
              name={name}
              value={value}
              defaultChecked={wasChosen(initial, name, value)}
              className="accent-ink"
            />
            {label}
          </label>
        ))}
      </div>
      <FieldError messages={errors} />
    </fieldset>
  );
}

const entries = <K extends string>(
  values: readonly K[],
  labels: Readonly<Record<K, string>>,
): readonly (readonly [string, string])[] => values.map((value) => [value, labels[value]] as const);

export function QuestionnaireForm({ action, fieldErrors, initial }: QuestionnaireFormProps) {
  return (
    <form action={action} method="post" className="flex flex-col gap-10">
      <RadioGroup
        name="medium"
        legend={QUESTION_LABELS.medium}
        options={entries(MEDIA, MEDIUM_LABELS)}
        errors={fieldErrors?.medium}
        initial={initial}
      />
      <CheckboxGroup
        name="styles"
        legend={QUESTION_LABELS.styles}
        options={entries(STYLES, STYLE_LABELS)}
        errors={fieldErrors?.styles}
        initial={initial}
      />
      <RadioGroup
        name="palette"
        legend={QUESTION_LABELS.palette}
        options={entries(PALETTES, PALETTE_LABELS)}
        errors={fieldErrors?.palette}
        initial={initial}
      />
      <CheckboxGroup
        name="targetSpaces"
        errors={fieldErrors?.targetSpaces}
        initial={initial}
        legend={QUESTION_LABELS.targetSpace}
        options={entries(TARGET_SPACES, TARGET_SPACE_LABELS)}
      />
      <CheckboxGroup
        name="moods"
        legend={QUESTION_LABELS.mood}
        options={entries(MOODS, MOOD_LABELS)}
        errors={fieldErrors?.moods}
        initial={initial}
      />

      <fieldset className="border-0 p-0">
        <legend className="mb-3 text-[17px] font-black text-ink">
          {QUESTION_LABELS.budget}
          {/* The one question that is not optional, said in the label rather
              than only enforced on submit. */}
          <span className="ms-2 text-[13px] font-bold text-ink-soft">(חובה)</span>
        </legend>
        <div className="flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-2 text-[14px] font-light text-ink-soft">
            מ־
            <input
              type="number"
              name="budgetMin"
              defaultValue={previous(initial, "budgetMin")}
              min={0}
              step={10}
              inputMode="numeric"
              className="w-32 border border-rule bg-card px-3 py-2 text-ink"
            />
          </label>
          <label className="flex items-center gap-2 text-[14px] font-light text-ink-soft">
            עד
            <input
              type="number"
              name="budgetMax"
              defaultValue={previous(initial, "budgetMax")}
              min={1}
              step={10}
              required
              inputMode="numeric"
              className="w-32 border border-rule bg-card px-3 py-2 text-ink"
            />
          </label>
          <span className="text-[14px] font-light text-ink-soft">₪</span>
        </div>
        <FieldError messages={fieldErrors?.budgetMax} />
        <FieldError messages={fieldErrors?.budgetMin} />
      </fieldset>

      <fieldset className="border-0 p-0">
        <legend className="mb-3 text-[17px] font-black text-ink">{QUESTION_LABELS.dimensions}</legend>
        <div className="flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-2 text-[14px] font-light text-ink-soft">
            גובה
            <input
              type="number"
              name="wallHeight"
              defaultValue={previous(initial, "wallHeight")}
              min={1}
              step={1}
              inputMode="numeric"
              className="w-28 border border-rule bg-card px-3 py-2 text-ink"
            />
          </label>
          <label className="flex items-center gap-2 text-[14px] font-light text-ink-soft">
            רוחב
            <input
              type="number"
              name="wallWidth"
              defaultValue={previous(initial, "wallWidth")}
              min={1}
              step={1}
              inputMode="numeric"
              className="w-28 border border-rule bg-card px-3 py-2 text-ink"
            />
          </label>
          <span className="text-[14px] font-light text-ink-soft">ס״מ</span>
        </div>
        <FieldError messages={fieldErrors?.wallHeight} />
        <FieldError messages={fieldErrors?.wallWidth} />
      </fieldset>

      <button
        type="submit"
        className="inline-flex items-center justify-center self-start rounded-button bg-ink px-10 py-4 text-base font-bold text-paper hover:bg-ink-soft"
      >
        מצאו לי יצירה
      </button>
    </form>
  );
}
