/**
 * The scoring function's properties, tested where they live: in a pure
 * function, with no database and no clock.
 *
 * These are the assertions that would still matter if the SQL were rewritten
 * tomorrow. The blend's denominator, the budget curve's shape, and the size
 * tent's peak are product decisions, and a change to any of them should have to
 * argue with a failing test rather than slip through as a tuning tweak.
 */
import { describe, expect, it } from "vitest";
import type { ScoringWeights } from "./config";
import { parseAnswers, type Answers } from "./questionnaire";
import {
  blend,
  budgetScore,
  freshnessScore,
  scoreArtwork,
  sizeScore,
  taxonomyScore,
  type ComponentScores,
  type ScorableArtwork,
} from "./scoring";

const WEIGHTS: ScoringWeights = {
  embedding: 0.45,
  taxonomy: 0.25,
  budget: 0.15,
  size: 0.1,
  freshness: 0.05,
};

const EPOCH_START = new Date("2026-09-01T00:00:00.000Z");

function answers(overrides: Partial<Answers> = {}): Answers {
  return {
    medium: null,
    styles: [],
    palette: null,
    targetSpaces: [],
    moods: [],
    budgetMinAgorot: null,
    budgetMaxAgorot: 100_000,
    wallHeightMm: null,
    wallWidthMm: null,
    ...overrides,
  };
}

function artwork(overrides: Partial<ScorableArtwork> = {}): ScorableArtwork {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    priceAgorot: 50_000,
    medium: "painting_illustration",
    styles: ["minimalist"],
    targetSpaces: ["living_room"],
    moods: ["calm"],
    heightMm: 700,
    widthMm: 500,
    publishedAt: EPOCH_START,
    cosineSimilarity: 0,
    ...overrides,
  };
}

describe("budget is a ranking signal, not a hard cut", () => {
  it("scores a piece inside the stated range at the maximum", () => {
    const result = budgetScore(90_000, answers(), 0.15);
    expect(result).toEqual({ score: 1, overByAgorot: 0, excluded: false });
  });

  it("still scores a piece above the ceiling, and reports the amount over", () => {
    // 20% over on a ₪1,000 ceiling, with a 25% tolerance: it appears, marked.
    const result = budgetScore(120_000, answers(), 0.25);

    expect(result.excluded).toBe(false);
    expect(result.overByAgorot).toBe(20_000);
    expect(result.score).toBeGreaterThan(0);
    expect(result.score).toBeLessThan(1);
  });

  it("excludes a piece beyond the tolerance whatever else it scores", () => {
    const result = budgetScore(120_000, answers(), 0.15);

    expect(result.excluded).toBe(true);
    expect(result.overByAgorot).toBe(20_000);
  });

  it("decays linearly to zero at the tolerance boundary", () => {
    const tolerance = 0.2;
    const atTheEdge = budgetScore(120_000, answers(), tolerance);
    const halfway = budgetScore(110_000, answers(), tolerance);

    expect(atTheEdge.score).toBeCloseTo(0, 10);
    expect(halfway.score).toBeCloseTo(0.5, 10);
  });

  it("penalises being far under a stated floor, but never below one half", () => {
    const withFloor = answers({ budgetMinAgorot: 80_000 });

    expect(budgetScore(80_000, withFloor, 0.15).score).toBe(1);
    expect(budgetScore(40_000, withFloor, 0.15).score).toBeCloseTo(0.75, 10);
    expect(budgetScore(1, withFloor, 0.15).score).toBeGreaterThanOrEqual(0.5);
  });
});

describe("taxonomy overlap is averaged over the answered axes only", () => {
  it("is null when the buyer answered no taxonomy question at all", () => {
    expect(taxonomyScore(artwork(), answers())).toBeNull();
  });

  it("does not dilute one answered axis with three unanswered ones", () => {
    // The buyer named a style and skipped everything else. A perfect style
    // match is a perfect taxonomy score — averaging it against three zeroes
    // would make it 0.25 and punish them for answering fewer questions.
    const score = taxonomyScore(artwork(), answers({ styles: ["minimalist"] }));

    expect(score).toBe(1);
  });

  it("scores partial overlap as the fraction of the buyer's answers that were met", () => {
    const score = taxonomyScore(
      artwork({ styles: ["minimalist"] }),
      answers({ styles: ["minimalist", "abstract"] }),
    );

    expect(score).toBe(0.5);
  });

  it("averages across axes when several were answered", () => {
    // Medium matches (1), mood does not (0).
    const score = taxonomyScore(
      artwork({ medium: "photography", moods: ["calm"] }),
      answers({ medium: "photography", moods: ["edgy"] }),
    );

    expect(score).toBe(0.5);
  });
});

describe("size fit is a tent, not a ladder", () => {
  const wall = answers({ wallHeightMm: 2000, wallWidthMm: 2000 });

  it("is null when the buyer skipped the dimensions question", () => {
    expect(sizeScore(artwork(), answers(), 0.6)).toBeNull();
  });

  it("scores a piece that does not physically fit at zero", () => {
    expect(sizeScore(artwork({ heightMm: 2100, widthMm: 500 }), wall, 0.6)).toBe(0);
  });

  it("peaks at the ideal occupancy and falls away on BOTH sides", () => {
    const wallArea = 2000 * 2000;
    const at = (occupancy: number) => {
      const side = Math.round(Math.sqrt(wallArea * occupancy));
      return sizeScore(artwork({ heightMm: side, widthMm: side }), wall, 0.6) ?? -1;
    };

    const peak = at(0.6);
    expect(peak).toBeCloseTo(1, 2);
    // A stamp on a large wall and a piece that swallows it are both wrong, and
    // wrong in opposite directions. A monotone "bigger is better" score cannot
    // say that, which is the whole reason this is a tent.
    expect(at(0.1)).toBeLessThan(peak);
    expect(at(0.95)).toBeLessThan(peak);
  });
});

describe("freshness is measured from the clock it is handed", () => {
  it("is exactly one half at the half-life", () => {
    const published = new Date(EPOCH_START.getTime() - 30 * 24 * 60 * 60 * 1000);

    expect(freshnessScore(artwork({ publishedAt: published }), EPOCH_START, 30)).toBeCloseTo(0.5, 10);
  });

  it("does not move when the same clock is passed twice", () => {
    const published = new Date(EPOCH_START.getTime() - 12 * 24 * 60 * 60 * 1000);
    const piece = artwork({ publishedAt: published });

    // This is what makes reproducibility within an epoch true by construction
    // rather than true to the resolution of the wall clock.
    expect(freshnessScore(piece, EPOCH_START, 30)).toBe(freshnessScore(piece, EPOCH_START, 30));
  });
});

describe("the blend renormalises over the components that are present", () => {
  const full: ComponentScores = {
    embedding: 1,
    taxonomy: 1,
    budget: 1,
    size: 1,
    freshness: 1,
  };

  it("returns one when every present component is one", () => {
    expect(blend(full, WEIGHTS)).toBe(1);
    expect(blend({ ...full, embedding: null, size: null }, WEIGHTS)).toBe(1);
  });

  it("does not penalise a buyer for a question they skipped", () => {
    // Same artwork, same answers, except the buyer skipped dimensions. If the
    // absent component scored zero, this buyer would lose a tenth of every
    // score for answering fewer questions — which on a nine-piece catalog is
    // the difference between three matches and the no-matches state.
    const answered: ComponentScores = { ...full, size: 0.4 };
    const skipped: ComponentScores = { ...full, size: null };

    expect(blend(skipped, WEIGHTS)).toBeGreaterThan(blend(answered, WEIGHTS));
    expect(blend(skipped, WEIGHTS)).toBe(1);
  });

  it("weights the components in the configured proportion", () => {
    const onlyEmbeddingPerfect: ComponentScores = {
      embedding: 1,
      taxonomy: 0,
      budget: 0,
      size: 0,
      freshness: 0,
    };

    // 0.45 / (0.45 + 0.25 + 0.15 + 0.10 + 0.05) = 0.45
    expect(blend(onlyEmbeddingPerfect, WEIGHTS)).toBeCloseTo(0.45, 10);
  });

  it("ignores a component whose weight is zero rather than diluting by it", () => {
    const noEmbeddingWeight: ScoringWeights = { ...WEIGHTS, embedding: 0 };
    const components: ComponentScores = { ...full, embedding: 0 };

    expect(blend(components, noEmbeddingWeight)).toBe(1);
  });
});

describe("scoreArtwork", () => {
  const context = {
    weights: WEIGHTS,
    overBudgetTolerance: 0.15,
    idealWallOccupancy: 0.6,
    freshnessHalfLifeDays: 30,
    clock: EPOCH_START,
  };

  it("is deterministic: the same inputs give a bit-identical result", () => {
    const piece = artwork({ cosineSimilarity: 0.42 });
    const asked = answers({ styles: ["minimalist"] });

    expect(scoreArtwork(piece, asked, context)).toEqual(scoreArtwork(piece, asked, context));
  });

  it("flags a far-over-budget piece for exclusion without hiding its score", () => {
    const result = scoreArtwork(artwork({ priceAgorot: 500_000 }), answers(), context);

    expect(result.excludedForBudget).toBe(true);
    expect(result.overBudgetByAgorot).toBe(400_000);
  });

  it("scores without an embedding rather than refusing to score", () => {
    // The sparse-catalog case: nothing matched the answers, so there is no
    // centroid to compare against. The buyer still gets a ranking on the axes
    // that do exist.
    const result = scoreArtwork(artwork({ cosineSimilarity: null }), answers(), context);

    expect(result.components.embedding).toBeNull();
    expect(result.score).toBeGreaterThan(0);
  });

  it("rejects an answer outside the closed set before it can be scored", () => {
    expect(() => parseAnswers({ budgetMax: 1000, styles: ["coastal-minimal"] })).toThrow(
      /not a permitted styles answer/,
    );
  });
});
