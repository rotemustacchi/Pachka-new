import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CONFIG_REGISTRY, isConfigKey } from "./registry";
import { assertConfigValueMatchesType } from "./validate";

const MIGRATION_PATH = path.join(
  process.cwd(),
  "db",
  "migrations",
  "20260827T090100_create_app_config.sql",
);

/** Pull every `key` string out of the migration's `insert into app_config (...) values (...)` block. */
function seededKeys(): string[] {
  const sql = readFileSync(MIGRATION_PATH, "utf8");
  const matches = sql.matchAll(/\(\s*'([a-z0-9_]+\.[a-z0-9_.]+)'\s*,/g);
  return [...matches].map((m) => m[1] ?? "");
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
    expect(isConfigKey("platform.commission_rate")).toBe(true);
  });

  it("is false for an unregistered key", () => {
    expect(isConfigKey("no.such.key")).toBe(false);
  });
});
