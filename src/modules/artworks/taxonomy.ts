/**
 * The closed, server-defined taxonomy.
 *
 * artwork-listings, "Artwork taxonomy": four axes, fixed values, and "artists
 * SHALL NOT introduce new values".
 *
 * WHY CLOSED IS LOAD-BEARING
 * --------------------------
 * The matchmaker's scoring function ranks partly on taxonomy overlap between a
 * buyer's questionnaire answers and an artwork's classification. Overlap only
 * means anything if both sides draw from the same vocabulary: one artist
 * inventing "coastal-minimal" produces an artwork nobody's filter matches and a
 * facet nobody's questionnaire offers. And per SECURITY.md S2-20, the vision
 * model that pre-fills this form reads an attacker-controlled image, so a value
 * arriving from that path is no more trustworthy than one typed by hand.
 *
 * Every value that enters the system passes `parseTaxonomy` below. Nothing is
 * coerced, nothing is title-cased into existence, and a value outside the set is
 * rejected rather than dropped -- the artist is told which value was refused.
 *
 * THREE STATEMENTS OF ONE SET
 * ---------------------------
 * The same values appear as check constraints in
 * `db/migrations/20260827T151500_artworks_listings.sql`, as the constants below,
 * and in the Hebrew display labels. `tests/integration/artworks-taxonomy.test.ts`
 * reads the constraint definitions out of `pg_constraint` and asserts they list
 * exactly these values, so the schema and the code cannot drift apart quietly.
 *
 * Keys are stable machine strings, never the Hebrew display text. A display
 * label is a translation, and translations get edited; a stored value that is
 * also a label turns a copy change into a data migration.
 */
import { AppError } from "@/shared/errors";

export const MEDIA = [
  "painting_illustration",
  "photography",
  "ceramics_objects",
  "jewelry",
  "textile_clothing",
] as const;

export const STYLES = [
  "minimalist",
  "abstract",
  "boho_coastal",
  "modern_industrial",
  "pop_art",
] as const;

export const TARGET_SPACES = [
  "living_room",
  "bedroom",
  "office_clinic",
  "childrens_room",
  "kitchen",
] as const;

export const MOODS = ["calm", "bold", "romantic", "edgy"] as const;

export type Medium = (typeof MEDIA)[number];
export type Style = (typeof STYLES)[number];
export type TargetSpace = (typeof TARGET_SPACES)[number];
export type Mood = (typeof MOODS)[number];

/** The four axes, by the field name they carry on an artwork. */
export const TAXONOMY_AXES = {
  medium: MEDIA,
  styles: STYLES,
  target_spaces: TARGET_SPACES,
  moods: MOODS,
} as const;

export type TaxonomyAxis = keyof typeof TAXONOMY_AXES;

/**
 * Media whose pieces are three-dimensional, and therefore need a depth.
 *
 * artwork-listings, "Mandatory specification fields": "dimensions in
 * centimetres (height and width; depth where the medium is three-dimensional)".
 * A vase has a depth; a photograph's third dimension is its frame, which the
 * framing field already covers.
 */
export const MEDIA_REQUIRING_DEPTH: readonly Medium[] = ["ceramics_objects", "jewelry"];

/**
 * Media that hang on a wall, and therefore need the framing question answered.
 *
 * Same clause: "whether the piece is framed or ready to hang for wall-mounted
 * media". For a ring or a bowl the question is meaningless, and asking it would
 * force an artist to answer something false.
 */
export const WALL_MOUNTED_MEDIA: readonly Medium[] = ["painting_illustration", "photography"];

export function mediumRequiresDepth(medium: Medium): boolean {
  return MEDIA_REQUIRING_DEPTH.includes(medium);
}

export function mediumRequiresFraming(medium: Medium): boolean {
  return WALL_MOUNTED_MEDIA.includes(medium);
}

/**
 * Hebrew display labels, from the approved designs (design/Upload.dc.html and
 * design/Catalog.dc.html). Presentation only: nothing branches on these, and
 * changing one is a copy change, not a data change.
 */
export const MEDIUM_LABELS: Readonly<Record<Medium, string>> = {
  painting_illustration: "ציור ואיור",
  photography: "צילום",
  ceramics_objects: "קרמיקה ואובייקטים",
  jewelry: "תכשיטים",
  textile_clothing: "טקסטיל וביגוד",
};

export const STYLE_LABELS: Readonly<Record<Style, string>> = {
  minimalist: "מינימליסטי",
  abstract: "אבסטרקטי",
  boho_coastal: "בוהו וחופי",
  modern_industrial: "מודרני תעשייתי",
  pop_art: "פופ ארט",
};

export const TARGET_SPACE_LABELS: Readonly<Record<TargetSpace, string>> = {
  living_room: "סלון",
  bedroom: "חדר שינה",
  office_clinic: "משרד או קליניקה",
  childrens_room: "חדר ילדים",
  kitchen: "מטבח",
};

export const MOOD_LABELS: Readonly<Record<Mood, string>> = {
  calm: "מרגיע",
  bold: "נועז",
  romantic: "רומנטי",
  edgy: "אפל ומתוחכם",
};

export const AXIS_LABELS: Readonly<Record<TaxonomyAxis, string>> = {
  medium: "מדיום",
  styles: "סגנון",
  target_spaces: "חלל מתאים",
  moods: "וייב",
};

function isMember<T extends string>(set: readonly T[], value: unknown): value is T {
  return typeof value === "string" && (set as readonly string[]).includes(value);
}

export const isMedium = (value: unknown): value is Medium => isMember(MEDIA, value);
export const isStyle = (value: unknown): value is Style => isMember(STYLES, value);
export const isTargetSpace = (value: unknown): value is TargetSpace =>
  isMember(TARGET_SPACES, value);
export const isMood = (value: unknown): value is Mood => isMember(MOODS, value);

/**
 * Parse one value against an axis.
 *
 * Rejects rather than drops. A dropped value produces an artwork classified
 * differently from what the artist submitted, with nothing telling them so;
 * SECURITY.md S2-20 tolerates dropping only on the vision-model path, and only
 * because that path records what it dropped and hands the artist a form to fix.
 * On the artist's own submission the answer is an error naming the value.
 */
export function parseTaxonomyValue<A extends TaxonomyAxis>(
  axis: A,
  value: unknown,
): (typeof TAXONOMY_AXES)[A][number] {
  const permitted = TAXONOMY_AXES[axis] as readonly string[];
  if (typeof value === "string" && permitted.includes(value)) {
    return value as (typeof TAXONOMY_AXES)[A][number];
  }
  throw AppError.validation(
    `"${String(value)}" is not a permitted ${axis} value. The taxonomy is a closed set: ${permitted.join(", ")}.`,
    {
      code: "artworks.taxonomy_value_outside_set",
      details: { axis, value: typeof value === "string" ? value : null, permitted },
      fields: { [axis]: [`ערך לא מוכר: ${String(value)}`] },
    },
  );
}

/**
 * Parse a multi-select axis: every value checked, duplicates collapsed, order
 * normalised to the declared order of the set.
 *
 * Normalising the order is not cosmetic. It makes two artworks classified with
 * the same styles compare equal as arrays, which is what lets the matchmaker's
 * overlap score and the catalog's facet counts be computed without sorting at
 * every read.
 */
export function parseTaxonomyList<A extends "styles" | "target_spaces" | "moods">(
  axis: A,
  values: readonly unknown[],
): (typeof TAXONOMY_AXES)[A][number][] {
  const permitted = TAXONOMY_AXES[axis] as readonly string[];
  const seen = new Set<string>();
  const rejected: string[] = [];

  for (const value of values) {
    if (typeof value === "string" && permitted.includes(value)) {
      seen.add(value);
    } else {
      rejected.push(String(value));
    }
  }

  if (rejected.length > 0) {
    throw AppError.validation(
      `${rejected.join(", ")} ${rejected.length === 1 ? "is not a" : "are not"} permitted ${axis} ${
        rejected.length === 1 ? "value" : "values"
      }. The taxonomy is a closed set: ${permitted.join(", ")}.`,
      {
        code: "artworks.taxonomy_value_outside_set",
        details: { axis, rejected, permitted },
        fields: { [axis]: [`ערכים לא מוכרים: ${rejected.join(", ")}`] },
      },
    );
  }

  return permitted.filter((value) => seen.has(value)) as (typeof TAXONOMY_AXES)[A][number][];
}
