/**
 * `shared/config` reading from a real database — the part of the module that
 * `src/shared/config/*.test.ts` (unit) cannot exercise, since it needs an
 * actual `app_config` table and actual rows.
 */
import { describe, expect, it, vi } from "vitest";
import { createDatabase } from "@/shared/db";
import { isAppError } from "@/shared/errors";
import { CONFIG_CACHE_TTL_MS, getConfig, invalidateConfig, setConfig } from "@/shared/config";
import type { ConfigKey } from "@/shared/config";
import { useTestDatabase, withPrivilegedConnection } from "../harness";

/**
 * Put the database into a state no application role can reach.
 *
 * Every fixture below is here for the same reason. `shared/config` has two
 * fallbacks -- a missing row falls back to the registry's compiled-in default,
 * and a stored value whose shape contradicts its declared type is refused
 * rather than coerced -- and neither state can be produced through `setConfig`.
 * There is no DELETE policy on `app_config` at all (removing a key is a
 * migration, so that the deletion is reviewed with the code that stops reading
 * it), and `app_config_value_matches_declared_type` makes the mismatched row
 * impossible to write. Those states arrive by restored backup, by hand-edited
 * row, or by a key deployed ahead of its migration -- which is precisely why
 * the reader guards against them, and why setting one up needs the credentials
 * those paths had. Dropping a constraint needs table ownership regardless.
 */
const arrange = (
  database: { readonly name: string },
  sql: string,
  params: readonly unknown[] = [],
): Promise<unknown> =>
  withPrivilegedConnection(
    database,
    "arranging a database state only a migration or a restored backup produces",
    (client) => client.query(sql, [...params]),
  );

function captureError(fn: () => unknown): Promise<unknown> {
  return Promise.resolve()
    .then(fn)
    .then(
      () => {
        throw new Error("Expected the function to reject, but it resolved.");
      },
      (error: unknown) => error,
    );
}

describe("getConfig() — reading app_config", () => {
  const database = useTestDatabase();

  it("returns the seeded default for a known key", async () => {
    const rate = await getConfig(database.db, "platform.commission_rate_bp");
    expect(rate).toBe(1500);
  });

  it("returns the code-declared default when the row is missing from the table entirely", async () => {
    await arrange(database, "delete from app_config where key = $1", [
      "shipping.unshipped_grace_days",
    ]);

    const value = await getConfig(database.db, "shipping.unshipped_grace_days");
    expect(value).toBe(3); // the registry's default, not a database read
  });

  it("rejects a stored value whose JS shape does not match its declared type", async () => {
    // The value_type column still says "number" — an operator edited `value`
    // directly and left the declared type alone (or lied about it either
    // way; both must be caught, not silently coerced).
    // The constraint added in 20260827T101500 makes this row impossible to
    // write normally. Drop it to stand in for a row that arrived another way —
    // a restored backup, a hand-edited row — which is exactly the case the
    // reader's own check exists to catch.
    await arrange(database, "alter table app_config drop constraint app_config_value_matches_declared_type");
    await arrange(database, "alter table app_config drop constraint app_config_value_within_bounds");
    await database.db.query(
      "update app_config set value = $2::jsonb where key = $1",
      ["platform.commission_rate_bp", JSON.stringify("not-a-number")],
    );

    const error = await captureError(() => getConfig(database.db, "platform.commission_rate_bp"));
    expect(isAppError(error) && error.kind).toBe("validation");
    expect(isAppError(error) && error.message).toContain("platform.commission_rate_bp");
  });

  it("rejects a row whose value_type column disagrees with the registry's declared type", async () => {
    await arrange(database, "alter table app_config drop constraint app_config_value_matches_declared_type");
    await arrange(database, "alter table app_config drop constraint app_config_value_within_bounds");
    await database.db.query("update app_config set value_type = $2 where key = $1", [
      "platform.commission_rate_bp",
      "string",
    ]);

    const error = await captureError(() => getConfig(database.db, "platform.commission_rate_bp"));
    expect(isAppError(error) && error.kind).toBe("validation");
    expect(isAppError(error) && error.message).toContain("platform.commission_rate_bp");
  });

  it("rejects reading a key that is not in the registry", async () => {
    const bogusKey = "no.such.key" as ConfigKey;
    const error = await captureError(() => getConfig(database.db, bogusKey));
    expect(isAppError(error) && error.kind).toBe("validation");
    expect(isAppError(error) && error.code).toBe("config.unknown_key");
  });
});

describe("getConfig() — caching", () => {
  const database = useTestDatabase();

  it("serves a cached value on a second read within the TTL, even if the row changed underneath it", async () => {
    const first = await getConfig(database.db, "matchmaker.result_count");
    expect(first).toBe(5);

    await database.db.query("update app_config set value = $2::jsonb where key = $1", [
      "matchmaker.result_count",
      JSON.stringify(42),
    ]);

    const second = await getConfig(database.db, "matchmaker.result_count");
    expect(second).toBe(5); // still the cached value, not the freshly written 99
  });

  it("invalidateConfig() forces the next read to hit the database again", async () => {
    await getConfig(database.db, "matchmaker.result_count");

    await database.db.query("update app_config set value = $2::jsonb where key = $1", [
      "matchmaker.result_count",
      JSON.stringify(42),
    ]);
    invalidateConfig(database.db, "matchmaker.result_count");

    const value = await getConfig(database.db, "matchmaker.result_count");
    expect(value).toBe(42);
  });

  it("invalidateConfig() with no key clears every cached key for that client", async () => {
    await getConfig(database.db, "matchmaker.result_count");
    await getConfig(database.db, "platform.commission_rate_bp");

    await database.db.query("update app_config set value = $2::jsonb where key = $1", [
      "matchmaker.result_count",
      JSON.stringify(42),
    ]);
    await database.db.query("update app_config set value = $2::jsonb where key = $1", [
      "platform.commission_rate_bp",
      JSON.stringify(2000),
    ]);
    invalidateConfig(database.db);

    expect(await getConfig(database.db, "matchmaker.result_count")).toBe(42);
    expect(await getConfig(database.db, "platform.commission_rate_bp")).toBe(2000);
  });

  it("a stale cache entry expires on its own once the TTL elapses, with no explicit invalidation", async () => {
    vi.useFakeTimers();
    try {
      const first = await getConfig(database.db, "matchmaker.result_count");
      expect(first).toBe(5);

      await database.db.query("update app_config set value = $2::jsonb where key = $1", [
        "matchmaker.result_count",
        JSON.stringify(42),
      ]);

      vi.advanceTimersByTime(CONFIG_CACHE_TTL_MS + 1);

      const second = await getConfig(database.db, "matchmaker.result_count");
      expect(second).toBe(42);
    } finally {
      vi.useRealTimers();
    }
  });

  it("caches per client — a second Database instance pointed at the same database is not poisoned by the first's cache", async () => {
    const otherClient = createDatabase({ connectionString: database.url, max: 2 });
    try {
      const viaFirst = await getConfig(database.db, "matchmaker.result_count");
      expect(viaFirst).toBe(5);

      // Mutate the underlying row directly.
      await database.db.query("update app_config set value = $2::jsonb where key = $1", [
        "matchmaker.result_count",
        JSON.stringify(7),
      ]);

      // The second client has never read this key, so it must not have any
      // cached entry to hit — it reads the fresh row straight away.
      const viaSecond = await getConfig(otherClient, "matchmaker.result_count");
      expect(viaSecond).toBe(7);

      // Meanwhile the first client's cache is untouched by the second client's read.
      const viaFirstAgain = await getConfig(database.db, "matchmaker.result_count");
      expect(viaFirstAgain).toBe(5);
    } finally {
      await otherClient.end();
    }
  });
});

describe("bounds — SECURITY.md S1-16", () => {
  const database = useTestDatabase();

  it("falls back to the built-in default when a stored value is out of range", async () => {
    // Simulate a row that got around the database constraint: a restored
    // backup, a hand-edited row, a replication artefact.
    await arrange(database, "alter table app_config drop constraint app_config_value_within_bounds");
    await database.db.query("update app_config set value = '-500'::jsonb where key = $1", [
      "platform.commission_rate_bp",
    ]);

    const rate = await getConfig(database.db, "platform.commission_rate_bp");

    // A negative commission would make the payout larger than the sale, and the
    // ledger would faithfully record it as owed.
    expect(rate).toBe(1500);
  });

  it("falls back rather than throwing, so one bad row cannot take checkout down", async () => {
    await arrange(database, "alter table app_config drop constraint app_config_value_within_bounds");
    await database.db.query("update app_config set value = '99999'::jsonb where key = $1", [
      "platform.commission_rate_bp",
    ]);

    await expect(getConfig(database.db, "platform.commission_rate_bp")).resolves.toBe(1500);
  });

  it("still returns a stored value that is within range", async () => {
    await database.db.query("update app_config set value = '2500'::jsonb where key = $1", [
      "platform.commission_rate_bp",
    ]);

    expect(await getConfig(database.db, "platform.commission_rate_bp")).toBe(2500);
  });

  it("refuses an out-of-bounds write and leaves the stored value alone", async () => {
    const error = await captureError(() =>
      setConfig(database.db, "platform.commission_rate_bp", 9000),
    );

    expect(isAppError(error) && error.kind).toBe("validation");
    expect(isAppError(error) && error.code).toBe("config.out_of_bounds");

    const row = await database.db.one<{ value: string }>(
      "select value::text as value from app_config where key = $1",
      ["platform.commission_rate_bp"],
    );
    expect(row.value).toBe("1500");
  });

  it("refuses a reservation hold long enough to freeze the catalog", async () => {
    const error = await captureError(() =>
      setConfig(database.db, "checkout.reservation_ttl_minutes", 43200),
    );

    expect(isAppError(error) && error.code).toBe("config.out_of_bounds");
  });

  it("refuses switching the upload quality gate off", async () => {
    const error = await captureError(() =>
      setConfig(database.db, "upload.min_shorter_edge_px", 0),
    );

    expect(isAppError(error) && error.code).toBe("config.out_of_bounds");
  });
});

describe("setConfig()", () => {
  const database = useTestDatabase();

  it("writes a new value and getConfig immediately reflects it (no stale cache)", async () => {
    await getConfig(database.db, "platform.commission_rate_bp"); // warm the cache first
    await setConfig(database.db, "platform.commission_rate_bp", 1800);

    expect(await getConfig(database.db, "platform.commission_rate_bp")).toBe(1800);

    const row = await database.db.one<{ value: number }>(
      "select value::text::float8 as value from app_config where key = $1",
      ["platform.commission_rate_bp"],
    );
    expect(row.value).toBe(1800);
  });

  it("inserts the row when the key is missing from the table entirely (a new key deployed ahead of its migration)", async () => {
    await arrange(database, "delete from app_config where key = $1", [
      "shipping.unshipped_grace_days",
    ]);

    await setConfig(database.db, "shipping.unshipped_grace_days", 9);

    const row = await database.db.maybeOne("select 1 from app_config where key = $1", [
      "shipping.unshipped_grace_days",
    ]);
    expect(row).not.toBeNull();
    expect(await getConfig(database.db, "shipping.unshipped_grace_days")).toBe(9);
  });

  it("does not perform admin auditing — it only ever touches value and value_type", async () => {
    const before = await database.db.one<{ description: string; is_public: boolean }>(
      "select description, is_public from app_config where key = $1",
      ["platform.commission_rate_bp"],
    );

    await setConfig(database.db, "platform.commission_rate_bp", 2000);

    const after = await database.db.one<{ description: string; is_public: boolean }>(
      "select description, is_public from app_config where key = $1",
      ["platform.commission_rate_bp"],
    );
    expect(after.description).toBe(before.description);
    expect(after.is_public).toBe(before.is_public);
  });

  it("rejects a wrong-shaped value before writing anything", async () => {
    const before = await database.db.one<{ value: string }>(
      "select value::text as value from app_config where key = $1",
      ["platform.commission_rate_bp"],
    );

    const error = await captureError(() =>
      setConfig(database.db, "platform.commission_rate_bp", "not-a-number" as unknown as number),
    );
    expect(isAppError(error) && error.kind).toBe("validation");

    const after = await database.db.one<{ value: string }>(
      "select value::text as value from app_config where key = $1",
      ["platform.commission_rate_bp"],
    );
    expect(after.value).toBe(before.value);
  });
});
