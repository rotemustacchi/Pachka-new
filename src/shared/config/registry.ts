/**
 * The typed key registry for `app_config`.
 *
 * Every entry here corresponds 1:1 with a row seeded in
 * `db/migrations/20260827T090100_create_app_config.sql` — that migration is
 * the source of truth for which keys exist and what their defaults are, and
 * `registry.test.ts` asserts the two never drift apart. Adding a new
 * configurable number means adding a migration row AND a registry entry;
 * either one without the other is caught by that test.
 *
 * `valueType` is the runtime shape `shared/config` validates a stored value
 * against (matching the `value_type` check constraint on the table).
 * `default` is what `getConfig` returns when the row is missing from the
 * table entirely — deliberately, so a key added in code works before its
 * migration has been deployed (see `reader.ts`).
 */

export type ConfigValueType = "integer" | "number" | "string" | "boolean" | "json";

/** Inclusive numeric range a stored value must fall within. See CONFIG_BOUNDS. */
export interface ConfigBounds {
  readonly min: number;
  readonly max: number;
}

export interface ConfigKeyDef<T> {
  readonly valueType: ConfigValueType;
  readonly default: T;
  readonly description: string;
}

function key<T>(valueType: ConfigValueType, defaultValue: T, description: string): ConfigKeyDef<T> {
  return { valueType, default: defaultValue, description };
}

export const CONFIG_REGISTRY = {
  "platform.currency": key<string>("string", "ILS", "Trading currency. Israel-only in the MVP."),
  // Basis points, not a fraction: ARCHITECTURE.md forbids float money, and
  // 1500 bp is exact where 0.15 is not. SECURITY.md S1-16 sets the bound.
  "platform.commission_rate_bp": key<number>(
    "integer",
    1500,
    "Platform commission on the item subtotal in basis points (1500 = 15%), excluding shipping.",
  ),

  "checkout.reservation_ttl_minutes": key<number>(
    "integer",
    30,
    "How long a checkout holds inventory before the reservation is swept.",
  ),

  "matchmaker.result_count": key<number>(
    "integer",
    5,
    "Maximum matches returned for a questionnaire.",
  ),
  "matchmaker.sparse_catalog_threshold": key<number>(
    "integer",
    20,
    "Below this many published artworks the buyer is told the community is still growing.",
  ),
  "matchmaker.over_budget_tolerance": key<number>(
    "number",
    0.15,
    "Fraction above the stated budget still eligible to be shown.",
  ),
  "matchmaker.minimum_score": key<number>(
    "number",
    0.35,
    "Below this score an artwork is not shown at all, even if it would fill the result count.",
  ),
  "matchmaker.tie_tolerance": key<number>(
    "number",
    0.02,
    "Score band within which artworks are considered tied and rotated by lifetime impressions.",
  ),
  "matchmaker.weight_embedding": key<number>("number", 0.45, "Scoring weight w_embed."),
  "matchmaker.weight_taxonomy": key<number>("number", 0.25, "Scoring weight w_tax."),
  "matchmaker.weight_budget": key<number>("number", 0.15, "Scoring weight w_budget."),
  "matchmaker.weight_size": key<number>("number", 0.1, "Scoring weight w_size."),
  "matchmaker.weight_freshness": key<number>("number", 0.05, "Scoring weight w_fresh."),

  "upload.min_shorter_edge_px": key<number>(
    "integer",
    1200,
    "Minimum shorter edge of an uploaded image.",
  ),
  "upload.min_file_size_bytes": key<number>(
    "integer",
    102_400,
    "Minimum accepted file size (100 KB).",
  ),
  "upload.blur_threshold": key<number>("number", 100, "Minimum Laplacian variance."),
  "upload.safety_confidence_threshold": key<number>(
    "number",
    0.7,
    "Confidence at or above which safety screening blocks an image.",
  ),
  "upload.max_display_dimension_px": key<number>(
    "integer",
    1600,
    "Long edge of the public display derivative.",
  ),
  "upload.display_target_bytes": key<number>(
    "integer",
    307_200,
    "Target size of the display derivative (~300 KB).",
  ),

  "shipping.unshipped_grace_days": key<number>(
    "integer",
    3,
    "Business days past the stated lead time before a fulfilment is chased.",
  ),

  "returns.window_days": key<number>("integer", 14, "Days a buyer has to request a return."),
  "returns.receipt_window_days": key<number>(
    "integer",
    14,
    "Days a requested return may go unreceived before it is escalated.",
  ),
  "returns.cancellation_fee_rate": key<number>(
    "number",
    0,
    "Cancellation fee as a fraction of the item subtotal.",
  ),

  "payouts.eligibility_delay_days": key<number>(
    "integer",
    14,
    "Days after delivery before a payout becomes eligible.",
  ),

  "moderation.operator_email": key<string>(
    "string",
    "",
    "Address that receives new-report notifications. Must be set before launch.",
  ),
} as const satisfies Record<string, ConfigKeyDef<unknown>>;

export type ConfigKey = keyof typeof CONFIG_REGISTRY;
export type ConfigValue<K extends ConfigKey> = (typeof CONFIG_REGISTRY)[K]["default"];

export function isConfigKey(value: string): value is ConfigKey {
  return Object.hasOwn(CONFIG_REGISTRY, value);
}

/**
 * Inclusive bounds for numeric keys, mirroring the `app_config_value_within_bounds`
 * check constraint in `db/migrations/20260827T101500_harden_app_config.sql`.
 *
 * Kept as a separate map rather than a field on each entry so that it reads as
 * one table against the SQL one — `registry.test.ts` asserts the two agree, and
 * a reviewer can check them side by side instead of hunting through the
 * registry.
 *
 * They exist in two places on purpose. The database constraint is what stops a
 * compromised admin session storing a 100% commission. These are what stop a
 * value that got past it — a hand-edited row, a backup restored from before the
 * constraint, a replication artefact — from being *acted on*. SECURITY.md S1-16
 * requires the read path to fail closed rather than honour such a value.
 */
export const CONFIG_BOUNDS: Partial<Record<ConfigKey, ConfigBounds>> = {
  // Money and time
  "platform.commission_rate_bp": { min: 0, max: 5000 },
  "checkout.reservation_ttl_minutes": { min: 5, max: 1440 },
  "payouts.eligibility_delay_days": { min: 0, max: 180 },
  "returns.window_days": { min: 14, max: 365 },
  "returns.receipt_window_days": { min: 1, max: 365 },
  // Israeli consumer law permits a cancellation fee of at most 5%.
  "returns.cancellation_fee_rate": { min: 0, max: 0.05 },
  "shipping.unshipped_grace_days": { min: 0, max: 60 },

  // Matchmaker. Weights and normalised scores are fractions of one; a weight
  // above one lets a single signal swamp every other.
  "matchmaker.result_count": { min: 1, max: 50 },
  "matchmaker.sparse_catalog_threshold": { min: 0, max: 10000 },
  "matchmaker.over_budget_tolerance": { min: 0, max: 1 },
  "matchmaker.minimum_score": { min: 0, max: 1 },
  "matchmaker.tie_tolerance": { min: 0, max: 1 },
  "matchmaker.weight_embedding": { min: 0, max: 1 },
  "matchmaker.weight_taxonomy": { min: 0, max: 1 },
  "matchmaker.weight_budget": { min: 0, max: 1 },
  "matchmaker.weight_size": { min: 0, max: 1 },
  "matchmaker.weight_freshness": { min: 0, max: 1 },

  // Upload gate. Zero here switches the quality and safety gates off.
  "upload.min_shorter_edge_px": { min: 200, max: 10000 },
  "upload.min_file_size_bytes": { min: 1024, max: 104857600 },
  "upload.blur_threshold": { min: 0, max: 10000 },
  "upload.safety_confidence_threshold": { min: 0, max: 1 },
  "upload.max_display_dimension_px": { min: 200, max: 10000 },
  "upload.display_target_bytes": { min: 1024, max: 104857600 },
};

export function boundsFor(key: ConfigKey): ConfigBounds | undefined {
  return CONFIG_BOUNDS[key];
}
