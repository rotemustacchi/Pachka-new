/**
 * What an artwork must have before it can be published.
 *
 * artwork-listings, "Mandatory specification fields": the MVP gives a buyer no
 * channel to ask the artist a question, so everything a buyer would otherwise
 * have asked has to be on the page before the page exists. That is the whole
 * argument for this file, and it is why the list is long.
 *
 * "LISTS EVERY MISSING FIELD"
 * ---------------------------
 * The spec's scenario is explicit: publication is blocked and the system "lists
 * every missing field". Not the first one. An artist who fixes the dimensions,
 * resubmits, is told about the weight, fixes that, resubmits, and is told about
 * the lead time has been made to do three round trips to learn one thing, and
 * the design (design/Upload.dc.html) puts a live count on the button --
 * "נותרו 2 שדות חובה לפני פרסום" -- which is only possible if this is a
 * complete survey rather than a short-circuit.
 *
 * So `missingForPublication` collects. It never returns early, and every caller
 * gets the whole list at once.
 */
import type { Artwork } from "./types";
import { mediumRequiresDepth, mediumRequiresFraming, type Medium } from "./taxonomy";

/** One unmet requirement, ready to render next to the field it belongs to. */
export interface MissingRequirement {
  /** The field name, matching the form control and the `fields` key on the error. */
  readonly field: string;
  /** Hebrew, shown to the artist. From the approved upload design's vocabulary. */
  readonly message: string;
}

/**
 * The shape this checks. Deliberately not `Artwork` itself: the multi-step form
 * asks the same question of a half-filled draft that is not yet a row, and the
 * progress counter on the publish button needs an answer before anything is
 * saved.
 */
export interface PublishCandidate {
  readonly title: string | null;
  readonly description: string | null;
  readonly priceAgorot: number | null;
  readonly heightMm: number | null;
  readonly widthMm: number | null;
  readonly depthMm: number | null;
  readonly weightGrams: number | null;
  readonly materials: string | null;
  readonly isFramed: boolean | null;
  readonly leadTimeDays: number | null;
  readonly medium: Medium | null;
  readonly styles: readonly string[];
  readonly moods: readonly string[];
  readonly originality: { readonly declaredBy: string; readonly declaredAt: string } | null;
  readonly aiAssisted: boolean | null;
  readonly inventoryType: "unique" | "edition";
  readonly madeToOrder: boolean;
  readonly productionLeadTimeDays: number | null;
}

function isBlank(value: string | null): boolean {
  return value === null || value.trim().length === 0;
}

/**
 * Every requirement this artwork does not yet meet, in the order the upload
 * form presents them.
 *
 * Order matters only for the human reading the list: it should walk down the
 * page, not jump around. Nothing branches on it.
 */
export function missingForPublication(candidate: PublishCandidate): readonly MissingRequirement[] {
  const missing: MissingRequirement[] = [];
  const need = (field: string, message: string) => missing.push({ field, message });

  // ---- Identity and price
  if (isBlank(candidate.title)) need("title", "יש להזין שם ליצירה");
  if (isBlank(candidate.description)) need("description", "יש להוסיף תיאור ליצירה");
  if (candidate.priceAgorot === null) need("priceAgorot", "יש להזין מחיר בשקלים");

  // ---- Classification. The medium is checked before the axes that depend on
  // it, so an artist who has not picked one is not also told their depth is
  // missing for a medium they have not chosen.
  if (candidate.medium === null) {
    need("medium", "יש לבחור מדיום");
  }
  // artwork-listings: style is "one or more", mood is "one or more", target
  // space is "zero or more" -- so target space is deliberately absent here.
  if (candidate.styles.length === 0) need("styles", "יש לבחור לפחות סגנון אחד");
  if (candidate.moods.length === 0) need("moods", "יש לבחור לפחות וייב אחד");

  // ---- Dimensions, weight, materials
  if (candidate.heightMm === null) need("heightMm", "יש להזין גובה בסנטימטרים");
  if (candidate.widthMm === null) need("widthMm", "יש להזין רוחב בסנטימטרים");
  if (candidate.medium !== null && mediumRequiresDepth(candidate.medium) && candidate.depthMm === null) {
    need("depthMm", "יש להזין עומק בסנטימטרים — היצירה תלת-ממדית");
  }
  if (candidate.weightGrams === null) need("weightGrams", "יש להזין משקל בגרמים");
  if (isBlank(candidate.materials)) need("materials", "יש לפרט את החומרים העיקריים");

  // ---- Framing, for wall-mounted media only
  if (
    candidate.medium !== null &&
    mediumRequiresFraming(candidate.medium) &&
    candidate.isFramed === null
  ) {
    need("isFramed", "יש לציין אם היצירה ממוסגרת או מוכנה לתלייה");
  }

  // ---- Dispatch
  if (candidate.leadTimeDays === null) need("leadTimeDays", "יש להזין זמן אספקה בימי עסקים");
  if (candidate.madeToOrder && candidate.productionLeadTimeDays === null) {
    need("productionLeadTimeDays", "יצירה בהזמנה — יש להזין זמן ייצור בימי עסקים");
  }
  // A one-of-a-kind piece that already exists is not made to order. Caught here
  // rather than by a table constraint so the artist gets a named field and a
  // sentence, and so a draft may hold the combination while it is being edited.
  if (candidate.madeToOrder && candidate.inventoryType !== "edition") {
    need("madeToOrder", "יצירה בהזמנה אפשרית רק במהדורה, לא ביצירה יחידה");
  }

  // ---- Declarations
  //
  // artwork-listings makes each of these a publication blocker in its own
  // right, and they are separate requirements rather than one "declarations"
  // item because they are separate questions with separate legal weight.
  if (candidate.originality === null) {
    need("originality", "יש לאשר שהיצירה מקורית ושזכויות היוצרים שייכות לכם");
  }
  if (candidate.aiAssisted === null) {
    // Note the wording: this is not "you must declare AI use", it is "you must
    // ANSWER". Answering "no" is a complete answer; leaving it blank is not.
    need("aiAssisted", "יש לענות על שאלת השימוש בבינה מלאכותית");
  }

  return missing;
}

/** The count the publish button shows: "נותרו 2 שדות חובה לפני פרסום". */
export function remainingRequirementCount(candidate: PublishCandidate): number {
  return missingForPublication(candidate).length;
}

export function isReadyToPublish(candidate: PublishCandidate): boolean {
  return missingForPublication(candidate).length === 0;
}

/** Read a stored artwork as a publish candidate. */
export function asPublishCandidate(artwork: Artwork): PublishCandidate {
  return {
    title: artwork.title,
    description: artwork.description,
    priceAgorot: artwork.priceAgorot,
    heightMm: artwork.heightMm,
    widthMm: artwork.widthMm,
    depthMm: artwork.depthMm,
    weightGrams: artwork.weightGrams,
    materials: artwork.materials,
    isFramed: artwork.isFramed,
    leadTimeDays: artwork.leadTimeDays,
    medium: artwork.medium,
    styles: artwork.styles,
    moods: artwork.moods,
    originality: artwork.originality,
    aiAssisted: artwork.aiAssisted,
    inventoryType: artwork.inventoryType,
    madeToOrder: artwork.madeToOrder,
    productionLeadTimeDays: artwork.productionLeadTimeDays,
  };
}

/** Group the missing requirements into the `fields` shape `AppError` carries. */
export function toFieldErrors(
  missing: readonly MissingRequirement[],
): Record<string, readonly string[]> {
  const fields: Record<string, string[]> = {};
  for (const requirement of missing) {
    (fields[requirement.field] ??= []).push(requirement.message);
  }
  return fields;
}
