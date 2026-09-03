/**
 * Every number the matchmaker uses, and where it comes from.
 *
 * ARCHITECTURE.md: "Every configurable number lives in `app_config`, read
 * through `shared/config`... No magic numbers in module code." Ten of the
 * numbers below are already in the registry and are read through `getConfig`
 * exactly as that rule intends.
 *
 * THE TWELVE THAT ARE NOT REGISTERED YET, AND WHY THIS FILE IS SHAPED LIKE THIS
 * ----------------------------------------------------------------------------
 * `src/shared/config/registry.ts` is outside this agent's write boundary: keys
 * are reported to the lead architect, who registers them. Until that lands,
 * `getConfig` will not compile for a key it does not know, and the two ways out
 * are both worse than this one:
 *
 *   - Inline the numbers as constants. That is precisely the magic number the
 *     contract forbids, and the settings it would hide -- the rate limits and
 *     the statement timeout -- are the ones an operator needs to change DURING
 *     an incident, which is the worst possible moment to need a deployment.
 *   - Wait for registration. The module would then have no rate limiting at
 *     all in the interim, on its anonymous surfaces.
 *
 * So `PENDING_CONFIG_KEYS` states each key exactly as a registry entry states
 * one -- type, default, bounds, description -- and `pendingConfig` reads it from
 * `app_config` with the same semantics `shared/config`'s reader has: a missing
 * row resolves to the declared default, a value of the wrong type throws naming
 * the key, and a value outside its bounds falls back to the default rather than
 * being acted on (SECURITY.md S1-16). One batched read, not one per key.
 *
 * When the lead registers these, this file collapses to a second `getConfig`
 * block and `PENDING_CONFIG_KEYS` becomes empty. `config.test.ts` in this
 * module asserts the list is exactly what the module reads, so the transcription
 * cannot go silently wrong.
 */
import { getConfig } from "@/shared/config";
import type { Sql } from "@/shared/db";
import { AppError } from "@/shared/errors";

// ---------------------------------------------------------------------------
// Keys awaiting registration in shared/config
// ---------------------------------------------------------------------------

export interface PendingConfigKey {
  readonly key: string;
  readonly valueType: "integer" | "number";
  readonly default: number;
  readonly min: number;
  readonly max: number;
  readonly description: string;
}

export const PENDING_CONFIG_KEYS: readonly PendingConfigKey[] = [
  {
    key: "matchmaker.rotation_epoch_hours",
    valueType: "integer",
    default: 24,
    min: 1,
    max: 8760,
    description:
      "How long a rotation epoch lasts. Ranking is reproducible within one epoch and the tie band reorders when it advances.",
  },
  {
    key: "matchmaker.query_window_minutes",
    valueType: "integer",
    default: 60,
    min: 1,
    max: 1440,
    description: "Window over which questionnaire submissions are counted per client.",
  },
  {
    key: "matchmaker.query_max_per_window",
    valueType: "integer",
    default: 30,
    min: 1,
    max: 1000,
    description: "Questionnaire submissions permitted per client per window (SECURITY.md S2-22).",
  },
  {
    key: "matchmaker.notify_window_minutes",
    valueType: "integer",
    default: 1440,
    min: 1,
    max: 10080,
    description: "Window over which notify-me captures are counted per client and per address.",
  },
  {
    key: "matchmaker.notify_max_per_window",
    valueType: "integer",
    default: 3,
    min: 1,
    max: 100,
    description: "Notify-me captures permitted per client per window (SECURITY.md S2-21).",
  },
  {
    key: "matchmaker.impression_dedupe_window_minutes",
    valueType: "integer",
    default: 1440,
    min: 1,
    max: 10080,
    description:
      "At most one impression per artwork per viewer per this window (SECURITY.md S2-23 item 1).",
  },
  {
    key: "matchmaker.candidate_pool_size",
    valueType: "integer",
    default: 200,
    min: 1,
    max: 5000,
    description:
      "How many nearest artworks the ranking query pulls before blending. Bounds the cost of an anonymous request.",
  },
  {
    key: "matchmaker.query_timeout_ms",
    valueType: "integer",
    default: 3000,
    min: 100,
    max: 30000,
    description: "Statement timeout on the ranking query (SECURITY.md S2-22 item 2).",
  },
  {
    key: "matchmaker.freshness_half_life_days",
    valueType: "integer",
    default: 30,
    min: 1,
    max: 3650,
    description: "Age at which the freshness component of the score has fallen to one half.",
  },
  {
    key: "matchmaker.ideal_wall_occupancy",
    valueType: "number",
    default: 0.6,
    min: 0.05,
    max: 1,
    description:
      "Fraction of the buyer's stated wall area a piece ideally covers. The size score peaks here.",
  },
  {
    key: "matchmaker.query_retention_days",
    valueType: "integer",
    default: 30,
    min: 1,
    max: 3650,
    description:
      "Age at which an unreferenced questionnaire row is swept (SECURITY.md S2-22 item 3).",
  },
  {
    key: "matchmaker.max_answer_bytes",
    valueType: "integer",
    default: 4096,
    min: 256,
    max: 65536,
    description:
      "Size cap on a submitted questionnaire body, checked before anything else (SECURITY.md S2-22 item 5).",
  },
] as const;

const PENDING_BY_KEY: ReadonlyMap<string, PendingConfigKey> = new Map(
  PENDING_CONFIG_KEYS.map((entry) => [entry.key, entry] as const),
);

interface ConfigRow {
  readonly key: string;
  readonly value: unknown;
  readonly value_type: string;
}

/**
 * Read every pending key in one round trip.
 *
 * Same resolution rules as `shared/config`'s reader, restated rather than
 * imported because that reader is typed against the registry these keys are not
 * in yet. See the header.
 */
async function pendingConfig(db: Sql): Promise<ReadonlyMap<string, number>> {
  const keys = PENDING_CONFIG_KEYS.map((entry) => entry.key);
  const { rows } = await db.query<ConfigRow>(
    "select key, value, value_type from app_config where key = any($1::text[])",
    [keys],
  );
  const stored = new Map(rows.map((row) => [row.key, row] as const));

  const resolved = new Map<string, number>();
  for (const entry of PENDING_CONFIG_KEYS) {
    resolved.set(entry.key, resolveOne(entry, stored.get(entry.key)));
  }
  return resolved;
}

function resolveOne(entry: PendingConfigKey, row: ConfigRow | undefined): number {
  if (row === undefined) return entry.default;

  if (row.value_type !== entry.valueType) {
    throw AppError.validation(
      `app_config."${entry.key}" is declared as "${entry.valueType}" in code but stored as ` +
        `"${row.value_type}" in the database. Fix the row or the declaration.`,
      {
        code: "matchmaker.config_type_mismatch",
        details: { key: entry.key, expected: entry.valueType, stored: row.value_type },
      },
    );
  }

  const value = row.value;
  const wellFormed =
    typeof value === "number" &&
    Number.isFinite(value) &&
    (entry.valueType === "number" || Number.isInteger(value));

  if (!wellFormed) {
    throw AppError.validation(
      `app_config."${entry.key}" is declared as "${entry.valueType}" but its stored value is ` +
        `${JSON.stringify(value)}. Silently falling back would quietly revert a configured setting.`,
      { code: "matchmaker.config_type_mismatch", details: { key: entry.key, value: null } },
    );
  }

  if (value < entry.min || value > entry.max) {
    // Reported and then survived, exactly as `shared/config` does it: this runs
    // on every questionnaire, and taking the matchmaker down over one bad row
    // would turn a configuration error into an outage (SECURITY.md S1-16).
    console.error(
      `app_config."${entry.key}" holds ${value}, outside its permitted range ` +
        `[${entry.min}, ${entry.max}]. Falling back to the built-in default ${entry.default}.`,
    );
    return entry.default;
  }

  return value;
}

/**
 * Look one resolved key up, loudly.
 *
 * A miss is not a configuration problem an operator can fix, it is this file
 * disagreeing with itself -- a key read that is not in `PENDING_CONFIG_KEYS` --
 * so it is a plain `Error` and a 500, not an `AppError` shown to a buyer.
 */
function resolver(pending: ReadonlyMap<string, number>): (key: string) => number {
  return (key) => {
    const value = pending.get(key);
    if (value === undefined) {
      throw new Error(`matchmaker reads app_config."${key}" but never declared it`);
    }
    return value;
  };
}

// ---------------------------------------------------------------------------
// The settings, as the module reads them
// ---------------------------------------------------------------------------

/** The weights of the scoring function. They are relative, not required to sum to one. */
export interface ScoringWeights {
  readonly embedding: number;
  readonly taxonomy: number;
  readonly budget: number;
  readonly size: number;
  readonly freshness: number;
}

export interface MatchmakerSettings {
  /** How many matches a buyer is shown at most. Fewer is allowed; padding is not. */
  readonly resultCount: number;
  /** Below this many published artworks, the buyer is told the community is growing. */
  readonly sparseCatalogThreshold: number;
  /** Fraction above the stated ceiling still eligible to be shown at all. */
  readonly overBudgetTolerance: number;
  /** Below this blended score an artwork is never shown. */
  readonly minimumScore: number;
  /** Score band within which artworks are considered tied and rotated. */
  readonly tieTolerance: number;
  readonly weights: ScoringWeights;
  readonly rotationEpochHours: number;
  readonly candidatePoolSize: number;
  readonly queryTimeoutMs: number;
  readonly freshnessHalfLifeDays: number;
  readonly idealWallOccupancy: number;
  readonly maxAnswerBytes: number;
}

export interface RateLimitSetting {
  readonly windowMinutes: number;
  readonly maxPerWindow: number;
}

export async function matchmakerSettings(db: Sql): Promise<MatchmakerSettings> {
  const [
    resultCount,
    sparseCatalogThreshold,
    overBudgetTolerance,
    minimumScore,
    tieTolerance,
    embedding,
    taxonomy,
    budget,
    size,
    freshness,
    pending,
  ] = await Promise.all([
    getConfig(db, "matchmaker.result_count"),
    getConfig(db, "matchmaker.sparse_catalog_threshold"),
    getConfig(db, "matchmaker.over_budget_tolerance"),
    getConfig(db, "matchmaker.minimum_score"),
    getConfig(db, "matchmaker.tie_tolerance"),
    getConfig(db, "matchmaker.weight_embedding"),
    getConfig(db, "matchmaker.weight_taxonomy"),
    getConfig(db, "matchmaker.weight_budget"),
    getConfig(db, "matchmaker.weight_size"),
    getConfig(db, "matchmaker.weight_freshness"),
    pendingConfig(db),
  ]);

  const number = resolver(pending);

  return {
    resultCount,
    sparseCatalogThreshold,
    overBudgetTolerance,
    minimumScore,
    tieTolerance,
    weights: { embedding, taxonomy, budget, size, freshness },
    rotationEpochHours: number("matchmaker.rotation_epoch_hours"),
    candidatePoolSize: number("matchmaker.candidate_pool_size"),
    queryTimeoutMs: number("matchmaker.query_timeout_ms"),
    freshnessHalfLifeDays: number("matchmaker.freshness_half_life_days"),
    idealWallOccupancy: number("matchmaker.ideal_wall_occupancy"),
    maxAnswerBytes: number("matchmaker.max_answer_bytes"),
  };
}

/** The two rate limits, read together because both surfaces are anonymous. */
export async function matchmakerRateLimits(db: Sql): Promise<{
  readonly questionnaire: RateLimitSetting;
  readonly notify: RateLimitSetting;
  readonly impressionDedupeWindowMinutes: number;
  readonly queryRetentionDays: number;
}> {
  const pending = await pendingConfig(db);
  const number = resolver(pending);

  return {
    questionnaire: {
      windowMinutes: number("matchmaker.query_window_minutes"),
      maxPerWindow: number("matchmaker.query_max_per_window"),
    },
    notify: {
      windowMinutes: number("matchmaker.notify_window_minutes"),
      maxPerWindow: number("matchmaker.notify_max_per_window"),
    },
    impressionDedupeWindowMinutes: number("matchmaker.impression_dedupe_window_minutes"),
    queryRetentionDays: number("matchmaker.query_retention_days"),
  };
}
