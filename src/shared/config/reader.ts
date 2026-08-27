/**
 * Reading and writing `app_config` through the typed registry.
 *
 * ARCHITECTURE.md: "Every configurable number lives in app_config, read
 * through shared/config... No magic numbers in module code."
 */
import { AppError } from "@/shared/errors";
import type { Sql } from "@/shared/db";
import { invalidateCache, readCache, writeCache } from "./cache";
import { boundsFor, CONFIG_REGISTRY, type ConfigKey, type ConfigValue, type ConfigKeyDef } from "./registry";
import { assertConfigValueMatchesType } from "./validate";

interface ConfigRow {
  readonly value: unknown;
  readonly value_type: string;
}

function definitionFor<K extends ConfigKey>(key: K): ConfigKeyDef<ConfigValue<K>> {
  const definition = (CONFIG_REGISTRY as Record<string, ConfigKeyDef<unknown>>)[key];
  if (!definition) {
    // Reached only when a caller bypasses the compile-time `ConfigKey`
    // constraint (e.g. a key read from user input cast through `as ConfigKey`).
    // TypeScript makes this a type error at the call site; this is the
    // runtime backstop the task requires.
    throw AppError.validation(`Unknown config key: "${key}"`, {
      code: "config.unknown_key",
      details: { key },
    });
  }
  return definition as ConfigKeyDef<ConfigValue<K>>;
}

/**
 * Read a config value. Every configurable number in the codebase should be
 * read this way — never inlined as a literal.
 *
 * - A row missing from the table entirely resolves to the registry's
 *   declared default, so a key added in code works before its migration has
 *   been deployed.
 * - A row whose stored value does not match its declared type throws,
 *   naming the key — never silently falls back to the default, which would
 *   mean an operator's typo quietly reverting a setting nobody noticed.
 * - Reads are cached per-client with a short TTL; see `cache.ts`.
 */
export async function getConfig<K extends ConfigKey>(db: Sql, key: K): Promise<ConfigValue<K>> {
  const definition = definitionFor(key);

  const cached = readCache(db, key);
  if (cached.hit) {
    return cached.value as ConfigValue<K>;
  }

  const row = await db.maybeOne<ConfigRow>(
    "select value, value_type from app_config where key = $1",
    [key],
  );

  let resolved: ConfigValue<K>;
  if (row === null) {
    resolved = definition.default;
  } else {
    if (row.value_type !== definition.valueType) {
      throw AppError.validation(
        `app_config."${key}" is declared as "${definition.valueType}" in code but stored as ` +
          `"${row.value_type}" in the database. Fix the row or the registry entry.`,
        {
          code: "config.type_mismatch",
          details: { key, expected: definition.valueType, stored: row.value_type },
        },
      );
    }
    assertConfigValueMatchesType(key, definition.valueType, row.value);
    resolved = withinBoundsOrDefault(key, definition, row.value) as ConfigValue<K>;
  }

  writeCache(db, key, resolved);
  return resolved;
}

/**
 * Fail closed when a stored numeric value is outside its declared bounds.
 *
 * The database constraint added in `20260827T101500_harden_app_config.sql` is
 * the primary defence, and it is what stops a compromised admin session storing
 * a 100% commission. This is the second line: a value that got past it — a
 * hand-edited row, a backup restored from before the constraint existed, a
 * replication artefact — must not be *acted on*.
 *
 * SECURITY.md S1-16 requires the fallback to be the compiled-in safe default,
 * never zero and never the stored value. Deliberately not a throw: this runs on
 * every checkout, and taking the site down over one bad row would turn a
 * configuration error into an outage. The read is reported and then survives.
 */
function withinBoundsOrDefault<T>(key: ConfigKey, definition: ConfigKeyDef<T>, value: unknown): T {
  const bounds = boundsFor(key);
  if (!bounds || typeof value !== "number") return value as T;
  if (value >= bounds.min && value <= bounds.max) return value as T;

  console.error(
    `app_config."${key}" holds ${value}, outside its permitted range ` +
      `[${bounds.min}, ${bounds.max}]. Falling back to the built-in default ` +
      `${JSON.stringify(definition.default)}. Fix the row — a value this far out ` +
      `usually means the row was edited around the database constraint.`,
  );
  return definition.default;
}

/**
 * Write a config value directly. This is a plain upsert for tests and for a
 * future admin route to build on — it deliberately does NOT write an audit
 * row. `moderation.admin_audit` owns admin auditing (ARCHITECTURE.md,
 * "Database schema — table ownership"); a real admin write path must record
 * its own audit entry alongside calling this, not pretend this function does
 * it. `description` and `is_public` are preserved when the row already
 * exists — this only ever touches `value`/`value_type`.
 */
export async function setConfig<K extends ConfigKey>(
  db: Sql,
  key: K,
  value: ConfigValue<K>,
): Promise<void> {
  const definition = definitionFor(key);
  assertConfigValueMatchesType(key, definition.valueType, value);
  assertWithinBounds(key, value);

  await db.query(
    `insert into app_config (key, value, value_type, description, is_public)
     values ($1, $2::jsonb, $3, '', false)
     on conflict (key) do update set value = excluded.value, value_type = excluded.value_type`,
    [key, JSON.stringify(value), definition.valueType],
  );

  invalidateConfig(db, key);
}

/**
 * Reject an out-of-bounds write outright.
 *
 * Reading falls back so a bad row cannot cause an outage; writing throws,
 * because there is a caller to tell and nothing has been committed yet.
 */
function assertWithinBounds(key: ConfigKey, value: unknown): void {
  const bounds = boundsFor(key);
  if (!bounds || typeof value !== "number") return;
  if (value >= bounds.min && value <= bounds.max) return;

  throw AppError.validation(
    `app_config."${key}" must be between ${bounds.min} and ${bounds.max}; refused ${value}.`,
    { code: "config.out_of_bounds", details: { key, value, ...bounds } },
  );
}

/** Explicit cache invalidation for the path that changes a value out of band. */
export function invalidateConfig(db: Sql, key?: ConfigKey): void {
  invalidateCache(db, key);
}
