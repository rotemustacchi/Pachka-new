/**
 * The additive, forward-only convention (db/README.md), enforced in code.
 *
 * The last test in this file runs the linter over the migrations that are
 * actually committed, so a destructive migration fails the suite rather than
 * relying on somebody noticing it in review.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { lintMigrations, loadMigrations, migrationFilename } from "@/shared/db";

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function withMigrations(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "pachka-lint-"));
  dirs.push(dir);
  for (const [name, sql] of Object.entries(files)) {
    await writeFile(path.join(dir, name), sql, "utf8");
  }
  return dir;
}

describe("migration linter", () => {
  it.each([
    ["drop table", "drop table artworks;"],
    ["drop column", "alter table artworks drop column price;"],
    ["rename", "alter table artworks rename to works;"],
    ["rename column", "alter table artworks rename column price to price_agorot;"],
    ["column type change", "alter table artworks alter column price type bigint;"],
    ["truncate", "truncate table artworks;"],
  ])("rejects %s", async (why, sql) => {
    const dir = await withMigrations({ "20260101T000000_bad.sql": sql });

    const findings = await lintMigrations(dir);

    expect(findings).toEqual([{ name: "20260101T000000_bad.sql", why }]);
  });

  it("accepts the additive statements a migration is allowed to use", async () => {
    const dir = await withMigrations({
      "20260101T000000_additive.sql": [
        "create table artworks (id uuid primary key);",
        "alter table artworks add column price_agorot bigint;",
        "create index artworks_price_idx on artworks (price_agorot);",
        "alter table artworks enable row level security;",
        "create policy artworks_read on artworks for select to anon using (true);",
        "update artworks set price_agorot = 0 where price_agorot is null;",
      ].join("\n"),
    });

    expect(await lintMigrations(dir)).toEqual([]);
  });

  it("does not mistake prose in a comment for a statement", async () => {
    const dir = await withMigrations({
      "20260101T000000_commented.sql": [
        "-- Superseded by artwork_variants; we do not drop table artworks here.",
        "/* A later change will drop column legacy_price once nothing reads it. */",
        "alter table artworks add column legacy_price_note text;",
      ].join("\n"),
    });

    expect(await lintMigrations(dir)).toEqual([]);
  });

  it("names every offending file when several are wrong", async () => {
    const dir = await withMigrations({
      "20260101T000000_a.sql": "drop table one;",
      "20260102T000000_b.sql": "alter table two add column ok text;",
      "20260103T000000_c.sql": "truncate three;",
    });

    const findings = await lintMigrations(dir);

    expect(findings.map((f) => f.name)).toEqual([
      "20260101T000000_a.sql",
      "20260103T000000_c.sql",
    ]);
  });
});

describe("migration filenames", () => {
  it("are timestamped so two teams cannot claim the same slot", () => {
    const at = new Date("2026-08-27T13:45:01.123Z");

    expect(migrationFilename("add artwork images", at)).toBe(
      "20260827T134501_add_artwork_images.sql",
    );
  });

  it("normalise punctuation and casing rather than rejecting it", () => {
    const at = new Date("2026-08-27T13:45:01.000Z");

    expect(migrationFilename("  Add Artist-Payout Details!  ", at)).toBe(
      "20260827T134501_add_artist_payout_details.sql",
    );
  });

  it("refuse a name with nothing in it", () => {
    expect(() => migrationFilename("   ---  ")).toThrow(/must contain letters or digits/i);
  });

  it("sort chronologically as strings, which is how they are applied", () => {
    const names = [
      migrationFilename("later", new Date("2026-12-01T00:00:00Z")),
      migrationFilename("earlier", new Date("2026-01-01T00:00:00Z")),
      migrationFilename("middle", new Date("2026-06-15T09:30:00Z")),
    ];

    expect([...names].sort()).toEqual([names[1], names[2], names[0]]);
  });

  it("are accepted by the loader that applies them", async () => {
    const name = migrationFilename("probe", new Date("2026-08-27T13:45:01Z"));
    const dir = await withMigrations({ [name]: "select 1;" });

    const loaded = await loadMigrations(dir);

    expect(loaded.map((m) => m.name)).toEqual([name]);
  });
});

describe("the migrations in this repository", () => {
  it("are all additive", async () => {
    expect(await lintMigrations()).toEqual([]);
  });

  it("all follow the filename convention and are readable", async () => {
    const loaded = await loadMigrations();

    expect(loaded.length).toBeGreaterThan(0);
    for (const migration of loaded) {
      expect(migration.name).toMatch(/^\d{8}T\d{6}_[a-z0-9_]+\.sql$/);
      expect(migration.checksum).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it("each name the module that owns the tables they touch", async () => {
    const loaded = await loadMigrations();

    for (const migration of loaded) {
      expect(migration.sql, `${migration.name} is missing an "Owner:" header`).toMatch(
        /^--\s*Owner:\s*\S+/m,
      );
    }
  });
});
