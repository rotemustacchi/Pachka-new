import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CONFIG_REGISTRY, isConfigKey } from "./registry";
import { assertConfigValueMatchesType } from "./validate";

const MIGRATIONS_DIR = path.join(process.cwd(), "db", "migrations");

/**
 * The set of keys the migrations leave behind, replayed in filename order.
 *
 * Reading only the first migration was wrong: a later migration may rename a
 * key by seeding the new one and deleting the old, which is exactly what
 * 20260827T101500 does to turn a float commission rate into integer basis
 * points. Honour the deletes, or this test asserts against a schema that no
 * longer exists.
 */
function seededKeys(): string[] {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  const keys = new Set<string>();
  for (const file of files) {
    const sql = readFileSync(path.join(MIGRATIONS_DIR, file), "utf8");
    // Negative lookbehind: current_setting('request.jwt.claim.sub', true) in
    // the RLS policies has the same shape as a seeded key and is not one.
    for (const m of sql.matchAll(/(?<!current_setting)\(\s*'([a-z0-9_]+\.[a-z0-9_.]+)'\s*,/g)) {
      if (m[1]) keys.add(m[1]);
    }
    for (const m of sql.matchAll(/delete\s+from\s+app_config\s+where\s+key\s*=\s*'([a-z0-9_.]+)'/gi)) {
      if (m[1]) keys.delete(m[1]);
    }
  }
  return [...keys];
}

describe("CONFIG_REGISTRY", () => {
  it("has exactly one entry per key seeded in the app_config migration — neither more nor fewer", () => {
    const seeded = [...seededKeys()].sort();
    const registered = [...Object.keys(CONFIG_REGISTRY)].sort();
    expect(registered).toEqual(seeded);
  });

  it("every entry's own default value satisfies its own declared valueType", () => {
    for (const [key, definition] of Object.entries(CONFIG_REGISTRY)) {
      expect(() => assertConfigValueMatchesType(key, definition.valueType, definition.default)).not.toThrow();
    }
  });
});

describe("isConfigKey()", () => {
  it("is true for a real key", () => {
    expect(isConfigKey("platform.commission_rate_bp")).toBe(true);
  });

  it("is false for an unregistered key", () => {
    expect(isConfigKey("no.such.key")).toBe(false);
  });
});
