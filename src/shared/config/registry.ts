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
  "platform.commission_rate": key<number>(
    "number",
    0.15,
    "Platform commission on the item subtotal, excluding shipping.",
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
