/**
 * Pre-filling the form from the model, and recording who chose what.
 *
 * upload-pipeline, "AI tag suggestion with artist override": suggestions are
 * "presented to the artist as pre-filled, editable selections. The artist's
 * final choice SHALL always take precedence, and the system SHALL record
 * whether each stored value was AI-suggested or artist-set."
 *
 * WHY PROVENANCE LIVES HERE AND NOT ON `artworks`
 * ----------------------------------------------
 * The VALUES live on `artworks`, which owns them; this module writes them
 * through `updateArtwork` rather than touching the table. The PROVENANCE is a
 * fact about the pipeline -- what the model suggested and whether the artist
 * moved it -- so it lives in `upload_events`, which this module owns.
 * ARCHITECTURE.md's table ownership rule leaves no third option, and the
 * arrangement turns out to be the honest one: provenance is a history, and a
 * pair of columns on `artworks` could only ever hold the latest answer.
 *
 * SECURITY.md S2-20 item 5 wants this record for a second reason: it is the
 * audit trail for detecting an attempt to steer the model with text painted
 * into the canvas. An artwork whose every field arrived AI-suggested and
 * unedited, with a taxonomy claim at the cap, looks different from one an
 * artist filled in.
 *
 * DOMINANT COLOURS HAVE NO COLUMN ON `artworks`
 * ---------------------------------------------
 * The spec asks for colour suggestions; `artworks` has no colour column and
 * this module may not add one to another module's table. So the artist's chosen
 * palette is stored here, with the provenance, and is served from here. Raised
 * with the lead architect rather than resolved by inventing a column.
 */
import { z } from "zod";
import {
  isMedium,
  isMood,
  isStyle,
  isTargetSpace,
  listingLimits,
} from "@/modules/artworks";
import { AppError } from "@/shared/errors";
import type { Sql } from "@/shared/db";
import { MAX_DOMINANT_COLOURS, type DominantColour, type Suggestions } from "./analysis";
import { eventsFor, recordEvent } from "./events";

/** The four taxonomy axes plus the two free fields the pipeline suggests. */
export const CLASSIFIED_FIELDS = [
  "medium",
  "styles",
  "moods",
  "targetSpaces",
  "dominantColours",
  "description",
] as const;

export type ClassifiedField = (typeof CLASSIFIED_FIELDS)[number];

/** Who put the stored value there. */
export type Provenance = "ai_suggested" | "artist_set";

export type ClassificationProvenance = Readonly<Record<ClassifiedField, Provenance>>;

export interface ArtistClassification {
  readonly medium: string | null;
  readonly styles: readonly string[];
  readonly moods: readonly string[];
  readonly targetSpaces: readonly string[];
  readonly dominantColours: readonly DominantColour[];
  readonly description: string;
}

const Colour = z
  .object({
    hex: z.string().regex(/^#[0-9a-fA-F]{6}$/, "צבע חייב להיות בפורמט #RRGGBB"),
    name: z.string().trim().max(40),
  })
  .strict();

const Submitted = z
  .object({
    medium: z.string().trim().min(1).nullish(),
    styles: z.array(z.string().trim().min(1)).default([]),
    moods: z.array(z.string().trim().min(1)).default([]),
    targetSpaces: z.array(z.string().trim().min(1)).default([]),
    dominantColours: z.array(Colour).max(MAX_DOMINANT_COLOURS).default([]),
    description: z.string().default(""),
  })
  .strict();

/**
 * An empty form. What the artist gets when analysis failed.
 *
 * upload-pipeline, "Analysis fails": "the system presents an empty
 * classification form for manual completion and does not block the upload."
 * Empty rather than partially guessed: a half-filled form invites the artist to
 * skim past a field they never chose, and this is the case where nothing about
 * the image is known.
 */
export function emptySuggestions(): Suggestions {
  return {
    medium: null,
    styles: [],
    moods: [],
    targetSpaces: [],
    dominantColours: [],
    description: "",
  };
}

/**
 * The suggestions the artist's form should open with.
 *
 * Reads the recorded `suggestions_recorded` event rather than calling the model
 * again -- the call happened once, at upload, and re-running it when the artist
 * reloads the form would make AI cost scale with how indecisive they are.
 * Returns an empty form when there is no such event, which is exactly the
 * analysis-failure case.
 */
export async function suggestionsFor(sql: Sql, artworkId: string): Promise<Suggestions> {
  const events = await eventsFor(sql, artworkId);
  const recorded = events.find((event) => event.event === "suggestions_recorded");
  if (recorded === undefined) return emptySuggestions();

  const stored = recorded.detail.suggestions;
  const parsed = Submitted.safeParse(stored);
  if (!parsed.success) return emptySuggestions();

  const value = parsed.data;
  return {
    medium: value.medium !== null && value.medium !== undefined && isMedium(value.medium) ? value.medium : null,
    styles: value.styles.filter(isStyle),
    moods: value.moods.filter(isMood),
    targetSpaces: value.targetSpaces.filter(isTargetSpace),
    dominantColours: value.dominantColours,
    description: value.description,
  };
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const left = [...a].sort();
  const right = [...b].sort();
  return left.every((value, index) => value === right[index]);
}

function sameColours(a: readonly DominantColour[], b: readonly DominantColour[]): boolean {
  return sameList(
    a.map((colour) => colour.hex.toLowerCase()),
    b.map((colour) => colour.hex.toLowerCase()),
  );
}

/**
 * Compare what the artist submitted against what the model suggested.
 *
 * Equality means the artist left the suggestion alone, which is what
 * `ai_suggested` records. Anything else -- edited, cleared, reordered into a
 * different set -- is `artist_set`. Note that clearing a suggested value counts
 * as artist-set: deciding a suggestion is wrong is a decision.
 */
export function provenanceOf(
  suggested: Suggestions,
  chosen: ArtistClassification,
): ClassificationProvenance {
  return {
    medium: chosen.medium === suggested.medium ? "ai_suggested" : "artist_set",
    styles: sameList(chosen.styles, suggested.styles) ? "ai_suggested" : "artist_set",
    moods: sameList(chosen.moods, suggested.moods) ? "ai_suggested" : "artist_set",
    targetSpaces: sameList(chosen.targetSpaces, suggested.targetSpaces)
      ? "ai_suggested"
      : "artist_set",
    dominantColours: sameColours(chosen.dominantColours, suggested.dominantColours)
      ? "ai_suggested"
      : "artist_set",
    description: chosen.description === suggested.description ? "ai_suggested" : "artist_set",
  };
}

export interface RecordedClassification {
  readonly provenance: ClassificationProvenance;
  readonly chosen: ArtistClassification;
}

/**
 * Validate the artist's submission and record it with its provenance.
 *
 * The taxonomy is re-validated here even though `artworks.updateArtwork` will
 * validate it again on the way into the table. That is not redundancy for its
 * own sake: this function records provenance for values that the artwork write
 * might then reject, and a provenance row describing a value that was never
 * stored is worse than no row. Validating first means the two always agree.
 *
 * The artist's choice wins unconditionally. There is no branch below where a
 * suggestion overrides a submitted value, and there is no field the artist
 * cannot change.
 */
export async function recordClassification(
  sql: Sql,
  input: {
    readonly artworkId: string;
    readonly artistId: string;
    readonly submitted: unknown;
  },
): Promise<RecordedClassification> {
  const parsed = Submitted.safeParse(input.submitted);
  if (!parsed.success) {
    const fields: Record<string, string[]> = {};
    for (const issue of parsed.error.issues) {
      (fields[issue.path.join(".") || "classification"] ??= []).push(issue.message);
    }
    throw AppError.fieldsInvalid(fields, { code: "uploads.invalid_classification" });
  }

  const limits = await listingLimits(sql);
  const value = parsed.data;
  const medium = value.medium ?? null;

  const outside: Record<string, string[]> = {};
  if (medium !== null && !isMedium(medium)) outside.medium = [`"${medium}" is not a known medium`];
  const badStyles = value.styles.filter((style) => !isStyle(style));
  if (badStyles.length > 0) outside.styles = badStyles.map((style) => `"${style}" is not a known style`);
  const badMoods = value.moods.filter((mood) => !isMood(mood));
  if (badMoods.length > 0) outside.moods = badMoods.map((mood) => `"${mood}" is not a known mood`);
  const badSpaces = value.targetSpaces.filter((space) => !isTargetSpace(space));
  if (badSpaces.length > 0) {
    outside.targetSpaces = badSpaces.map((space) => `"${space}" is not a known target space`);
  }
  if (Object.keys(outside).length > 0) {
    throw AppError.fieldsInvalid(outside, { code: "uploads.taxonomy_value_outside_set" });
  }

  // The same caps the model's response is held to (SECURITY.md S2-20 item 2).
  // An artist who claims every style ranks into every result set just as
  // effectively as a steered model does.
  const over: Record<string, string[]> = {};
  if (value.styles.length > limits.maxStyles) {
    over.styles = [`ניתן לבחור עד ${limits.maxStyles} סגנונות`];
  }
  if (value.moods.length > limits.maxMoods) {
    over.moods = [`ניתן לבחור עד ${limits.maxMoods} מצבי רוח`];
  }
  if (value.targetSpaces.length > limits.maxTargetSpaces) {
    over.targetSpaces = [`ניתן לבחור עד ${limits.maxTargetSpaces} חללים`];
  }
  if (Object.keys(over).length > 0) {
    throw AppError.fieldsInvalid(over, { code: "uploads.taxonomy_cap_exceeded" });
  }

  const chosen: ArtistClassification = {
    medium,
    styles: value.styles,
    moods: value.moods,
    targetSpaces: value.targetSpaces,
    dominantColours: value.dominantColours,
    description: value.description,
  };

  const suggested = await suggestionsFor(sql, input.artworkId);
  const provenance = provenanceOf(suggested, chosen);

  await recordEvent(sql, {
    artworkId: input.artworkId,
    artistId: input.artistId,
    event: "classification_recorded",
    detail: { provenance, chosen },
  });

  return { provenance, chosen };
}

/**
 * What is on record for this artwork, per field.
 *
 * Absent when the artist has not submitted the form yet -- which is different
 * from "everything is AI-suggested", and is reported as `null` rather than as a
 * default so that a caller cannot mistake one for the other.
 */
export async function classificationProvenance(
  sql: Sql,
  artworkId: string,
): Promise<ClassificationProvenance | null> {
  const events = await eventsFor(sql, artworkId);
  const recorded = events.find((event) => event.event === "classification_recorded");
  if (recorded === undefined) return null;

  const detail = recorded.detail.provenance;
  if (detail === null || typeof detail !== "object") return null;

  const record = detail as Record<string, unknown>;
  const result: Partial<Record<ClassifiedField, Provenance>> = {};
  for (const field of CLASSIFIED_FIELDS) {
    result[field] = record[field] === "artist_set" ? "artist_set" : "ai_suggested";
  }
  return result as ClassificationProvenance;
}

/** The palette the artist settled on. Stored here because `artworks` has no column. */
export async function dominantColoursFor(
  sql: Sql,
  artworkId: string,
): Promise<readonly DominantColour[]> {
  const events = await eventsFor(sql, artworkId);
  const recorded = events.find((event) => event.event === "classification_recorded");
  const source = recorded?.detail.chosen ?? (await suggestionsFor(sql, artworkId));
  const parsed = Submitted.safeParse(source);
  return parsed.success ? parsed.data.dominantColours : [];
}
