/**
 * The migration runner, against a real database.
 *
 * These tests apply migrations to an empty database rather than relying on the
 * template the harness already migrated, because what is under test is the act
 * of migrating: the ledger, idempotency, drift detection, and the fact that a
 * failed migration leaves nothing behind.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase } from "../harness";
import { migrate, migrationStatus } from "@/shared/db";

/**
 * A scratch migrations directory. The real `db/migrations` is already applied
 * in every test database; these tests need to control what gets applied.
 */
async function migrationsDir(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "pachka-migrations-"));
  for (const [name, sql] of Object.entries(files)) {
    await writeFile(path.join(dir, name), sql, "utf8");
  }
  return dir;
}

describe("migration runner", () => {
  let database: TestDatabase;
  let client: Client;
  const scratchDirs: string[] = [];

  beforeEach(async () => {
    database = await createTestDatabase();
    client = new Client({ connectionString: database.url });
    await client.connect();
  });

  afterEach(async () => {
    await client.end();
    await database.drop();
    await Promise.all(scratchDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
  });

  const scratch = async (files: Record<string, string>) => {
    const dir = await migrationsDir(files);
    scratchDirs.push(dir);
    return dir;
  };

  it("applies pending migrations in filename order", async () => {
    const dir = await scratch({
      "20260101T000000_create_widgets.sql": "create table widgets (id integer primary key);",
      "20260102T000000_add_widget_label.sql": "alter table widgets add column label text;",
    });

    const applied = await migrate(client, dir);

    expect(applied).toEqual([
      "20260101T000000_create_widgets.sql",
      "20260102T000000_add_widget_label.sql",
    ]);
    // The second migration only parses if the first ran first.
    const { rows } = await client.query<{ column_name: string }>(
      "select column_name from information_schema.columns where table_name = 'widgets' order by column_name",
    );
    expect(rows.map((r) => r.column_name)).toEqual(["id", "label"]);
  });

  it("does nothing on a second run", async () => {
    const dir = await scratch({
      "20260101T000000_create_widgets.sql": "create table widgets (id integer primary key);",
    });
    await migrate(client, dir);

    const second = await migrate(client, dir);

    expect(second).toEqual([]);
    const { rows } = await client.query<{ count: string }>(
      "select count(*)::text as count from schema_migrations where name = '20260101T000000_create_widgets.sql'",
    );
    expect(rows[0]?.count).toBe("1");
  });

  it("refuses to run when an already-applied migration has been edited", async () => {
    const dir = await scratch({
      "20260101T000000_create_widgets.sql": "create table widgets (id integer primary key);",
    });
    await migrate(client, dir);

    await writeFile(
      path.join(dir, "20260101T000000_create_widgets.sql"),
      "create table widgets (id bigint primary key);",
      "utf8",
    );

    await expect(migrate(client, dir)).rejects.toThrow(/contents have changed/i);
    const [status] = await migrationStatus(client, dir);
    expect(status?.drifted).toBe(true);
  });

  it("leaves the database untouched when a migration fails part-way", async () => {
    const dir = await scratch({
      "20260101T000000_half_broken.sql": [
        "create table survivors (id integer primary key);",
        "create table survivors (id integer primary key);", // duplicate: fails
      ].join("\n"),
    });

    await expect(migrate(client, dir)).rejects.toThrow(/20260101T000000_half_broken\.sql/);

    const table = await client.query("select to_regclass('survivors') as oid");
    expect(table.rows[0]).toEqual({ oid: null });
    // The database was cloned from the migrated template, so its ledger holds
    // the real migrations. What must not be there is the one that just failed.
    const ledger = await client.query<{ name: string }>(
      "select name from schema_migrations where name = '20260101T000000_half_broken.sql'",
    );
    expect(ledger.rows).toEqual([]);
  });

  it("rejects a filename that does not follow the convention", async () => {
    const dir = await scratch({ "0001_widgets.sql": "select 1;" });

    await expect(migrate(client, dir)).rejects.toThrow(/filenames must match/i);
  });

  it("reports pending migrations before they are applied", async () => {
    const dir = await scratch({
      "20260101T000000_create_widgets.sql": "create table widgets (id integer primary key);",
    });

    const before = await migrationStatus(client, dir);
    expect(before).toEqual([
      { name: "20260101T000000_create_widgets.sql", applied: false, appliedAt: null, drifted: false },
    ]);

    await migrate(client, dir);

    const after = await migrationStatus(client, dir);
    expect(after[0]?.applied).toBe(true);
    expect(after[0]?.appliedAt).toBeInstanceOf(Date);
  });
});

describe("the real migrations", () => {
  let database: TestDatabase;

  beforeEach(async () => {
    database = await createTestDatabase();
  });

  afterEach(async () => {
    await database.drop();
  });

  it("record themselves in the ledger", async () => {
    const { rows } = await database.db.query<{ name: string }>(
      "select name from schema_migrations order by name",
    );
    expect(rows.map((r) => r.name)).toEqual([
      "20260827T090000_bootstrap_platform.sql",
      "20260827T090100_create_app_config.sql",
    ]);
  });

  it("seed the commission rate design.md specifies", async () => {
    const row = await database.db.one<{ value: string; value_type: string }>(
      "select value::text as value, value_type from app_config where key = 'platform.commission_rate'",
    );
    expect(row).toEqual({ value: "0.15", value_type: "number" });
  });

  it("seed the upload thresholds the upload-pipeline spec states", async () => {
    const { rows } = await database.db.query<{ key: string; value: string }>(
      "select key, value::text as value from app_config where key in ($1, $2) order by key",
      ["upload.min_file_size_bytes", "upload.min_shorter_edge_px"],
    );
    expect(rows).toEqual([
      { key: "upload.min_file_size_bytes", value: "102400" },
      { key: "upload.min_shorter_edge_px", value: "1200" },
    ]);
  });

  it("keep updated_at honest through the shared trigger", async () => {
    const before = await database.db.one<{ updated_at: Date }>(
      "select updated_at from app_config where key = 'platform.commission_rate'",
    );
    await database.db.query(
      "update app_config set value = '0.18'::jsonb where key = 'platform.commission_rate'",
    );
    const after = await database.db.one<{ updated_at: Date }>(
      "select updated_at from app_config where key = 'platform.commission_rate'",
    );

    expect(after.updated_at.getTime()).toBeGreaterThan(before.updated_at.getTime());
  });
});

describe("row-level security on app_config", () => {
  let database: TestDatabase;

  beforeEach(async () => {
    database = await createTestDatabase();
  });

  afterEach(async () => {
    await database.drop();
  });

  it("is enabled on the table", async () => {
    const row = await database.db.one<{ relrowsecurity: boolean }>(
      "select relrowsecurity from pg_class where relname = 'app_config'",
    );
    expect(row.relrowsecurity).toBe(true);
  });

  it("hides non-public rows from an anonymous browser session", async () => {
    // Exactly what the anon key gets: the `anon` role, no JWT claims.
    const visible = await database.db.withTransaction(async (tx) => {
      await tx.query("set local role anon");
      const { rows } = await tx.query<{ key: string }>("select key from app_config");
      return rows.map((r) => r.key);
    });

    expect(visible).toContain("returns.window_days");
    expect(visible).not.toContain("platform.commission_rate");
    expect(visible).not.toContain("moderation.operator_email");
  });

  it("refuses writes from an authenticated browser session", async () => {
    await expect(
      database.db.withTransaction(async (tx) => {
        await tx.query("set local role authenticated");
        await tx.query(
          "update app_config set value = '0.01'::jsonb where key = 'returns.window_days'",
        );
      }),
    ).rejects.toThrow();

    const row = await database.db.one<{ value: string }>(
      "select value::text as value from app_config where key = 'returns.window_days'",
    );
    expect(row.value).toBe("14");
  });
});
