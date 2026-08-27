/**
 * The closed taxonomy, and the two things a closed set has to actually do:
 * refuse what is not in it, and normalise what is.
 */
import { describe, expect, it } from "vitest";
import { AppError } from "@/shared/errors";
import {
  MEDIA,
  MEDIA_REQUIRING_DEPTH,
  MEDIUM_LABELS,
  MOODS,
  MOOD_LABELS,
  STYLES,
  STYLE_LABELS,
  TARGET_SPACES,
  TARGET_SPACE_LABELS,
  WALL_MOUNTED_MEDIA,
  isMedium,
  mediumRequiresDepth,
  mediumRequiresFraming,
  parseTaxonomyList,
  parseTaxonomyValue,
} from "./taxonomy";

describe("the four axes", () => {
  /** artwork-listings names the values. This is that sentence, as a test. */
  it("hold exactly the values the spec names", () => {
    expect([...MEDIA]).toEqual([
      "painting_illustration",
      "photography",
      "ceramics_objects",
      "jewelry",
      "textile_clothing",
    ]);
    expect([...STYLES]).toEqual([
      "minimalist",
      "abstract",
      "boho_coastal",
      "modern_industrial",
      "pop_art",
    ]);
    expect([...TARGET_SPACES]).toEqual([
      "living_room",
      "bedroom",
      "office_clinic",
      "childrens_room",
      "kitchen",
    ]);
    expect([...MOODS]).toEqual(["calm", "bold", "romantic", "edgy"]);
  });

  /**
   * A stored value with no label renders as `undefined` in a tag on the catalog
   * page. Cheap to assert, and the failure is otherwise only visible to a
   * Hebrew reader looking at the right filter.
   */
  it("have a Hebrew label for every value", () => {
    for (const value of MEDIA) expect(MEDIUM_LABELS[value]).toBeTruthy();
    for (const value of STYLES) expect(STYLE_LABELS[value]).toBeTruthy();
    for (const value of TARGET_SPACES) expect(TARGET_SPACE_LABELS[value]).toBeTruthy();
    for (const value of MOODS) expect(MOOD_LABELS[value]).toBeTruthy();
  });

  it("use machine keys, never the Hebrew display text", () => {
    // A stored value that is also a label turns a copy edit into a data
    // migration. Latin snake_case throughout.
    for (const value of [...MEDIA, ...STYLES, ...TARGET_SPACES, ...MOODS]) {
      expect(value).toMatch(/^[a-z][a-z_]*$/);
    }
  });
});

describe("parsing a single-value axis", () => {
  it("accepts a value in the set", () => {
    expect(parseTaxonomyValue("medium", "ceramics_objects")).toBe("ceramics_objects");
  });

  /** artwork-listings: "Client submits a value outside the taxonomy" -> rejected. */
  it.each(["sculpture", "SCULPTURE", "", "painting illustration", null, 7, undefined])(
    "rejects %s",
    (value) => {
      expect(() => parseTaxonomyValue("medium", value)).toThrow(AppError);
    },
  );

  it("names the value it refused and the values it would accept", () => {
    try {
      parseTaxonomyValue("medium", "sculpture");
      expect.unreachable("should have thrown");
    } catch (error) {
      const appError = error as AppError;
      expect(appError.kind).toBe("validation");
      expect(appError.code).toBe("artworks.taxonomy_value_outside_set");
      expect(appError.message).toContain("sculpture");
      expect(appError.message).toContain("painting_illustration");
    }
  });

  it("does not coerce a near-miss into a member of the set", () => {
    // The temptation is to normalise "Minimalist" to "minimalist". Doing so
    // means the set is not closed after all -- it is closed under whatever
    // normalisation somebody wrote, and the next near-miss is a bug report.
    expect(() => parseTaxonomyValue("styles", "Minimalist")).toThrow(AppError);
    expect(() => parseTaxonomyValue("styles", " minimalist ")).toThrow(AppError);
  });
});

describe("parsing a multi-value axis", () => {
  it("accepts values in the set", () => {
    expect(parseTaxonomyList("styles", ["minimalist", "pop_art"])).toEqual([
      "minimalist",
      "pop_art",
    ]);
  });

  /**
   * Order is normalised to the declared order of the set, so two artworks
   * classified identically compare equal as arrays -- which is what lets the
   * matchmaker's overlap score skip a sort on every read.
   */
  it("normalises order to the declared order of the set", () => {
    expect(parseTaxonomyList("styles", ["pop_art", "minimalist"])).toEqual([
      "minimalist",
      "pop_art",
    ]);
  });

  it("collapses duplicates", () => {
    expect(parseTaxonomyList("moods", ["calm", "calm", "bold"])).toEqual(["calm", "bold"]);
  });

  it("accepts an empty list, since target space is zero-or-more", () => {
    expect(parseTaxonomyList("target_spaces", [])).toEqual([]);
  });

  /**
   * Rejects rather than drops. A dropped value produces an artwork classified
   * differently from what the artist submitted, with nothing telling them so.
   */
  it("rejects the whole list when any value is outside the set, naming every offender", () => {
    try {
      parseTaxonomyList("styles", ["minimalist", "coastal_minimal", "brutalist"]);
      expect.unreachable("should have thrown");
    } catch (error) {
      const appError = error as AppError;
      expect(appError.code).toBe("artworks.taxonomy_value_outside_set");
      expect(appError.details["rejected"]).toEqual(["coastal_minimal", "brutalist"]);
    }
  });
});

describe("which media need which conditional fields", () => {
  /**
   * artwork-listings: "depth where the medium is three-dimensional", and
   * "framed or ready to hang for wall-mounted media". Asking a jeweller whether
   * a ring is framed forces them to answer something false.
   */
  it("asks for a depth on three-dimensional media only", () => {
    expect(mediumRequiresDepth("ceramics_objects")).toBe(true);
    expect(mediumRequiresDepth("jewelry")).toBe(true);
    expect(mediumRequiresDepth("painting_illustration")).toBe(false);
    expect(mediumRequiresDepth("photography")).toBe(false);
    expect(mediumRequiresDepth("textile_clothing")).toBe(false);
  });

  it("asks for the framing answer on wall-mounted media only", () => {
    expect(mediumRequiresFraming("painting_illustration")).toBe(true);
    expect(mediumRequiresFraming("photography")).toBe(true);
    expect(mediumRequiresFraming("ceramics_objects")).toBe(false);
    expect(mediumRequiresFraming("jewelry")).toBe(false);
  });

  it("draws both sets from the taxonomy rather than inventing values", () => {
    for (const medium of [...MEDIA_REQUIRING_DEPTH, ...WALL_MOUNTED_MEDIA]) {
      expect(isMedium(medium)).toBe(true);
    }
  });
});
