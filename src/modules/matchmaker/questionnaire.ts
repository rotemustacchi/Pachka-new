/**
 * The questionnaire: seven questions, one of them required.
 *
 * art-matchmaker, "Buyer questionnaire": "at most seven questions covering
 * preferred styles, colour palette, target space, mood, budget range in ILS,
 * and available wall or surface dimensions. Every question except budget SHALL
 * be optional, and the buyer SHALL be able to submit the questionnaire without
 * an account."
 *
 * Seven, counting medium: the six the spec enumerates plus "what kind of thing
 * are you looking for", which is the one axis of `artworks`' closed taxonomy the
 * spec's list does not name and the one a buyer answers first in every furniture
 * shop they have ever used. Dimensions are one question with two fields, which
 * is how the design draws it.
 *
 * EVERY ANSWER IS PARSED AGAINST A CLOSED SET BEFORE IT REACHES SCORING
 * --------------------------------------------------------------------
 * SECURITY.md S2-22 item 5: "The questionnaire body is size-capped and every
 * answer validated against the closed taxonomy set before it reaches the
 * scoring function." Both halves are here, and the order matters -- the size
 * cap is checked against the raw body before anything is parsed, so a 10 MB
 * submission costs a length check rather than a JSON parse.
 *
 * The taxonomy comes from `artworks`, which owns it and closes it. Restating
 * the values here would let the two drift, and an answer nobody's artwork can
 * match is a question that always scores zero.
 */
import {
  isMedium,
  isMood,
  isStyle,
  isTargetSpace,
  type Medium,
  type Mood,
  type Style,
  type TargetSpace,
} from "@/modules/artworks";
import { AppError } from "@/shared/errors";

/**
 * The palette question's closed set.
 *
 * Owned here rather than by `artworks`, because `artworks` has no colour
 * column: the artist's chosen palette lives in `uploads`' event log. See
 * `palette.ts` for what that means for scoring, which is not nothing.
 */
export const PALETTES = ["warm", "cool", "neutral", "earthy", "monochrome", "vivid"] as const;
export type Palette = (typeof PALETTES)[number];

export const PALETTE_LABELS: Readonly<Record<Palette, string>> = {
  warm: "חמים",
  cool: "קריר",
  neutral: "ניטרלי",
  earthy: "אדמתי",
  monochrome: "מונוכרום",
  vivid: "עז",
};

export const isPalette = (value: unknown): value is Palette =>
  typeof value === "string" && (PALETTES as readonly string[]).includes(value);

/** The seven questions, in the order they are asked. */
export const QUESTION_IDS = [
  "medium",
  "styles",
  "palette",
  "targetSpace",
  "mood",
  "budget",
  "dimensions",
] as const;
export type QuestionId = (typeof QUESTION_IDS)[number];

export const QUESTION_LABELS: Readonly<Record<QuestionId, string>> = {
  medium: "מה מחפשים?",
  styles: "אילו סגנונות מדברים אליכם?",
  palette: "איזו פלטת צבעים מתאימה לחלל?",
  targetSpace: "לאיזה חלל בבית?",
  mood: "איזה וייב אתם מחפשים?",
  budget: "מה טווח התקציב?",
  dimensions: "כמה מקום פנוי יש על הקיר או המשטח?",
};

/**
 * A validated set of answers.
 *
 * Money in agorot in a whole number, per ARCHITECTURE.md. The buyer types
 * shekels; `parseAnswers` is where they stop being shekels.
 */
export interface Answers {
  readonly medium: Medium | null;
  readonly styles: readonly Style[];
  readonly palette: Palette | null;
  readonly targetSpaces: readonly TargetSpace[];
  readonly moods: readonly Mood[];
  /** Optional floor. A buyer who states only a ceiling has stated a budget. */
  readonly budgetMinAgorot: number | null;
  /** Required. The one answer without which there is no questionnaire. */
  readonly budgetMaxAgorot: number;
  readonly wallHeightMm: number | null;
  readonly wallWidthMm: number | null;
}

/** What arrives from a form or a request body. Every field is `unknown`. */
export type RawAnswers = Readonly<Record<string, unknown>>;

const MAX_SELECTIONS = 5;
const MAX_BUDGET_AGOROT = 100_000_000; // ₪1,000,000 — a sanity ceiling, not a rule.
const MAX_WALL_MM = 100_000;

/**
 * The size cap, checked against the raw body before it is parsed.
 *
 * SECURITY.md S2-22: "Post a questionnaire with a 10 MB body... Assert both are
 * rejected before any database scoring query runs." A cap applied after
 * `JSON.parse` has already paid for the parse.
 */
export function assertWithinAnswerSizeLimit(body: string, maxBytes: number): void {
  const bytes = Buffer.byteLength(body, "utf8");
  if (bytes > maxBytes) {
    throw AppError.validation(
      `The questionnaire submission is ${bytes} bytes; the limit is ${maxBytes}.`,
      { code: "matchmaker.answers_too_large", details: { bytes, maxBytes } },
    );
  }
}

function parseOptionalList<T>(
  field: string,
  value: unknown,
  guard: (candidate: unknown) => candidate is T,
): readonly T[] {
  if (value === undefined || value === null) return [];
  const values = Array.isArray(value) ? value : [value];
  if (values.length > MAX_SELECTIONS) {
    throw AppError.validation(`Too many selections for ${field}.`, {
      code: "matchmaker.answer_outside_set",
      details: { field, count: values.length, max: MAX_SELECTIONS },
      fields: { [field]: ["נבחרו יותר מדי אפשרויות"] },
    });
  }
  const parsed: T[] = [];
  for (const candidate of values) {
    if (!guard(candidate)) {
      // Rejected, not dropped. A dropped answer produces a ranking the buyer
      // did not ask for with nothing telling them so, and `artworks` makes the
      // same call for the artist's own submission.
      throw AppError.validation(`"${String(candidate)}" is not a permitted ${field} answer.`, {
        code: "matchmaker.answer_outside_set",
        details: { field, value: null },
        fields: { [field]: ["ערך לא מוכר"] },
      });
    }
    if (!parsed.includes(candidate)) parsed.push(candidate);
  }
  return parsed;
}

function parseOptionalOne<T>(
  field: string,
  value: unknown,
  guard: (candidate: unknown) => candidate is T,
): T | null {
  if (value === undefined || value === null || value === "") return null;
  if (!guard(value)) {
    throw AppError.validation(`"${String(value)}" is not a permitted ${field} answer.`, {
      code: "matchmaker.answer_outside_set",
      details: { field, value: null },
      fields: { [field]: ["ערך לא מוכר"] },
    });
  }
  return value;
}

/**
 * Shekels in, agorot out.
 *
 * SECURITY.md S2-27: a price arriving as a float is how money gets corrupted.
 * A budget is not a price -- nothing is charged against it -- but it is
 * compared against one, so it becomes an exact integer count of agorot at the
 * boundary and stays one.
 */
function parseShekels(field: string, value: unknown, required: boolean): number | null {
  if (value === undefined || value === null || value === "") {
    if (!required) return null;
    throw AppError.validation("A budget is required to see matches.", {
      code: "matchmaker.budget_required",
      details: { field },
      fields: { [field]: ["יש להזין תקציב"] },
    });
  }

  const shekels = typeof value === "number" ? value : Number(String(value).trim());
  if (!Number.isFinite(shekels) || shekels < 0) {
    throw AppError.validation(`${field} must be a positive amount in shekels.`, {
      code: "matchmaker.budget_invalid",
      details: { field },
      fields: { [field]: ["סכום לא תקין"] },
    });
  }

  const agorot = Math.round(shekels * 100);
  if (agorot > MAX_BUDGET_AGOROT) {
    throw AppError.validation(`${field} is above the maximum this form accepts.`, {
      code: "matchmaker.budget_invalid",
      details: { field },
      fields: { [field]: ["סכום גבוה מדי"] },
    });
  }
  return agorot;
}

function parseCentimetres(field: string, value: unknown): number | null {
  if (value === undefined || value === null || value === "") return null;
  const centimetres = typeof value === "number" ? value : Number(String(value).trim());
  if (!Number.isFinite(centimetres) || centimetres <= 0) {
    throw AppError.validation(`${field} must be a positive measurement in centimetres.`, {
      code: "matchmaker.dimension_invalid",
      details: { field },
      fields: { [field]: ["מידה לא תקינה"] },
    });
  }
  const millimetres = Math.round(centimetres * 10);
  if (millimetres > MAX_WALL_MM) {
    throw AppError.validation(`${field} is larger than this form accepts.`, {
      code: "matchmaker.dimension_invalid",
      details: { field },
      fields: { [field]: ["מידה גדולה מדי"] },
    });
  }
  return millimetres;
}

/**
 * Parse a submission. Throws a `validation` error naming the field.
 *
 * The budget check is the spec's "Budget omitted" scenario: submission is
 * blocked and the reason is that budget is required, in a field message the
 * form can render next to the field rather than as a banner.
 */
export function parseAnswers(raw: RawAnswers): Answers {
  const budgetMaxAgorot = parseShekels("budgetMax", raw.budgetMax, true);
  const budgetMinAgorot = parseShekels("budgetMin", raw.budgetMin, false);

  if (budgetMaxAgorot === null || budgetMaxAgorot <= 0) {
    throw AppError.validation("A budget is required to see matches.", {
      code: "matchmaker.budget_required",
      fields: { budgetMax: ["יש להזין תקציב"] },
    });
  }

  if (budgetMinAgorot !== null && budgetMinAgorot > budgetMaxAgorot) {
    throw AppError.validation("The budget floor is above the budget ceiling.", {
      code: "matchmaker.budget_invalid",
      fields: { budgetMin: ["הסכום המינימלי גבוה מהמקסימלי"] },
    });
  }

  return {
    medium: parseOptionalOne("medium", raw.medium, isMedium),
    styles: parseOptionalList("styles", raw.styles, isStyle),
    palette: parseOptionalOne("palette", raw.palette, isPalette),
    targetSpaces: parseOptionalList("targetSpaces", raw.targetSpaces, isTargetSpace),
    moods: parseOptionalList("moods", raw.moods, isMood),
    budgetMinAgorot,
    budgetMaxAgorot,
    wallHeightMm: parseCentimetres("wallHeight", raw.wallHeight),
    wallWidthMm: parseCentimetres("wallWidth", raw.wallWidth),
  };
}

/** Whether the buyer answered anything on the taxonomy axes. */
export function hasTaxonomyAnswers(answers: Answers): boolean {
  return (
    answers.medium !== null ||
    answers.styles.length > 0 ||
    answers.targetSpaces.length > 0 ||
    answers.moods.length > 0
  );
}

/** Whether the buyer gave a space to fit the work into. Both halves or neither. */
export function hasDimensions(answers: Answers): boolean {
  return answers.wallHeightMm !== null && answers.wallWidthMm !== null;
}
