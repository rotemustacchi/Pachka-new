/**
 * The questionnaire's contract: what is required, what is optional, what is
 * refused, and what a shekel becomes.
 *
 * Every rejection here is a spec scenario or a SECURITY.md test, not a
 * defensive habit — the happy path is one test and the refusals are a dozen,
 * which is the ratio ARCHITECTURE.md's test policy asks for.
 */
import { describe, expect, it } from "vitest";
import {
  assertWithinAnswerSizeLimit,
  hasDimensions,
  hasTaxonomyAnswers,
  parseAnswers,
  QUESTION_IDS,
} from "./questionnaire";

describe("the shape of the questionnaire", () => {
  it("asks at most seven questions", () => {
    // art-matchmaker: "a questionnaire of at most seven questions".
    expect(QUESTION_IDS.length).toBeLessThanOrEqual(7);
  });

  it("covers every axis the spec enumerates", () => {
    expect(new Set(QUESTION_IDS)).toEqual(
      new Set(["medium", "styles", "palette", "targetSpace", "mood", "budget", "dimensions"]),
    );
  });
});

describe("budget and the wall dimensions are required", () => {
  it("accepts a submission with nothing but a budget", () => {
    // "Buyer skips optional questions -> the system returns ranked matches
    // using the answers provided, without demanding the skipped ones."
    const answers = parseAnswers({ wallHeight: 200, wallWidth: 150, budgetMax: 1200 });

    expect(answers.budgetMaxAgorot).toBe(120_000);
    expect(answers.styles).toEqual([]);
    expect(answers.medium).toBeNull();
    expect(hasTaxonomyAnswers(answers)).toBe(false);
  });

  it("blocks a submission with no budget, and says why", () => {
    // "Budget omitted -> the system blocks submission and explains that budget
    // is required."
    expect(() => parseAnswers({ styles: ["minimalist"] })).toThrowError(
      expect.objectContaining({
        kind: "validation",
        code: "matchmaker.budget_required",
        fields: { budgetMax: ["יש להזין תקציב"] },
      }),
    );
  });

  it("blocks a budget of zero, which is a budget nobody stated", () => {
    expect(() => parseAnswers({ budgetMax: 0 })).toThrowError(
      expect.objectContaining({ kind: "validation" }),
    );
  });

  it("blocks a floor above the ceiling", () => {
    expect(() => parseAnswers({ budgetMin: 5000, budgetMax: 1000 })).toThrowError(
      expect.objectContaining({ code: "matchmaker.budget_invalid" }),
    );
  });

  it("turns shekels into an exact integer count of agorot", () => {
    // SECURITY.md S2-27: a price arriving as a float is how money is corrupted.
    // A budget is compared against a price, so it becomes an integer at the
    // boundary and stays one.
    const answers = parseAnswers({ wallHeight: 200, wallWidth: 150, budgetMax: "1250.55" });

    expect(answers.budgetMaxAgorot).toBe(125_055);
    expect(Number.isInteger(answers.budgetMaxAgorot)).toBe(true);
  });
});

describe("every answer is checked against a closed set", () => {
  it("refuses a style outside the taxonomy rather than dropping it", () => {
    // Dropping would produce a ranking the buyer did not ask for, with nothing
    // telling them so.
    expect(() => parseAnswers({ wallHeight: 200, wallWidth: 150, budgetMax: 1000, styles: ["coastal-minimal"] })).toThrowError(
      expect.objectContaining({ code: "matchmaker.answer_outside_set" }),
    );
  });

  it("refuses a medium, mood, target space and palette outside their sets", () => {
    const budget = { wallHeight: 200, wallWidth: 150, budgetMax: 1000 };

    expect(() => parseAnswers({ ...budget, medium: "sculpture" })).toThrow();
    expect(() => parseAnswers({ ...budget, moods: ["furious"] })).toThrow();
    expect(() => parseAnswers({ ...budget, targetSpaces: ["garage"] })).toThrow();
    expect(() => parseAnswers({ ...budget, palette: "ultraviolet" })).toThrow();
  });

  it("refuses a stuffed multi-select rather than scoring the first few", () => {
    expect(() =>
      parseAnswers({
        wallHeight: 200,
        wallWidth: 150,
        budgetMax: 1000,
        styles: ["minimalist", "abstract", "pop_art", "boho_coastal", "modern_industrial", "minimalist"],
      }),
    ).toThrowError(expect.objectContaining({ code: "matchmaker.answer_outside_set" }));
  });

  it("collapses duplicates instead of double-counting an answer", () => {
    const answers = parseAnswers({ wallHeight: 200, wallWidth: 150, budgetMax: 1000, styles: ["minimalist", "minimalist"] });

    expect(answers.styles).toEqual(["minimalist"]);
  });

  it("accepts a single value where a list is allowed, as a form submits it", () => {
    const answers = parseAnswers({ wallHeight: 200, wallWidth: 150, budgetMax: 1000, styles: "abstract" });

    expect(answers.styles).toEqual(["abstract"]);
  });
});

describe("dimensions", () => {
  it("are both required, because one side alone cannot rank anything", () => {
    // A wall with a height and no width is not a wall we can fit anything to.
    // `sizeScore` needs an area, so a lone dimension leaves the size axis
    // absent — and with the size axis gone the score collapses to tags and a
    // budget, where every matching artwork ties and there is no ranking left.
    // That is the difference between a curator and a filter, so it is refused
    // at the parse boundary rather than scored as a nullable axis.
    expect(() => parseAnswers({ budgetMax: 1000, wallHeight: 200 })).toThrowError(
      expect.objectContaining({ code: "matchmaker.dimensions_required" }),
    );
    expect(() => parseAnswers({ budgetMax: 1000, wallWidth: 150 })).toThrowError(
      expect.objectContaining({ code: "matchmaker.dimensions_required" }),
    );
    expect(
      hasDimensions(parseAnswers({ budgetMax: 1000, wallHeight: 200, wallWidth: 150 })),
    ).toBe(true);
  });

  it("are stored in whole millimetres, matching the artworks column", () => {
    const answers = parseAnswers({ budgetMax: 1000, wallHeight: 220.5, wallWidth: 150 });

    expect(answers.wallHeightMm).toBe(2205);
    expect(answers.wallWidthMm).toBe(1500);
  });

  it("refuses a negative or non-numeric measurement", () => {
    expect(() => parseAnswers({ budgetMax: 1000, wallHeight: -5 })).toThrow();
    expect(() => parseAnswers({ budgetMax: 1000, wallWidth: "wide" })).toThrow();
  });
});

describe("the body size cap", () => {
  it("refuses a body over the limit before anything is parsed", () => {
    // SECURITY.md S2-22: "Post a questionnaire with a 10 MB body... Assert both
    // are rejected before any database scoring query runs." A cap applied after
    // JSON.parse has already paid for the parse.
    const tenMegabytes = "x".repeat(10 * 1024 * 1024);

    expect(() => assertWithinAnswerSizeLimit(tenMegabytes, 4096)).toThrowError(
      expect.objectContaining({ code: "matchmaker.answers_too_large" }),
    );
  });

  it("counts bytes rather than characters, so multi-byte text cannot slip past", () => {
    // Hebrew is two bytes a character in UTF-8. A cap counting `length` would
    // let through twice what it advertises, on the language this site is in.
    const hebrew = "א".repeat(300);

    expect(Buffer.byteLength(hebrew, "utf8")).toBe(600);
    expect(() => assertWithinAnswerSizeLimit(hebrew, 500)).toThrow();
    expect(() => assertWithinAnswerSizeLimit(hebrew, 700)).not.toThrow();
  });
});
