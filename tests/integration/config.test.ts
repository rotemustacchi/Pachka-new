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
import { useTestDatabase } from "../harness";

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
    const rate = await getConfig(database.db, "platform.commission_rate");
    expect(rate).toBe(0.15);
  });

  it("returns the code-declared default when the row is missing from the table entirely", async () => {
    await database.db.query("delete from app_config where key = $1", [
      "shipping.unshipped_grace_days",
    ]);

    const value = await getConfig(database.db, "shipping.unshipped_grace_days");
    expect(value).toBe(3); // the registry's default, not a database read
  });

  it("rejects a stored value whose JS shape does not match its declared type", async () => {
    // The value_type column still says "number" — an operator edited `value`
    // directly and left the declared type alone (or lied about it either
    // way; both must be caught, not silently coerced).
    await database.db.query(
      "update app_config set value = $2::jsonb where key = $1",
      ["platform.commission_rate", JSON.stringify("not-a-number")],
    );

    const error = await captureError(() => getConfig(database.db, "platform.commission_rate"));
    expect(isAppError(error) && error.kind).toBe("validation");
    expect(isAppError(error) && error.message).toContain("platform.commission_rate");
  });

  it("rejects a row whose value_type column disagrees with the registry's declared type", async () => {
    await database.db.query("update app_config set value_type = $2 where key = $1", [
      "platform.commission_rate",
      "string",
    ]);

    const error = await captureError(() => getConfig(database.db, "platform.commission_rate"));
    expect(isAppError(error) && error.kind).toBe("validation");
    expect(isAppError(error) && error.message).toContain("platform.commission_rate");
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
      JSON.stringify(99),
    ]);

    const second = await getConfig(database.db, "matchmaker.result_count");
    expect(second).toBe(5); // still the cached value, not the freshly written 99
  });

  it("invalidateConfig() forces the next read to hit the database again", async () => {
    await getConfig(database.db, "matchmaker.result_count");

    await database.db.query("update app_config set value = $2::jsonb where key = $1", [
      "matchmaker.result_count",
      JSON.stringify(99),
    ]);
    invalidateConfig(database.db, "matchmaker.result_count");

    const value = await getConfig(database.db, "matchmaker.result_count");
    expect(value).toBe(99);
  });

  it("invalidateConfig() with no key clears every cached key for that client", async () => {
    await getConfig(database.db, "matchmaker.result_count");
    await getConfig(database.db, "platform.commission_rate");

    await database.db.query("update app_config set value = $2::jsonb where key = $1", [
      "matchmaker.result_count",
      JSON.stringify(99),
    ]);
    await database.db.query("update app_config set value = $2::jsonb where key = $1", [
      "platform.commission_rate",
      JSON.stringify(0.2),
    ]);
    invalidateConfig(database.db);

    expect(await getConfig(database.db, "matchmaker.result_count")).toBe(99);
    expect(await getConfig(database.db, "platform.commission_rate")).toBe(0.2);
  });

  it("a stale cache entry expires on its own once the TTL elapses, with no explicit invalidation", async () => {
    vi.useFakeTimers();
    try {
      const first = await getConfig(database.db, "matchmaker.result_count");
      expect(first).toBe(5);

      await database.db.query("update app_config set value = $2::jsonb where key = $1", [
        "matchmaker.result_count",
        JSON.stringify(99),
      ]);

      vi.advanceTimersByTime(CONFIG_CACHE_TTL_MS + 1);

      const second = await getConfig(database.db, "matchmaker.result_count");
      expect(second).toBe(99);
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

describe("setConfig()", () => {
  const database = useTestDatabase();

  it("writes a new value and getConfig immediately reflects it (no stale cache)", async () => {
    await getConfig(database.db, "platform.commission_rate"); // warm the cache first
    await setConfig(database.db, "platform.commission_rate", 0.18);

    expect(await getConfig(database.db, "platform.commission_rate")).toBe(0.18);

    const row = await database.db.one<{ value: number }>(
      "select value::text::float8 as value from app_config where key = $1",
      ["platform.commission_rate"],
    );
    expect(row.value).toBe(0.18);
  });

  it("inserts the row when the key is missing from the table entirely (a new key deployed ahead of its migration)", async () => {
    await database.db.query("delete from app_config where key = $1", [
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
      ["platform.commission_rate"],
    );

    await setConfig(database.db, "platform.commission_rate", 0.2);

    const after = await database.db.one<{ description: string; is_public: boolean }>(
      "select description, is_public from app_config where key = $1",
      ["platform.commission_rate"],
    );
    expect(after.description).toBe(before.description);
    expect(after.is_public).toBe(before.is_public);
  });

  it("rejects a wrong-shaped value before writing anything", async () => {
    const before = await database.db.one<{ value: string }>(
      "select value::text as value from app_config where key = $1",
      ["platform.commission_rate"],
    );

    const error = await captureError(() =>
      setConfig(database.db, "platform.commission_rate", "not-a-number" as unknown as number),
    );
    expect(isAppError(error) && error.kind).toBe("validation");

    const after = await database.db.one<{ value: string }>(
      "select value::text as value from app_config where key = $1",
      ["platform.commission_rate"],
    );
    expect(after.value).toBe(before.value);
  });
});
