/**
 * The scoring function. Five components, configurable weights, no model call.
 *
 * art-matchmaker, "Ranking without per-query model calls": "rank published
 * artworks against the buyer's answers using precomputed artwork embeddings and
 * stored taxonomy values, combined by a scoring function evaluated within the
 * platform."
 *
 * THE SHAPE
 * ---------
 *   score = Σ wᵢ·cᵢ  /  Σ wᵢ      over the components that are PRESENT
 *
 * with every cᵢ in [0, 1] and the weights from `app_config`:
 *
 *   c_embed  (0.45)  (1 + cosine(artwork, query)) / 2
 *   c_tax    (0.25)  mean over ANSWERED axes of |answered ∩ artwork| / |answered|
 *   c_budget (0.15)  1 inside the range, decaying to 0 at the over-budget tolerance
 *   c_size   (0.10)  a tent peaking where the piece covers the ideal share of the wall
 *   c_fresh  (0.05)  halfLife / (halfLife + ageDays), measured from the EPOCH START
 *
 * WHY THE DENOMINATOR IS "PRESENT COMPONENTS" AND NOT ONE
 * ------------------------------------------------------
 * Every question but budget is optional, so a buyer can legitimately give us
 * nothing to compute c_tax or c_size from. The two obvious ways to handle that
 * are both wrong in ways that show up on a sparse catalog:
 *
 *   - Score an absent component 0. A buyer who skipped the dimensions question
 *     would then see every artwork lose ten percent of its score, and on a
 *     catalog of nine pieces that is the difference between "here are three
 *     matches" and the no-matches state. The buyer would be punished for
 *     answering fewer questions, which is precisely what the spec's "without
 *     demanding the skipped ones" forbids.
 *   - Score an absent component 0.5, or any other neutral. That is a claim
 *     about an artwork nobody made, and it compresses the range every other
 *     component is measured against.
 *
 * Renormalising over what was actually asked keeps the minimum score meaning
 * the same thing for every buyer: 0.35 is "a third of the way up the axes we
 * could evaluate", whether that was five axes or three.
 *
 * WHY EVERY TIME-DEPENDENT TERM IS MEASURED FROM THE EPOCH START
 * -------------------------------------------------------------
 * "The same answers submitted twice against an unchanged catalog within the
 * same rotation epoch" must return "the same artworks in the same order".
 * Freshness against `now()` makes that true only to the resolution of the
 * clock; freshness against the epoch start makes it true by construction, and
 * ties the one moving part in the score to the one thing the spec already says
 * is allowed to move. See `rotation.ts`.
 *
 * WHAT IS NOT HERE
 * ----------------
 * There is no impression count, no view count, no sales count and no artist
 * reputation term, and the signature of `scoreArtwork` is where you can check
 * that rather than take my word for it: there is no parameter one could arrive
 * through. SECURITY.md S2-23.
 */
import type { Medium, Mood, Style, TargetSpace } from "@/modules/artworks";
import type { ScoringWeights } from "./config";
import type { Answers } from "./questionnaire";

/**
 * Everything the score is computed from, for one artwork.
 *
 * Deliberately a flat value type rather than an `Artwork`: it is the exact list
 * of facts the ranking is allowed to see, and a reviewer can read it in one
 * screen. Adding a field here is a decision; passing a whole row would not be.
 */
export interface ScorableArtwork {
  readonly id: string;
  readonly priceAgorot: number;
  readonly medium: Medium | null;
  readonly styles: readonly Style[];
  readonly targetSpaces: readonly TargetSpace[];
  readonly moods: readonly Mood[];
  readonly heightMm: number | null;
  readonly widthMm: number | null;
  readonly publishedAt: Date | null;
  /**
   * Cosine similarity to the query vector, in [-1, 1], or null when there is no
   * query vector to compare against — see `query-vector.ts` for when that
   * happens and why it is a normal state rather than a failure.
   */
  readonly cosineSimilarity: number | null;
}

/** The tuning the score needs beyond the weights themselves. */
export interface ScoringContext {
  readonly weights: ScoringWeights;
  readonly overBudgetTolerance: number;
  readonly idealWallOccupancy: number;
  readonly freshnessHalfLifeDays: number;
  /** The start of the current rotation epoch. Every age is measured from here. */
  readonly clock: Date;
}

/** One component of the blend, kept separately so the UI can explain a match. */
export interface ComponentScores {
  readonly embedding: number | null;
  readonly taxonomy: number | null;
  readonly budget: number;
  readonly size: number | null;
  readonly freshness: number;
}

export interface ArtworkScore {
  readonly artworkId: string;
  /** The blended score in [0, 1], rounded — see `round6`. */
  readonly score: number;
  readonly components: ComponentScores;
  /** Agorot by which the price exceeds the stated ceiling; 0 when within it. */
  readonly overBudgetByAgorot: number;
  /**
   * True when the piece is priced beyond the configured tolerance and must not
   * be shown at all, whatever else it scores (art-matchmaker, "Far above
   * budget").
   */
  readonly excludedForBudget: boolean;
  /**
   * True when the buyer named taxonomy preferences and this artwork matches
   * none of them. Such a piece must not be shown whatever it scores elsewhere:
   * a buyer who asked for minimalist and calm has not been curated for if they
   * are handed pop art because it happens to fit the wall and the budget.
   *
   * Kept distinct from a low taxonomy score. Matching one axis weakly is a
   * worse match; matching nothing the buyer asked for is a different kind of
   * answer, and the blend cannot express that because the other components
   * carry it — the pop-art piece this was written for scored 0.48 on budget,
   * size and freshness alone, comfortably above the minimum.
   */
  readonly excludedForTaxonomy: boolean;
}

const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Round to six decimal places.
 *
 * Not cosmetic. The cosine similarity arrives from Postgres as a float computed
 * over a sum whose order is not guaranteed to be identical between two
 * executions of the same query — parallel workers may aggregate in a different
 * order. The difference is around 1e-15; rounding to 1e-6 puts it below the
 * resolution of anything downstream, so "identical answers return identical
 * ordering" cannot be broken by a query plan changing under us.
 */
export function round6(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

const clamp01 = (value: number): number => (value < 0 ? 0 : value > 1 ? 1 : value);

/**
 * How close the price is to what the buyer said they would spend.
 *
 * art-matchmaker, "Budget is a ranking signal, not a hard cut": above-budget
 * work "MAY appear when they score highly on other axes", and is excluded only
 * "more than the configured over-budget tolerance above the stated budget".
 * So this returns a score and a flag, never a filtered list — the filtering
 * decision belongs to the caller, where it is visible.
 *
 * Under budget is not free either, but it is nearly free: a piece at half the
 * stated floor is a different kind of object from the one the buyer described,
 * and the floor at 0.5 stops that from ever being the reason a match is
 * dropped.
 */
export function budgetScore(
  priceAgorot: number,
  answers: Answers,
  overBudgetTolerance: number,
): { readonly score: number; readonly overByAgorot: number; readonly excluded: boolean } {
  const ceiling = answers.budgetMaxAgorot;
  const floor = answers.budgetMinAgorot;

  if (priceAgorot > ceiling) {
    const overByAgorot = priceAgorot - ceiling;
    const excess = overByAgorot / ceiling;
    if (excess > overBudgetTolerance) {
      return { score: 0, overByAgorot, excluded: true };
    }
    // Linear to zero at the tolerance boundary: a piece 1% over is nearly as
    // good as one inside the range, one at the edge of tolerance is carried
    // entirely by its other axes.
    const score = overBudgetTolerance === 0 ? 0 : clamp01(1 - excess / overBudgetTolerance);
    return { score, overByAgorot, excluded: false };
  }

  if (floor !== null && floor > 0 && priceAgorot < floor) {
    const shortfall = (floor - priceAgorot) / floor;
    return { score: clamp01(1 - 0.5 * shortfall), overByAgorot: 0, excluded: false };
  }

  return { score: 1, overByAgorot: 0, excluded: false };
}

/**
 * Overlap between the answers given and the artwork's classification.
 *
 * Averaged over ANSWERED axes rather than over all four, for the same reason
 * the blend renormalises: a buyer who named a style and skipped the mood
 * question has not expressed indifference about mood, they have declined to
 * say, and averaging their one answer against three zeroes would turn a perfect
 * style match into 0.25.
 *
 * Returns null when nothing on this axis group was answered, which the blend
 * reads as "not present" rather than as zero.
 */
export function taxonomyScore(artwork: ScorableArtwork, answers: Answers): number | null {
  const axes: number[] = [];

  if (answers.medium !== null) {
    axes.push(artwork.medium === answers.medium ? 1 : 0);
  }
  if (answers.styles.length > 0) {
    axes.push(overlapFraction(answers.styles, artwork.styles));
  }
  if (answers.targetSpaces.length > 0) {
    axes.push(overlapFraction(answers.targetSpaces, artwork.targetSpaces));
  }
  if (answers.moods.length > 0) {
    axes.push(overlapFraction(answers.moods, artwork.moods));
  }

  if (axes.length === 0) return null;
  return axes.reduce((total, value) => total + value, 0) / axes.length;
}

function overlapFraction<T extends string>(answered: readonly T[], present: readonly T[]): number {
  if (answered.length === 0) return 0;
  const set = new Set<string>(present);
  const hits = answered.filter((value) => set.has(value)).length;
  return hits / answered.length;
}

/**
 * How well the piece suits the space the buyer measured.
 *
 * A tent function peaking at `idealWallOccupancy`: a stamp on a large wall and
 * a piece that covers it entirely are both wrong, and they are wrong in
 * opposite directions, which a monotone "bigger is better" score cannot say.
 * A piece that does not physically fit scores zero — but is NOT excluded, since
 * budget is the only exclusion the spec defines, and a buyer who measured the
 * alcove may still want the piece for a different wall.
 *
 * Returns null when the buyer skipped the dimensions question.
 */
export function sizeScore(
  artwork: ScorableArtwork,
  answers: Answers,
  idealWallOccupancy: number,
): number | null {
  const wallHeight = answers.wallHeightMm;
  const wallWidth = answers.wallWidthMm;
  if (wallHeight === null || wallWidth === null) return null;
  if (artwork.heightMm === null || artwork.widthMm === null) return 0;
  if (artwork.heightMm > wallHeight || artwork.widthMm > wallWidth) return 0;

  const wallArea = wallHeight * wallWidth;
  if (wallArea <= 0) return null;

  const occupancy = (artwork.heightMm * artwork.widthMm) / wallArea;
  const ideal = idealWallOccupancy;
  if (occupancy <= ideal) return clamp01(occupancy / ideal);
  if (ideal >= 1) return 1;
  return clamp01((1 - occupancy) / (1 - ideal));
}

/**
 * Recency, as a half-life rather than a cliff.
 *
 * `halfLife / (halfLife + age)`: exactly 1 the day it is published, exactly 0.5
 * at the half-life, and approaching but never reaching zero after that — so an
 * older piece is quieter rather than invisible, which matters a great deal on a
 * catalog whose oldest work is also, for a while, most of it.
 *
 * Measured from the epoch start, not from `now()`. See the file header.
 */
export function freshnessScore(
  artwork: ScorableArtwork,
  clock: Date,
  halfLifeDays: number,
): number {
  if (artwork.publishedAt === null) return 0;
  const ageDays = Math.max(
    0,
    (clock.getTime() - artwork.publishedAt.getTime()) / MILLISECONDS_PER_DAY,
  );
  return clamp01(halfLifeDays / (halfLifeDays + ageDays));
}

/** Cosine in [-1, 1] mapped onto [0, 1], so it blends with the other four. */
export function embeddingScore(artwork: ScorableArtwork): number | null {
  if (artwork.cosineSimilarity === null) return null;
  return clamp01((1 + artwork.cosineSimilarity) / 2);
}

/**
 * Blend the components that are present.
 *
 * Exported so the property that matters can be tested directly: the weights are
 * relative, the denominator is the weight actually applied, and an absent
 * component neither contributes nor penalises.
 */
export function blend(components: ComponentScores, weights: ScoringWeights): number {
  const terms: Array<readonly [number | null, number]> = [
    [components.embedding, weights.embedding],
    [components.taxonomy, weights.taxonomy],
    [components.budget, weights.budget],
    [components.size, weights.size],
    [components.freshness, weights.freshness],
  ];

  let weighted = 0;
  let applied = 0;
  for (const [value, weight] of terms) {
    if (value === null || weight <= 0) continue;
    weighted += value * weight;
    applied += weight;
  }

  if (applied === 0) return 0;
  return round6(clamp01(weighted / applied));
}

/**
 * Score one artwork. Pure: same inputs, same output, forever.
 *
 * Note what is absent from the parameter list. There is no database handle, no
 * fetch, no clock read, and no impression count. A query-time model call cannot
 * be added to the ranking without changing this signature, which is the point
 * of it being shaped this way.
 */
export function scoreArtwork(
  artwork: ScorableArtwork,
  answers: Answers,
  context: ScoringContext,
): ArtworkScore {
  const budget = budgetScore(artwork.priceAgorot, answers, context.overBudgetTolerance);

  const components: ComponentScores = {
    embedding: embeddingScore(artwork),
    taxonomy: taxonomyScore(artwork, answers),
    budget: budget.score,
    size: sizeScore(artwork, answers, context.idealWallOccupancy),
    freshness: freshnessScore(artwork, context.clock, context.freshnessHalfLifeDays),
  };

  return {
    artworkId: artwork.id,
    score: blend(components, context.weights),
    components,
    overBudgetByAgorot: budget.overByAgorot,
    excludedForBudget: budget.excluded,
    excludedForTaxonomy: components.taxonomy === 0,
  };
}
