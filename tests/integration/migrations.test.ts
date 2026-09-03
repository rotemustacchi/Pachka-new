/**
 * The migration runner, against a real database.
 *
 * These tests apply migrations to an empty database rather than relying on the
 * template the harness already migrated, because what is under test is the act
 * of migrating: the ledger, idempotency, drift detection, and the fact that a
 * failed migration leaves nothing behind.
 */
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  asAnon,
  asUser,
  createTestDatabase,
  privilegedUrl,
  withPrivilegedConnection,
  type TestDatabase,
} from "../harness";
import { LEDGER_TABLE, loadMigrations, migrate, migrationStatus } from "@/shared/db";

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
    // The runner creates tables, so it connects the way a deploy does: with
    // credentials that own the schema. The application role deliberately has no
    // CREATE on `public`.
    client = new Client({
      connectionString: privilegedUrl(
        database,
        "applying schema, which the migration runner does with owner credentials",
      ),
    });
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
      `select count(*)::text as count from ${LEDGER_TABLE} where name = '20260101T000000_create_widgets.sql'`,
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
      `select name from ${LEDGER_TABLE} where name = '20260101T000000_half_broken.sql'`,
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
    // Compared against what is on disk rather than a list written out here.
    // Ten teams add migrations to this directory in parallel; a hard-coded list
    // makes every one of them fail a test they do not own, which teaches people
    // to edit the assertion instead of reading it. What this test is actually
    // for is that applying the migrations leaves one ledger row per file.
    const onDisk = (await loadMigrations()).map((m) => m.name);

    // The ledger belongs to the migration runner, not to the application: it
    // is written with owner credentials at deploy time and the application role
    // has no reason to read it. So this reads it the way the runner would.
    const rows = await withPrivilegedConnection(
      database,
      "applying schema, which the migration runner does with owner credentials",
      async (client) =>
        (
          await client.query<{ name: string }>(
            `select name from ${LEDGER_TABLE} order by name`,
          )
        ).rows,
    );

    expect(rows.map((r) => r.name)).toEqual([...onDisk].sort());
    expect(onDisk.length).toBeGreaterThan(0);
  });

  it("seed the 15% commission design.md specifies, in basis points", async () => {
    const row = await database.db.one<{ value: string; value_type: string }>(
      "select value::text as value, value_type from app_config where key = 'platform.commission_rate_bp'",
    );
    expect(row).toEqual({ value: "1500", value_type: "integer" });
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
      "select updated_at from app_config where key = 'platform.commission_rate_bp'",
    );
    await database.db.query(
      "update app_config set value = '1800'::jsonb where key = 'platform.commission_rate_bp'",
    );
    const after = await database.db.one<{ updated_at: Date }>(
      "select updated_at from app_config where key = 'platform.commission_rate_bp'",
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

  it("is enabled and forced", async () => {
    const row = await database.db.one<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>(
      "select relrowsecurity, relforcerowsecurity from pg_class where relname = 'app_config'",
    );
    expect(row).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
  });

  it("is unreadable by an anonymous visitor", async () => {
    // Supabase publishes /rest/v1/app_config to anyone holding the anon key,
    // and that key ships in the client bundle. `anon` therefore has no grant at
    // all — SECURITY.md S1-16.
    await expect(
      asAnon(database.dataApi, (tx) => tx.query("select key from app_config")),
    ).rejects.toThrow(/permission denied/i);
  });

  it("shows a signed-in user only the presentational rows", async () => {
    const visible = await asUser(database.dataApi, randomUUID(), async (tx) => {
      const { rows } = await tx.query<{ key: string }>("select key from app_config");
      return rows.map((r) => r.key);
    });

    expect(visible).toContain("returns.window_days");
    expect(visible).not.toContain("platform.commission_rate_bp");
    expect(visible).not.toContain("moderation.operator_email");
    expect(visible).not.toContain("matchmaker.weight_embedding");
  });

  it("refuses writes from a signed-in user", async () => {
    await expect(
      asUser(database.dataApi, randomUUID(), (tx) =>
        tx.query("update app_config set value = '0'::jsonb where key = 'returns.window_days'"),
      ),
    ).rejects.toThrow();

    const row = await database.db.one<{ value: string }>(
      "select value::text as value from app_config where key = 'returns.window_days'",
    );
    expect(row.value).toBe("14");
  });
});

describe("app_config bounds", () => {
  let database: TestDatabase;

  beforeEach(async () => {
    database = await createTestDatabase();
  });

  afterEach(async () => {
    await database.drop();
  });

  it("stores commission as integer basis points, not a float", async () => {
    const row = await database.db.one<{ value: string; value_type: string }>(
      "select value::text as value, value_type from app_config where key = 'platform.commission_rate_bp'",
    );
    expect(row).toEqual({ value: "1500", value_type: "integer" });

    const legacy = await database.db.maybeOne(
      "select 1 from app_config where key = 'platform.commission_rate'",
    );
    expect(legacy).toBeNull();
  });

  it.each([
    ["a commission of 100%", "platform.commission_rate_bp", "10000"],
    ["a negative commission", "platform.commission_rate_bp", "-100"],
    ["a thirty-day reservation hold", "checkout.reservation_ttl_minutes", "43200"],
    ["a disabled quality gate", "upload.min_shorter_edge_px", "0"],
    ["a ranking weight that swamps every other signal", "matchmaker.weight_embedding", "99"],
    ["an unlawful cancellation fee", "returns.cancellation_fee_rate", "0.25"],
  ])("refuses %s", async (_case, key, value) => {
    await expect(
      database.db.query("update app_config set value = $2::jsonb where key = $1", [key, value]),
    ).rejects.toThrow(/app_config_value_within_bounds/);

    // And the previous value is still what a module would read.
    const row = await database.db.one<{ value: string }>(
      "select value::text as value from app_config where key = $1",
      [key],
    );
    expect(row.value).not.toBe(value);
  });

  it("accepts a change an operator is entitled to make", async () => {
    await database.db.query(
      "update app_config set value = '1200'::jsonb where key = 'platform.commission_rate_bp'",
    );

    const row = await database.db.one<{ value: string }>(
      "select value::text as value from app_config where key = 'platform.commission_rate_bp'",
    );
    expect(row.value).toBe("1200");
  });

  it("refuses a value of the wrong declared type", async () => {
    await expect(
      database.db.query(
        "update app_config set value = '\"fifteen percent\"'::jsonb where key = 'platform.commission_rate_bp'",
      ),
    ).rejects.toThrow(/app_config_value_matches_declared_type/);
  });

  it("refuses a fractional value for a key declared integer", async () => {
    await expect(
      database.db.query(
        "update app_config set value = '30.5'::jsonb where key = 'checkout.reservation_ttl_minutes'",
      ),
    ).rejects.toThrow(/app_config_value_matches_declared_type/);
  });
});
