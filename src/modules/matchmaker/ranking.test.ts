/**
 * Ranking: never padded, never below the minimum, and a clear winner stays put.
 *
 * These are the three things the spec is least willing to compromise on, and
 * all three are properties of one pure function, so they are tested here rather
 * than only through the database — where a failure would be harder to read and
 * a passing test would prove less.
 */
import { describe, expect, it } from "vitest";
import { rank, type RankingSettings } from "./ranking";
import { rotationEpochAt } from "./rotation";
import type { ArtworkScore } from "./scoring";

const SETTINGS: RankingSettings = {
  minimumScore: 0.35,
  tieTolerance: 0.02,
  resultCount: 5,
};

const EPOCH = rotationEpochAt(new Date("2026-09-01T00:00:00.000Z"), 24);

let counter = 0;
function scored(score: number, id?: string): ArtworkScore {
  counter += 1;
  const suffix = String(counter).padStart(12, "0");
  return {
    artworkId: id ?? `aaaaaaaa-0000-4000-8000-${suffix}`,
    score,
    components: { embedding: null, taxonomy: null, budget: 1, size: null, freshness: 1 },
    overBudgetByAgorot: 0,
    excludedForBudget: false,
  };
}

describe("results are never padded", () => {
  it("returns exactly two when only two clear the minimum and the count is five", () => {
    // art-matchmaker, "Results are never padded", stated as its own scenario
    // because the tempting implementation — take the top five whatever they
    // score — passes every other test in this file.
    const result = rank(
      [scored(0.8), scored(0.7), scored(0.2), scored(0.1), scored(0.05), scored(0.0)],
      SETTINGS,
      EPOCH,
    );

    expect(result).toHaveLength(2);
    expect(result.every((match) => match.score >= SETTINGS.minimumScore)).toBe(true);
  });

  it("returns nothing at all when nothing clears the minimum", () => {
    const result = rank([scored(0.34), scored(0.2), scored(0.01)], SETTINGS, EPOCH);

    expect(result).toEqual([]);
  });

  it("includes an artwork exactly at the minimum, and excludes one just below", () => {
    const result = rank([scored(0.35), scored(0.349999)], SETTINGS, EPOCH);

    expect(result).toHaveLength(1);
    expect(result[0]?.score).toBe(0.35);
  });

  it("truncates to the result count when more than enough qualify", () => {
    const result = rank(
      [scored(0.9), scored(0.85), scored(0.8), scored(0.75), scored(0.7), scored(0.65)],
      SETTINGS,
      EPOCH,
    );

    expect(result).toHaveLength(5);
  });

  it("drops an artwork excluded for budget even when it scores well", () => {
    const overBudget: ArtworkScore = { ...scored(0.95), excludedForBudget: true };
    const result = rank([overBudget, scored(0.5)], SETTINGS, EPOCH);

    expect(result).toHaveLength(1);
    expect(result[0]?.artworkId).not.toBe(overBudget.artworkId);
  });
});

describe("a clear winner is not displaced", () => {
  it("stays first in every epoch across a month", () => {
    // art-matchmaker: "one artwork scores well outside the tie tolerance above
    // all others -> it is ranked first regardless of the rotation epoch."
    const winner = scored(0.95, "ffffffff-1111-4111-8111-ffffffffffff");
    const rest = [
      scored(0.6, "11111111-1111-4111-8111-111111111111"),
      scored(0.59, "22222222-2222-4222-8222-222222222222"),
      scored(0.58, "33333333-3333-4333-8333-333333333333"),
    ];

    for (let day = 0; day < 30; day += 1) {
      const epoch = rotationEpochAt(new Date(Date.UTC(2026, 8, 1 + day)), 24);
      const result = rank([...rest, winner], SETTINGS, epoch);

      expect(result[0]?.artworkId).toBe(winner.artworkId);
    }
  });

  it("does not let a smooth score distribution chain into one tie band", () => {
    // The bug this catches: banding each item against its PREDECESSOR rather
    // than against the band leader. With a tolerance of 0.02 the top three
    // below are each genuinely within tolerance of the 0.90 and may rotate
    // among themselves — that is the feature. The 0.87 is 0.03 below the
    // leader and must never reach the top, but pairwise chaining would merge
    // all four into one band spanning 0.09 and let it. A real catalog has
    // exactly this shape, which is why this is not a contrived case.
    const leader = scored(0.9, "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa");
    const alsoTied = [
      scored(0.89, "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb"),
      scored(0.88, "cccccccc-3333-4333-8333-cccccccccccc"),
    ];
    const outsideTheBand = scored(0.87, "dddddddd-4444-4444-8444-dddddddddddd");
    const topBand = new Set([leader.artworkId, ...alsoTied.map((a) => a.artworkId)]);

    for (let day = 0; day < 30; day += 1) {
      const epoch = rotationEpochAt(new Date(Date.UTC(2026, 8, 1 + day)), 24);
      const result = rank([...alsoTied, outsideTheBand, leader], SETTINGS, epoch);

      expect(topBand.has(result[0]?.artworkId ?? "")).toBe(true);
      expect(result[3]?.artworkId).toBe(outsideTheBand.artworkId);
    }
  });

  it("keeps an artwork outside the tie tolerance below the whole band, every epoch", () => {
    // The scenario stated the way the spec states it: one artwork well outside
    // the tolerance ABOVE all others is ranked first regardless of the epoch.
    const winner = scored(0.95, "ffffffff-5555-4555-8555-ffffffffffff");
    const band = [
      scored(0.7, "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa"),
      scored(0.695, "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb"),
      scored(0.69, "cccccccc-3333-4333-8333-cccccccccccc"),
    ];

    for (let day = 0; day < 30; day += 1) {
      const epoch = rotationEpochAt(new Date(Date.UTC(2026, 8, 1 + day)), 24);

      expect(rank([...band, winner], SETTINGS, epoch)[0]?.artworkId).toBe(winner.artworkId);
    }
  });
});

describe("ordering is reproducible within an epoch and rotates between them", () => {
  const tied = [
    scored(0.7, "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa"),
    scored(0.69, "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb"),
    scored(0.685, "cccccccc-3333-4333-8333-cccccccccccc"),
  ];

  it("gives the identical order every time within one epoch", () => {
    const first = rank(tied, SETTINGS, EPOCH).map((match) => match.artworkId);
    const again = rank([...tied].reverse(), SETTINGS, EPOCH).map((match) => match.artworkId);

    // Reversed input, identical output: the order depends on the epoch and the
    // ids, not on what order the database happened to return them in.
    expect(again).toEqual(first);
  });

  it("produces more than one ordering across a month of epochs", () => {
    const orderings = new Set<string>();
    for (let day = 0; day < 30; day += 1) {
      const epoch = rotationEpochAt(new Date(Date.UTC(2026, 8, 1 + day)), 24);
      orderings.add(rank(tied, SETTINGS, epoch).map((match) => match.artworkId).join(","));
    }

    expect(orderings.size).toBeGreaterThan(1);
  });

  it("does not reorder when the epoch has not advanced", () => {
    const morning = rotationEpochAt(new Date("2026-09-01T07:00:00.000Z"), 24);
    const evening = rotationEpochAt(new Date("2026-09-01T22:00:00.000Z"), 24);

    expect(rank(tied, SETTINGS, morning).map((m) => m.artworkId)).toEqual(
      rank(tied, SETTINGS, evening).map((m) => m.artworkId),
    );
  });
});
