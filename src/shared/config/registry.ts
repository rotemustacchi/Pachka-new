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

/**
 * The shape of `shipping.pachka_return_address`.
 *
 * Declared here rather than imported from `modules/shipping`, because
 * `shared/*` may not depend on a module (ARCHITECTURE.md, module boundary
 * rules). The module's own `PostalAddress` is structurally identical and is
 * what validates a stored value on the way in; this is the registry's
 * compiled-in fallback for a key whose row is missing.
 */
export interface PostalAddressValue {
  readonly recipient: string;
  readonly line1: string;
  readonly line2?: string;
  readonly city: string;
  readonly postalCode: string;
  readonly countryCode: string;
}

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

  // Artworks. How much of the taxonomy one listing may claim — SECURITY.md
  // S2-20 item 2, "cap the shape": claiming every style and every target space
  // maximises taxonomy overlap in the matchmaker's scoring function and ranks
  // the artwork into every result set. Distinct from the cardinality check
  // constraints in the artworks migration, which are absolute ceilings equal to
  // the size of each closed set; these are how many an artist MAY pick.
  "artworks.max_styles": key<number>(
    "integer",
    3,
    "Most styles one artwork may claim. SECURITY.md S2-20 item 2.",
  ),
  "artworks.max_target_spaces": key<number>(
    "integer",
    3,
    "Most target spaces one artwork may claim. SECURITY.md S2-20 item 2.",
  ),
  "artworks.max_moods": key<number>(
    "integer",
    2,
    "Most moods one artwork may claim. SECURITY.md S2-20 item 2.",
  ),
  "artworks.max_description_length": key<number>(
    "integer",
    4000,
    "Longest stored description. Matches the check constraint on the column.",
  ),
  "artworks.max_images_per_artwork": key<number>(
    "integer",
    8,
    "Most images one artwork may carry. Position is 0-based, so the last is this minus one.",
  ),
  "artworks.max_edition_size": key<number>(
    "integer",
    250,
    "Largest edition an artist may declare. An unbounded edition is an unbounded reservation fan-out.",
  ),

  "shipping.unshipped_grace_days": key<number>(
    "integer",
    3,
    "Business days past the stated lead time before a fulfilment is chased.",
  ),

  // PLACEHOLDER default. The real PO box is seeded in the migration and is an
  // operator setting, because it changes when the box moves and that is not a
  // deployment. The shape is validated where it is read.
  "shipping.pachka_return_address": key<PostalAddressValue>(
    "json",
    {
      recipient: "PACHKA",
      line1: "PLACEHOLDER PO BOX",
      city: "Tel Aviv-Yafo",
      postalCode: "6100000",
      countryCode: "IL",
    },
    "The PACHKA-operated return address. Every return routes through it so that no artist address is printed on a shipping label.",
  ),

  "returns.window_days": key<number>("integer", 14, "Days a buyer has to request a return."),
  "returns.receipt_window_days": key<number>(
    "integer",
    14,
    "Days a requested return may go unreceived before it is escalated.",
  ),
  "returns.artist_response_window_days": key<number>(
    "integer",
    7,
    "Days an artist has to confirm or dispute a forwarded return before it escalates to an admin.",
  ),
  // UNDECIDED: a question about Israeli distance-selling law rather than an
  // engineering preference. `false` is the conservative reading — the buyer
  // bears return shipping, and the outbound leg was performed.
  "returns.refund_includes_outbound_shipping": key<boolean>(
    "boolean",
    false,
    "Whether a refund returns the outbound shipping the buyer paid.",
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

  "moderation.report_window_minutes": key<number>(
    "integer",
    60,
    "Window over which report attempts are counted, per hashed client fingerprint.",
  ),
  "moderation.report_max_per_window": key<number>(
    "integer",
    10,
    "Report attempts permitted per window. Counted whether or not the attempt is allowed.",
  ),
  "moderation.operator_email": key<string>(
    "string",
    "",
    "Address that receives new-report notifications. Must be set before launch.",
  ),

  // Accounts. Length is the only password strength rule: composition rules push
  // people towards Passw0rd! and away from passphrases.
  "accounts.min_password_length": key<number>(
    "integer",
    10,
    "Minimum password length at registration.",
  ),
  // Rate limits on the anonymous auth surface. SECURITY.md's cross-cutting rate
  // limit table; SPEC-J records that no spec mentions rate limiting at all.
  "accounts.registration_window_minutes": key<number>(
    "integer",
    60,
    "Window over which registration attempts are counted, per IP and per address.",
  ),
  "accounts.registration_max_per_window": key<number>(
    "integer",
    5,
    "Registration attempts permitted per window.",
  ),
  "accounts.signin_window_minutes": key<number>(
    "integer",
    15,
    "Window over which sign-in attempts are counted, per IP and per address.",
  ),
  "accounts.signin_max_per_window": key<number>(
    "integer",
    10,
    "Sign-in attempts permitted per window. Guards credential stuffing.",
  ),
  "accounts.password_reset_window_minutes": key<number>(
    "integer",
    60,
    "Window over which password-reset requests are counted.",
  ),
  "accounts.password_reset_max_per_window": key<number>(
    "integer",
    3,
    "Password-reset requests permitted per window. Also an outbound mail cap.",
  ),
  "accounts.artist_upgrade_window_minutes": key<number>(
    "integer",
    1440,
    "Window over which artist-upgrade attempts are counted, per account.",
  ),
  "accounts.artist_upgrade_max_per_window": key<number>(
    "integer",
    3,
    "Artist-upgrade attempts permitted per window. Guards bulk fake-artist creation.",
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
  "returns.artist_response_window_days": { min: 1, max: 90 },

  // Taxonomy caps. Zero means no artist can classify anything and the
  // matchmaker has nothing to score on; the whole closed set is the abuse
  // S2-20 describes, with the cap switched off.
  "artworks.max_styles": { min: 1, max: 10 },
  "artworks.max_target_spaces": { min: 1, max: 10 },
  "artworks.max_moods": { min: 1, max: 10 },
  "artworks.max_description_length": { min: 200, max: 4000 },
  "artworks.max_images_per_artwork": { min: 1, max: 20 },
  "artworks.max_edition_size": { min: 1, max: 10000 },

  // Reporting. Zero permitted reports closes the surface an abuse victim
  // reaches for.
  "moderation.report_window_minutes": { min: 1, max: 1440 },
  "moderation.report_max_per_window": { min: 1, max: 1000 },

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

  // Accounts. Below ten characters is not a password policy, it is a formality.
  "accounts.min_password_length": { min: 10, max: 128 },
  "accounts.registration_window_minutes": { min: 1, max: 1440 },
  "accounts.registration_max_per_window": { min: 1, max: 1000 },
  "accounts.signin_window_minutes": { min: 1, max: 1440 },
  "accounts.signin_max_per_window": { min: 1, max: 1000 },
  "accounts.password_reset_window_minutes": { min: 1, max: 1440 },
  "accounts.password_reset_max_per_window": { min: 1, max: 1000 },
  "accounts.artist_upgrade_window_minutes": { min: 1, max: 43200 },
  "accounts.artist_upgrade_max_per_window": { min: 1, max: 1000 },
};

export function boundsFor(key: ConfigKey): ConfigBounds | undefined {
  return CONFIG_BOUNDS[key];
}
