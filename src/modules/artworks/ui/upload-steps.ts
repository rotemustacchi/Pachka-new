/**
 * The step model behind the artwork creation form.
 *
 * Task 3.3 asks for a multi-step form "covering images, classification,
 * specifications, and declarations". The approved design
 * (design/Upload.dc.html) shows those four as sections of one autosaving page
 * -- "טיוטה · נשמר אוטומטית" -- with a live count on the publish button:
 * "נותרו 2 שדות חובה לפני פרסום".
 *
 * That count is the reason this file exists separately from the component. It
 * has to be the SAME answer the server gives when the artist presses publish,
 * or the button says "ready" and the server says "four fields missing", and the
 * artist has no way to reconcile the two. So the steps are derived from
 * `missingForPublication` -- the exact function the publish path runs -- rather
 * than from a second list of required fields maintained alongside it.
 *
 * Keeping it out of the component also means the interesting behaviour is
 * testable without rendering anything, and that the form can be re-skinned
 * without putting the publish rules at risk.
 */
import {
  missingForPublication,
  type MissingRequirement,
  type PublishCandidate,
} from "../publish-requirements";

export type StepId = "images" | "classification" | "specifications" | "declarations";

export const STEP_ORDER: readonly StepId[] = [
  "images",
  "classification",
  "specifications",
  "declarations",
];

export const STEP_TITLES: Readonly<Record<StepId, string>> = {
  images: "תמונות",
  classification: "סיווג",
  specifications: "מפרט",
  declarations: "הצהרות",
};

/**
 * The specification step's heading, quoted from the design.
 *
 * It says WHY the fields are mandatory rather than just that they are, because
 * the reason is the whole product argument: the MVP has no channel for a buyer
 * to ask the artist a question, so anything a buyer would have asked has to be
 * on the page before the page exists.
 */
export const SPECIFICATIONS_PROMPT = "מפרט — חובה, כי לקונה אין דרך לשאול אתכם";

/** Which step each publish requirement belongs to. */
const FIELD_STEPS: Readonly<Record<string, StepId>> = {
  title: "specifications",
  description: "specifications",
  priceAgorot: "specifications",
  heightMm: "specifications",
  widthMm: "specifications",
  depthMm: "specifications",
  weightGrams: "specifications",
  materials: "specifications",
  isFramed: "specifications",
  leadTimeDays: "specifications",
  productionLeadTimeDays: "specifications",
  madeToOrder: "specifications",

  medium: "classification",
  styles: "classification",
  moods: "classification",
  target_spaces: "classification",

  originality: "declarations",
  aiAssisted: "declarations",
};

export interface UploadFormState {
  readonly candidate: PublishCandidate;
  /** How many images are attached. The pipeline needs at least one to embed. */
  readonly imageCount: number;
}

export interface StepStatus {
  readonly id: StepId;
  readonly title: string;
  /** What this step is still waiting for. */
  readonly missing: readonly MissingRequirement[];
  readonly complete: boolean;
}

/**
 * At least one image.
 *
 * Not in `missingForPublication`, because that function is also the server's
 * publish gate and images live in a different table written by a different
 * module. It is a form-level requirement, stated here so the step model can
 * show it, and enforced at publish time by `uploads` -- upload-pipeline
 * excludes an artwork with no embedding from matchmaker results, and there is
 * no embedding without a primary image.
 */
const NEEDS_AN_IMAGE: MissingRequirement = {
  field: "images",
  message: "יש להעלות לפחות תמונה אחת של היצירה",
};

/**
 * The state of every step.
 *
 * Always all four, in order, complete or not. A step model that hides completed
 * steps stops an artist going back to change the price, which is the single
 * most common thing they will want to do.
 */
export function stepStatuses(state: UploadFormState): readonly StepStatus[] {
  const missing = missingForPublication(state.candidate);

  const byStep = new Map<StepId, MissingRequirement[]>(
    STEP_ORDER.map((id) => [id, [] as MissingRequirement[]]),
  );

  if (state.imageCount === 0) byStep.get("images")?.push(NEEDS_AN_IMAGE);

  for (const requirement of missing) {
    const step = FIELD_STEPS[requirement.field] ?? "specifications";
    byStep.get(step)?.push(requirement);
  }

  return STEP_ORDER.map((id) => {
    const stepMissing = byStep.get(id) ?? [];
    return { id, title: STEP_TITLES[id], missing: stepMissing, complete: stepMissing.length === 0 };
  });
}

/** Everything still missing, across every step, in step order. */
export function allMissing(state: UploadFormState): readonly MissingRequirement[] {
  return stepStatuses(state).flatMap((step) => step.missing);
}

/** The number on the publish button. */
export function remainingCount(state: UploadFormState): number {
  return allMissing(state).length;
}

/**
 * The publish button's caption.
 *
 * Hebrew is inflected, so "נותרו 1 שדות" would be wrong -- and this string sits
 * directly under the artist's cursor at the moment they are most invested in
 * the form, which is the worst place to get grammar wrong.
 */
export function publishButtonCaption(state: UploadFormState): string {
  const remaining = remainingCount(state);
  if (remaining === 0) return "פרסום";
  if (remaining === 1) return "נותר שדה חובה אחד לפני פרסום";
  return `נותרו ${remaining} שדות חובה לפני פרסום`;
}

export function canPublish(state: UploadFormState): boolean {
  return remainingCount(state) === 0;
}

/**
 * The first step that still needs something, or the last step when nothing
 * does.
 *
 * "Where should the form open?" for a returning artist. Landing them on the
 * first incomplete step rather than always on step one is the difference
 * between finishing a draft and re-reading it.
 */
export function firstIncompleteStep(state: UploadFormState): StepId {
  const statuses = stepStatuses(state);
  return (
    statuses.find((step) => !step.complete)?.id ?? (STEP_ORDER[STEP_ORDER.length - 1] as StepId)
  );
}

export function stepAfter(current: StepId): StepId | null {
  const index = STEP_ORDER.indexOf(current);
  return index >= 0 && index < STEP_ORDER.length - 1 ? (STEP_ORDER[index + 1] as StepId) : null;
}

export function stepBefore(current: StepId): StepId | null {
  const index = STEP_ORDER.indexOf(current);
  return index > 0 ? (STEP_ORDER[index - 1] as StepId) : null;
}
