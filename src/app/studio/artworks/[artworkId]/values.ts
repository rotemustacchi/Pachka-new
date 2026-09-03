/**
 * The form's own value shape, and the one place a stored artwork becomes one.
 *
 * Every value is a STRING, because that is what an input holds. Turning them
 * back into numbers, money and booleans happens in `studio/artwork-form.ts` on
 * the way in, and the module does the real validation after that. Nothing here
 * decides whether a value is acceptable.
 *
 * Mapping is explicit, key by key, with no spread — the same rule
 * `artworks/types.ts` states for rows. These values become props of a Client
 * Component, and React serialises the whole prop object into the payload
 * embedded in the HTML (SECURITY.md S1-8), so a spread would put whatever the
 * artwork type gains next quarter into the page.
 */
import { CURRENCY_SIGN, formatAgorot, parseAgorot, type Agorot } from "@/shared/money";
import {
  millimetresToCentimetres,
  type Artwork,
  type Medium,
  type PublishCandidate,
} from "@/modules/artworks";

export interface UploadFormValues {
  readonly title: string;
  readonly description: string;
  /** Shekels as typed, e.g. `1,250.00`. Never a float anywhere. */
  readonly priceShekels: string;
  readonly heightCm: string;
  readonly widthCm: string;
  readonly depthCm: string;
  readonly weightGrams: string;
  readonly materials: string;
  readonly leadTimeDays: string;
  readonly yearCreated: string;
  /** Tri-state: unanswered, framed, not framed. */
  readonly isFramed: "" | "yes" | "no";

  readonly medium: string;
  readonly styles: readonly string[];
  readonly targetSpaces: readonly string[];
  readonly moods: readonly string[];

  readonly inventoryType: "unique" | "edition";
  readonly stock: string;
  readonly madeToOrder: boolean;
  readonly productionLeadTimeDays: string;

  readonly affirmsOriginality: boolean;
  /** `null` is "has not answered", which is not the same as "no". */
  readonly aiAssisted: boolean | null;
}

function num(value: number | null): string {
  return value === null ? "" : String(value);
}

/**
 * Agorot as a shekel string the price input can hold and `parseAgorot` can read
 * back exactly.
 *
 * `formatAgorot` is integer arithmetic end to end, and `parseAgorot` accepts
 * its output including the thousands separators — so the round trip is lossless
 * and no float is created at any point. The currency sign is dropped only
 * because the design puts it in the label: "מחיר (₪)".
 */
function shekels(amount: Agorot | null): string {
  return amount === null ? "" : formatAgorot(amount).replace(CURRENCY_SIGN, "");
}

export function valuesOf(artwork: Artwork): UploadFormValues {
  return {
    title: artwork.title ?? "",
    description: artwork.description ?? "",
    priceShekels: shekels(artwork.priceAgorot),

    heightCm: num(artwork.heightMm === null ? null : millimetresToCentimetres(artwork.heightMm)),
    widthCm: num(artwork.widthMm === null ? null : millimetresToCentimetres(artwork.widthMm)),
    depthCm: num(artwork.depthMm === null ? null : millimetresToCentimetres(artwork.depthMm)),
    weightGrams: num(artwork.weightGrams),
    materials: artwork.materials ?? "",
    leadTimeDays: num(artwork.leadTimeDays),
    yearCreated: num(artwork.yearCreated),
    isFramed: artwork.isFramed === null ? "" : artwork.isFramed ? "yes" : "no",

    medium: artwork.medium ?? "",
    styles: [...artwork.styles],
    targetSpaces: [...artwork.targetSpaces],
    moods: [...artwork.moods],

    inventoryType: artwork.inventoryType,
    stock: String(artwork.stock),
    madeToOrder: artwork.madeToOrder,
    productionLeadTimeDays: num(artwork.productionLeadTimeDays),

    // The tick is present when a declaration was recorded. Who declared it and
    // when are server-side columns and are deliberately not sent to the form.
    affirmsOriginality: artwork.originality !== null,
    aiAssisted: artwork.aiAssisted,
  };
}

/** A blank or unreadable number is "missing", which is what the survey asks. */
function numberOrNull(value: string): number | null {
  if (value.trim() === "") return null;
  const parsed = Number(value.replace(/,/g, ""));
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Centimetres as the millimetres the requirement is stated in.
 *
 * Presentation only: the survey asks whether `heightMm` is null, and the real
 * conversion happens server-side in `centimetresToMillimetres`. A price is
 * likewise only ever asked "is it there", so an unreadable one counts as
 * missing — which is exactly what the server will say about it too.
 */
function millimetres(value: string): number | null {
  const centimetres = numberOrNull(value);
  return centimetres === null ? null : Math.round(centimetres * 10);
}

function agorotOrNull(value: string): number | null {
  if (value.trim() === "") return null;
  try {
    return parseAgorot(value, { allowNegative: false });
  } catch {
    return null;
  }
}

export function toCandidate(values: UploadFormValues): PublishCandidate {
  return {
    title: values.title || null,
    description: values.description || null,
    priceAgorot: agorotOrNull(values.priceShekels),
    heightMm: millimetres(values.heightCm),
    widthMm: millimetres(values.widthCm),
    depthMm: millimetres(values.depthCm),
    weightGrams: numberOrNull(values.weightGrams),
    materials: values.materials || null,
    isFramed: values.isFramed === "" ? null : values.isFramed === "yes",
    leadTimeDays: numberOrNull(values.leadTimeDays),
    medium: (values.medium || null) as Medium | null,
    styles: values.styles,
    moods: values.moods,
    // The survey only asks whether a declaration exists. The account that
    // affirmed it and the moment it happened are recorded server-side and are
    // deliberately not knowable in the browser.
    originality: values.affirmsOriginality ? { declaredBy: "", declaredAt: "" } : null,
    aiAssisted: values.aiAssisted,
    inventoryType: values.inventoryType,
    madeToOrder: values.madeToOrder,
    productionLeadTimeDays: numberOrNull(values.productionLeadTimeDays),
  };
}
