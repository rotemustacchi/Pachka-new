/**
 * The questionnaire, end to end: limit, persist, rank, record, answer honestly.
 *
 * WHAT THIS FUNCTION IS NOT ALLOWED TO DO
 * --------------------------------------
 * Reach an AI provider. Not once, not on a cache miss, not on a cold catalog.
 * ARCHITECTURE.md: "No outbound AI call at query time... If a matchmaker code
 * path can reach an AI provider, it is wrong." Everything this function calls
 * is either pure (`scoring`, `ranking`, `rotation`) or a query against the
 * project's own Postgres (`query-vector`, `candidates`, `impressions`), and
 * `ports.ts` deliberately declares no AI boundary for it to reach through.
 * `tests/integration/matchmaker-no-ai.test.ts` asserts it by installing traps on
 * every outbound primitive in the runtime and running a real query through
 * them.
 *
 * THE ORDER OF OPERATIONS
 * -----------------------
 *   1. Size-cap and parse the answers. SECURITY.md S2-22 item 5 requires both
 *      "before it reaches the scoring function", and this is before the
 *      database is touched at all.
 *   2. Consume the rate limit, on the pool. A refused submission therefore
 *      leaves no `match_queries` row, which is the assertion S2-22 names.
 *   3. Persist the questionnaire. Retention-bounded, server-only.
 *   4. Rank: one catalog query, then pure functions.
 *   5. Record impressions for what is actually being shown — deduplicated, and
 *      never read back by any of step 4.
 *
 * HONEST BEHAVIOUR ON A SPARSE CATALOG IS THE HEADLINE, NOT THE EDGE CASE
 * ----------------------------------------------------------------------
 * PACHKA launches with no artists at all, so the empty and nearly-empty states
 * are what the first visitors literally see. Two things are therefore true of
 * every path out of this function: the result list is never padded to length,
 * and an artwork below the minimum score is never in it. When nothing clears
 * the bar the answer says so plainly and offers the catalog and a notify-me,
 * rather than showing five poor matches and letting the buyer conclude the
 * whole idea does not work.
 */
import {
  catalogHref,
  DEFAULT_SORT,
  NO_FILTERS,
  type CatalogQuery,
} from "@/modules/catalog";
import { agorot, formatAgorot } from "@/shared/money";
import type { Database } from "@/shared/db";
import { fetchCandidates, publishedArtworkCount } from "./candidates";
import { matchmakerSettings, type MatchmakerSettings } from "./config";
import { recordImpressions } from "./impressions";
import { rank } from "./ranking";
import { consumeQuestionnaireRateLimit } from "./rate-limit";
import {
  assertWithinAnswerSizeLimit,
  hasDimensions,
  parseAnswers,
  type Answers,
  type RawAnswers,
} from "./questionnaire";
import { rotationEpochAt, type RotationEpoch } from "./rotation";
import { queryVector } from "./query-vector";
import { scoreArtwork, type ArtworkScore } from "./scoring";

/** One match, as a buyer sees it. */
export interface Match {
  readonly artworkId: string;
  readonly score: number;
  /** Agorot above the stated ceiling. Zero when the piece is within budget. */
  readonly overBudgetByAgorot: number;
  /**
   * The label the view must render, or null. art-matchmaker: an over-budget
   * piece "SHALL be visibly marked as above budget with the amount by which it
   * exceeds it" — the amount, not merely the fact.
   */
  readonly overBudgetLabel: string | null;
}

/** Where a buyer can go from the results (art-matchmaker, "Escape hatch"). */
export interface EscapeHatch {
  /** The full catalog, pre-filtered by the answers they already gave. */
  readonly catalogHref: string;
  /** Whether to offer the notify-me capture. Always true; the spec has no case where it is not. */
  readonly offerNotify: true;
  /** Whether to offer re-answering. Always true, for the same reason. */
  readonly offerRevise: true;
}

export interface MatchOutcome {
  readonly matches: readonly Match[];
  /** The `match_queries` row, so a notify-me can be stored against these answers. */
  readonly queryId: string;
  /** Published and visible artworks right now — including unrankable ones. */
  readonly catalogSize: number;
  /** True when the community is still growing and the buyer should be told so. */
  readonly sparseCatalog: boolean;
  /** True when nothing cleared the minimum score. Distinct from a short list. */
  readonly noMatches: boolean;
  /** The plain message to show, or null when there is nothing to explain. */
  readonly message: string | null;
  readonly escapeHatch: EscapeHatch;
  /** The rotation epoch this ranking belongs to. Reproducible within it. */
  readonly epoch: number;
}

export interface MatchmakerSearchDeps {
  readonly db: Database;
}

export interface SearchInput {
  /** The raw submission. Parsed and size-capped here. */
  readonly answers: RawAnswers;
  /** The raw body, for the size cap. Optional: a typed caller has no string. */
  readonly rawBody?: string;
  /** Already-hashed client identifier for the rate limit. */
  readonly clientFingerprint: string;
  /**
   * Already-hashed viewer identifier for impression dedupe. Usually the same
   * value as the client fingerprint; separate because a signed-in buyer has a
   * session that outlives their address.
   */
  readonly viewerFingerprint: string;
  /** Injectable for tests. Production passes nothing and gets the wall clock. */
  readonly now?: Date;
}

export const SPARSE_CATALOG_MESSAGE =
  "הקהילה שלנו עוד קטנה — אלה העבודות שהכי מתאימות לתשובות שלכם כרגע.";

export const NO_MATCHES_MESSAGE =
  "לא מצאנו עבודה שבאמת מתאימה לתשובות שלכם. אפשר לעיין בכל הקטלוג, לשנות תשובות, או להשאיר כתובת ונעדכן כשיגיע משהו מתאים.";

/**
 * Run a questionnaire.
 *
 * Returns artwork IDS, not artworks. Shaping an artwork for a buyer is
 * `artworks.toPublicArtwork`'s job and nobody else's (ARCHITECTURE.md: artist
 * contact details never leave the server for a buyer-facing response, and
 * `accounts` exposes exactly one serializer). The route hydrates these ids
 * through the catalog's own reads, which already apply that shaping — so this
 * module has no way to leak a column by assembling its own view of an artwork.
 */
export async function runMatchmaker(
  deps: MatchmakerSearchDeps,
  input: SearchInput,
): Promise<MatchOutcome> {
  const settings = await matchmakerSettings(deps.db);

  if (input.rawBody !== undefined) {
    assertWithinAnswerSizeLimit(input.rawBody, settings.maxAnswerBytes);
  }
  const answers = parseAnswers(input.answers);

  // Before the questionnaire row and before the catalog query: a refused
  // submission must cost the database nothing and leave nothing behind.
  await consumeQuestionnaireRateLimit(deps.db, input.clientFingerprint);

  const epoch = rotationEpochAt(input.now ?? new Date(), settings.rotationEpochHours);
  const queryId = await persistQuery(deps.db, answers, input.clientFingerprint);

  const [vector, catalogSize] = await Promise.all([
    queryVector(deps.db, answers),
    publishedArtworkCount(deps.db),
  ]);

  const candidates = await fetchCandidates(deps.db, {
    vector,
    poolSize: settings.candidatePoolSize,
    timeoutMs: settings.queryTimeoutMs,
  });

  const scored: readonly ArtworkScore[] = candidates.map((candidate) =>
    scoreArtwork(candidate, answers, {
      weights: settings.weights,
      overBudgetTolerance: settings.overBudgetTolerance,
      idealWallOccupancy: settings.idealWallOccupancy,
      freshnessHalfLifeDays: settings.freshnessHalfLifeDays,
      clock: epoch.startedAt,
    }),
  );

  const ranked = rank(scored, settings, epoch);
  const matches = ranked.map(toMatch);

  await deps.db.query("update match_queries set result_count = $2 where id = $1", [
    queryId,
    matches.length,
  ]);

  // Recorded for what is actually shown, after ranking, and never read by it.
  await recordImpressions(
    deps.db,
    matches.map((match) => match.artworkId),
    input.viewerFingerprint,
    input.now ?? new Date(),
  );

  return {
    matches,
    queryId,
    catalogSize,
    ...honesty(matches.length, catalogSize, settings),
    escapeHatch: {
      catalogHref: catalogHref(catalogQueryFor(answers)),
      offerNotify: true,
      offerRevise: true,
    },
    epoch: epoch.index,
  };
}

/**
 * What to tell the buyer about the size of what they are looking at.
 *
 * Two separate triggers, because the spec states two: "when fewer results are
 * returned than requested, OR when the total published catalog is below the
 * configured sparse threshold". A catalog of four pieces that happens to
 * produce five good matches is still a catalog of four pieces.
 */
function honesty(
  shown: number,
  catalogSize: number,
  settings: MatchmakerSettings,
): { readonly sparseCatalog: boolean; readonly noMatches: boolean; readonly message: string | null } {
  const noMatches = shown === 0;
  const sparseCatalog =
    catalogSize < settings.sparseCatalogThreshold || shown < settings.resultCount;

  if (noMatches) return { sparseCatalog, noMatches, message: NO_MATCHES_MESSAGE };
  if (sparseCatalog) return { sparseCatalog, noMatches, message: SPARSE_CATALOG_MESSAGE };
  return { sparseCatalog, noMatches, message: null };
}

function toMatch(scored: ArtworkScore): Match {
  return {
    artworkId: scored.artworkId,
    score: scored.score,
    overBudgetByAgorot: scored.overBudgetByAgorot,
    overBudgetLabel:
      scored.overBudgetByAgorot > 0
        ? `${formatAgorot(agorot(scored.overBudgetByAgorot))} מעל התקציב`
        : null,
  };
}

/**
 * The pre-filtered catalog the escape hatch points at.
 *
 * The buyer's answers become catalog filters, so "browse the full catalog"
 * lands somewhere shaped by what they already told us rather than at the
 * undifferentiated front page. Budget becomes a price ceiling only — the floor
 * is a ranking signal here and would be a hard cut there, and silently applying
 * it would hide work the matchmaker itself was willing to show.
 */
export function catalogQueryFor(answers: Answers): CatalogQuery {
  return {
    filters: {
      ...NO_FILTERS,
      media: answers.medium === null ? [] : [answers.medium],
      styles: [...answers.styles],
      targetSpaces: [...answers.targetSpaces],
      moods: [...answers.moods],
      minPriceAgorot: null,
      maxPriceAgorot: agorot(answers.budgetMaxAgorot),
    },
    sort: DEFAULT_SORT,
    page: 1,
  };
}

async function persistQuery(
  db: Database,
  answers: Answers,
  clientFingerprint: string,
): Promise<string> {
  const row = await db.one<{ id: string }>(
    `insert into match_queries
       (budget_min_agorot, budget_max_agorot, wall_height_mm, wall_width_mm,
        medium, styles, target_spaces, moods, palette, client_fingerprint)
     values ($1, $2, $3, $4, $5, $6::text[], $7::text[], $8::text[], $9, $10)
     returning id`,
    [
      answers.budgetMinAgorot,
      answers.budgetMaxAgorot,
      answers.wallHeightMm,
      answers.wallWidthMm,
      answers.medium,
      [...answers.styles],
      [...answers.targetSpaces],
      [...answers.moods],
      answers.palette,
      clientFingerprint,
    ],
  );
  return row.id;
}

/** Re-exported so a caller can ask about the epoch without importing two files. */
export function currentEpoch(at: Date, periodHours: number): RotationEpoch {
  return rotationEpochAt(at, periodHours);
}

/** Whether the buyer gave dimensions — the view labels the size axis only then. */
export { hasDimensions };
