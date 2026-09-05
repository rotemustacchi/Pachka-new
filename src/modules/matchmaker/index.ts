/**
 * `matchmaker` — PACHKA's defining feature: a short questionnaire that returns a
 * small ranked set of artworks, ranked entirely inside Postgres.
 *
 * This file is the module's entire surface. ARCHITECTURE.md: nothing outside a
 * module may import a deeper path than its `index.ts`.
 *
 * THE ONE THING TO KNOW BEFORE READING ANY OF IT
 * ---------------------------------------------
 * NO OUTBOUND AI CALL AT QUERY TIME. Not on a cache miss, not on a cold
 * catalog, not once. `uploads` computes an embedding per artwork at upload, and
 * this module turns the buyer's answers into a query vector by taking the
 * CENTROID of the stored embeddings of the artworks matching those answers —
 * one `avg()` inside the database, reaching nothing outside it. That is what
 * keeps AI spend proportional to the number of artworks rather than to traffic,
 * on an anonymous endpoint that is the cheapest thing in the system to script.
 * `ports.ts` declares no AI boundary, so there is nothing here to call one
 * through, and `matchmaker-no-ai.test.ts` traps every outbound primitive in the
 * runtime and runs a real query through the traps.
 *
 * THE SECOND THING: IMPRESSIONS ARE NOT A RANKING INPUT
 * ----------------------------------------------------
 * `tasks.md` 6.10 and `app_config`'s description of `matchmaker.tie_tolerance`
 * both still say ties are "ordered by ascending lifetime impressions". Both
 * predate the security review, and SECURITY.md S2-23 is that review: an
 * impression count is incremented by anonymous strangers, so ranking on it
 * hands an attacker a control that demotes a rival. Ties are broken by a keyed
 * hash of (rotation epoch, artwork id) and nothing else — reproducible inside
 * an epoch, a fresh permutation when it advances, and untouchable by anyone.
 * Reported to the lead architect, not resolved silently.
 *
 * FOR THE MODULES AND ROUTES THAT DEPEND ON THIS ONE
 * -------------------------------------------------
 * `artworks` — `impressionSource()` satisfies the `ImpressionSource` port it
 * declares. Inject it where `ArtworksDeps` is composed, replacing
 * `noImpressions`, or the artist dashboard reports zero exposure for every
 * piece for ever.
 *
 * `src/app` — `runMatchmaker` is the whole questionnaire. It returns artwork
 * IDS, never artworks: shaping an artwork for a buyer is
 * `artworks.toPublicArtwork`'s job and nobody else's, so this module has no way
 * to leak a column by assembling its own view. Hydrate the ids through
 * `catalog`. You owe this module a hashed client fingerprint per request —
 * `hashSubject` at the edge, so a raw IP never reaches this module at all — and
 * a scheduled call to `pruneMatchQueries` and `pruneMatchmakerRateLimitEvents`.
 * You also owe it a dispatcher: `captureNotifyRequest` RETURNS the confirmation
 * as a `NotificationRequest` and sends nothing, so a root that ignores
 * `result.notifications` is a root where nobody is ever confirmed.
 */

// ---- The questionnaire: seven questions, one required, all closed sets.
export {
  assertWithinAnswerSizeLimit,
  hasDimensions,
  hasTaxonomyAnswers,
  isPalette,
  parseAnswers,
  PALETTES,
  PALETTE_LABELS,
  QUESTION_IDS,
  QUESTION_LABELS,
  type Answers,
  type Palette,
  type QuestionId,
  type RawAnswers,
} from "./questionnaire";

// ---- The scoring function. Pure, and there is no parameter an impression
// count or a model response could arrive through.
export {
  blend,
  budgetScore,
  embeddingScore,
  freshnessScore,
  round6,
  scoreArtwork,
  sizeScore,
  taxonomyScore,
  type ArtworkScore,
  type ComponentScores,
  type ScorableArtwork,
  type ScoringContext,
} from "./scoring";

// ---- Exposure rotation: a function of the epoch and the artwork id. Nothing else.
export {
  orderTieBand,
  rotationEpochAt,
  rotationKey,
  type RotationEpoch,
} from "./rotation";

// ---- Ranking: filter below the minimum, band, rotate, truncate. In that order.
export { rank, type RankingSettings } from "./ranking";

// ---- The query vector, and the one catalog query. Both entirely inside Postgres.
export { queryVector, VISIBLE_ARTWORK } from "./query-vector";
export {
  fetchCandidates,
  publishedArtworkCount,
  type CandidateQuery,
} from "./candidates";

// ---- The questionnaire, end to end.
export {
  catalogQueryFor,
  currentEpoch,
  runMatchmaker,
  NO_MATCHES_MESSAGE,
  SPARSE_CATALOG_MESSAGE,
  type EscapeHatch,
  type Match,
  type MatchOutcome,
  type MatchmakerSearchDeps,
  type SearchInput,
} from "./search";

// ---- Impressions: recorded for the artist, invisible to the ranking.
export {
  dedupeBucket,
  impressionCounts,
  impressionSource,
  recordImpressions,
} from "./impressions";

// ---- Notify-me. The response is the same shape whatever the truth is.
export {
  captureNotifyRequest,
  confirmNotifyRequest,
  normaliseEmail,
  unsubscribeNotifyRequest,
  MATCHMAKER_TEMPLATES,
  NOTIFY_ACKNOWLEDGEMENT,
  type MatchmakerTemplate,
  type NotifyCaptureInput,
  type NotifyCaptureResult,
  type NotifyDeps,
} from "./notify";

// ---- Rate limiting on both anonymous surfaces.
export {
  consumeNotifyRateLimit,
  consumeQuestionnaireRateLimit,
  hashSubject,
  pruneMatchmakerRateLimitEvents,
  type MatchmakerRateLimitBucket,
} from "./rate-limit";

// ---- Bounded retention. Nothing here is scheduled; this module owns no scheduler.
export { pruneMatchImpressions, pruneMatchQueries, type SweepResult } from "./retention";

// ---- Thresholds and weights, all of them from `app_config`.
export {
  matchmakerRateLimits,
  matchmakerSettings,
  PENDING_CONFIG_KEYS,
  type MatchmakerSettings,
  type PendingConfigKey,
  type RateLimitSetting,
  type ScoringWeights,
} from "./config";

// ---- Dependencies this module is handed. There is one, and it is a database:
// no mail port, and — deliberately — no AI provider. See `deps.ts`.
export { type MatchmakerDeps } from "./deps";

// ---- User-facing views. Server Components throughout: no `"use client"` in
// this module or below it, so no prop object reaches the RSC payload in the
// HTML (SECURITY.md S1-8).
export { QuestionnaireForm, type QuestionnaireFormProps } from "./ui/QuestionnaireForm";
export { MatchResults, type MatchResultsProps } from "./ui/MatchResults";
export { NotifyMeForm, type NotifyMeFormProps } from "./ui/NotifyMeForm";
