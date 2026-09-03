/**
 * Reading the artwork upload form, and handing it to `artworks`.
 *
 * Task 3.3's tail. The module already owns every rule: the closed taxonomy, the
 * completeness survey, the originality record, the state machine. What was
 * missing was the wiring, and wiring is all this file is -- it parses strings
 * into the shapes `ArtworkInput` declares and then calls the module. It decides
 * nothing about whether a value is acceptable.
 *
 * Two parsing decisions are worth stating, because both look like logic and are
 * not:
 *
 * ABSENT VERSUS EMPTY. `ArtworkInput` distinguishes `undefined` ("not
 * submitted, leave it alone") from `null` ("clear it"), which is what lets a
 * form save one section without wiping the others. So every read here asks
 * `form.has()` first, and only then whether the value is blank.
 *
 * BOOLEANS ARE POSTED AS WORDS. An unchecked checkbox posts nothing at all,
 * which is indistinguishable from a field that was not on the page -- so an
 * artist could tick "made to order" and never untick it. The form therefore
 * posts `yes` / `no` explicitly (see UploadForm), and an omitted key genuinely
 * means "this section was not submitted". `aiAssisted` needs the third state
 * anyway: unanswered is not `no`, and the publish gate refuses it.
 *
 * ERRORS ARE KEYED BY REQUIREMENT FIELD, not by control name. `heightMm` is the
 * key `missingForPublication` uses, and a form that keyed its own parse errors
 * `heightCm` would show two different messages in two different places for one
 * field. `CONTROL_FOR_FIELD` maps the requirement key to the control that
 * satisfies it, for the one place that needs the other direction.
 */
import { AppError, type FieldErrors } from "@/shared/errors";
import { parseAgorot } from "@/shared/money";
import {
  createDraft,
  publishArtwork,
  updateArtwork,
  type Artwork,
  type ArtworkInput,
  type ArtworksDeps,
} from "@/modules/artworks";
import { toFormState, type FormState } from "../_lib/form-state";

/**
 * Which control carries each publication requirement.
 *
 * Only the ones whose names differ: dimensions are typed in centimetres and
 * stored in millimetres, the price is typed in shekels and stored in agorot,
 * and the originality requirement is satisfied by a tick rather than by the
 * two columns it becomes.
 */
export const CONTROL_FOR_FIELD: Readonly<Record<string, string>> = {
  heightMm: "heightCm",
  widthMm: "widthCm",
  depthMm: "depthCm",
  priceAgorot: "priceShekels",
  originality: "affirmsOriginality",
};

/** The control that carries a requirement, which is usually the field itself. */
export function controlFor(field: string): string {
  return CONTROL_FOR_FIELD[field] ?? field;
}

type Collector = (field: string, message: string) => void;

function raw(form: FormData, control: string): string | undefined {
  if (!form.has(control)) return undefined;
  const value = form.get(control);
  return typeof value === "string" ? value.trim() : "";
}

/** A text field: absent stays absent, blank clears. */
function readText(form: FormData, control: string): string | null | undefined {
  const value = raw(form, control);
  if (value === undefined) return undefined;
  return value === "" ? null : value;
}

/**
 * A whole number. A blank clears it; anything unparseable is a field error
 * rather than a silent `null`, which would tell the artist the field is
 * "missing" when what they typed was "twenty".
 */
function readNumber(
  form: FormData,
  control: string,
  field: string,
  message: string,
  fail: Collector,
): number | null | undefined {
  const value = raw(form, control);
  if (value === undefined) return undefined;
  if (value === "") return null;

  const parsed = Number(value.replace(/,/g, ""));
  if (!Number.isFinite(parsed)) {
    fail(field, message);
    return undefined;
  }
  return parsed;
}

/** `yes` / `no`; blank clears; absent leaves alone. */
function readBoolean(form: FormData, control: string): boolean | null | undefined {
  const value = raw(form, control);
  if (value === undefined) return undefined;
  if (value === "") return null;
  return value === "yes";
}

/**
 * The price, in shekels as typed, as whole agorot.
 *
 * `parseAgorot` is the only sanctioned route from what a person typed to money
 * (ARCHITECTURE.md: never a float, never a decimal string). Its message is
 * English and internal, so a failure is restated in the form's language and
 * keyed to `priceAgorot`, where the publish survey also puts it.
 */
function readPrice(form: FormData, fail: Collector): number | null | undefined {
  const value = raw(form, "priceShekels");
  if (value === undefined) return undefined;
  if (value === "") return null;

  try {
    return parseAgorot(value, { allowNegative: false });
  } catch {
    fail("priceAgorot", "יש להזין מחיר תקין בשקלים");
    return undefined;
  }
}

/**
 * A multi-value taxonomy axis.
 *
 * An axis that appears on the form always submits its full selection, so an
 * empty selection is an empty array rather than "leave alone" -- otherwise
 * deselecting the last style would not save. The marker input is what makes
 * "the axis was on the page" observable when nothing is selected.
 */
function readAxis(form: FormData, control: string): readonly string[] | undefined {
  if (!form.has(`${control}.present`)) return undefined;
  return form
    .getAll(control)
    .filter((value): value is string => typeof value === "string" && value !== "");
}

/**
 * Everything the form said, as the module's input type.
 *
 * Collects every parse failure before throwing, for the same reason
 * `missingForPublication` collects: an artist who fixes the height, resubmits,
 * and is then told about the weight has been made to do two round trips to
 * learn one thing.
 */
export function readArtworkInput(form: FormData): ArtworkInput {
  const problems: Record<string, string[]> = {};
  const fail: Collector = (field, message) => {
    (problems[field] ??= []).push(message);
  };

  const input: ArtworkInput = {
    title: readText(form, "title"),
    description: readText(form, "description"),
    priceAgorot: readPrice(form, fail),

    heightCm: readNumber(form, "heightCm", "heightMm", "גובה חייב להיות מספר בסנטימטרים", fail),
    widthCm: readNumber(form, "widthCm", "widthMm", "רוחב חייב להיות מספר בסנטימטרים", fail),
    depthCm: readNumber(form, "depthCm", "depthMm", "עומק חייב להיות מספר בסנטימטרים", fail),
    weightGrams: readNumber(form, "weightGrams", "weightGrams", "משקל חייב להיות מספר בגרמים", fail),
    materials: readText(form, "materials"),
    isFramed: readBoolean(form, "isFramed"),
    leadTimeDays: readNumber(form, "leadTimeDays", "leadTimeDays", "זמן אספקה חייב להיות מספר ימים", fail),
    yearCreated: readNumber(form, "yearCreated", "yearCreated", "שנת יצירה חייבת להיות מספר", fail),

    medium: readText(form, "medium"),
    styles: readAxis(form, "styles"),
    targetSpaces: readAxis(form, "targetSpaces"),
    moods: readAxis(form, "moods"),

    inventoryType: readInventoryType(form),
    stock: readNumber(form, "stock", "stock", "גודל המהדורה חייב להיות מספר", fail) ?? undefined,
    madeToOrder: readBoolean(form, "madeToOrder") ?? undefined,
    productionLeadTimeDays: readNumber(
      form,
      "productionLeadTimeDays",
      "productionLeadTimeDays",
      "זמן ייצור חייב להיות מספר ימים",
      fail,
    ),

    affirmsOriginality: readBoolean(form, "affirmsOriginality") ?? undefined,
    aiAssisted: readBoolean(form, "aiAssisted"),
  };

  if (Object.keys(problems).length > 0) {
    // Not `fieldsInvalid`: its banner lists the field NAMES, which are English
    // column-ish identifiers. The per-field messages are the useful half and
    // they are already in the artist's language.
    throw AppError.validation("יש לתקן את השדות המסומנים.", {
      code: "studio.unreadable_field",
      fields: problems,
    });
  }
  return input;
}

function readInventoryType(form: FormData): "unique" | "edition" | undefined {
  const value = raw(form, "inventoryType");
  if (value === "unique" || value === "edition") return value;
  return undefined;
}

/** The artwork this submission is about. Ownership is the module's question. */
function artworkId(form: FormData): string {
  const id = raw(form, "artworkId");
  if (!id) {
    throw AppError.validation("Which artwork?", { code: "studio.artwork_id_missing" });
  }
  return id;
}

export type SubmitIntent = "save" | "publish";

/** What the artist pressed. Anything unrecognised saves rather than publishes. */
export function intentOf(form: FormData): SubmitIntent {
  return raw(form, "intent") === "publish" ? "publish" : "save";
}

/**
 * Save or publish, whichever the artist asked for.
 *
 * Identity is a parameter and never a form field: the caller reads it from the
 * session (`(accounts)/deps.ts` explains why binding it into the action would
 * make identity an input). The artwork id IS a form field, and that is safe
 * because `updateArtwork` and `publishArtwork` scope every load to the acting
 * artist and answer `not_found` for somebody else's row.
 */
export async function submitArtworkForm(
  deps: ArtworksDeps,
  artistId: string,
  form: FormData,
): Promise<FormState> {
  try {
    const input = readArtworkInput(form);
    const id = artworkId(form);

    if (intentOf(form) === "publish") {
      await publishArtwork(deps, artistId, id, input);
      return { status: "ok", message: "היצירה פורסמה." };
    }

    await updateArtwork(deps, artistId, id, input);
    return { status: "ok", message: "הטיוטה נשמרה." };
  } catch (error) {
    return toFormState(error);
  }
}

/** Start a new listing. Always a draft; there is no create-published path. */
export async function startDraft(deps: ArtworksDeps, artistId: string): Promise<Artwork> {
  return createDraft(deps, artistId);
}

/** Field-level messages for one requirement, for rendering next to its control. */
export function messagesFor(fields: FieldErrors | undefined, field: string): readonly string[] {
  return fields?.[field] ?? [];
}
