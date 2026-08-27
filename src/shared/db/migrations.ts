/**
 * Forward-only, additive migration runner.
 *
 * See `db/README.md` for the convention this enforces. In short:
 *   • migrations are files, applied in filename order, and never edited again
 *   • there are no `down` migrations — a mistake is corrected by a new file
 *   • destructive DDL is rejected by the linter, not by review alone
 *
 * The runner is used by `scripts/migrate.ts` (developers, CI, deploys) and by
 * the integration-test harness, which applies the same files to the template
 * database. There is exactly one code path that creates schema, so a test can
 * never pass against a schema that production will not have.
 */
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { Client, ClientBase, Pool } from "pg";

export const MIGRATIONS_DIR = path.join(process.cwd(), "db", "migrations");

/** Filenames must sort chronologically: `20260827T120000_add_app_config.sql`. */
const FILENAME = /^\d{8}T\d{6}_[a-z0-9]+(?:_[a-z0-9]+)*\.sql$/;

export interface Migration {
  readonly name: string;
  readonly sql: string;
  readonly checksum: string;
}

export interface MigrationStatus {
  readonly name: string;
  readonly applied: boolean;
  readonly appliedAt: Date | null;
  /** True when the file on disk no longer matches what was applied. */
  readonly drifted: boolean;
}

type Queryable = Pick<ClientBase, "query">;

function checksumOf(sql: string): string {
  // Normalise line endings so a checkout on Windows does not read as drift.
  return createHash("sha256").update(sql.replace(/\r\n/g, "\n")).digest("hex");
}

export async function loadMigrations(dir: string = MIGRATIONS_DIR): Promise<Migration[]> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw cause;
  }

  const files = entries.filter((f) => f.endsWith(".sql")).sort();
  const bad = files.filter((f) => !FILENAME.test(f));
  if (bad.length > 0) {
    throw new Error(
      `Migration filenames must match <UTC timestamp>_<snake_case>.sql — rejected: ${bad.join(", ")}`,
    );
  }

  return Promise.all(
    files.map(async (name) => {
      const sql = await readFile(path.join(dir, name), "utf8");
      return { name, sql, checksum: checksumOf(sql) };
    }),
  );
}

async function ensureLedger(db: Queryable): Promise<void> {
  await db.query(`
    create table if not exists schema_migrations (
      name        text        primary key,
      checksum    text        not null,
      applied_at  timestamptz not null default now()
    )
  `);
}

/**
 * Apply every migration that has not been applied yet, in order.
 *
 * Each migration and its ledger row are committed together, so an interrupted
 * run leaves the database at a migration boundary rather than half-way through
 * one. Returns the names actually applied.
 */
export async function migrate(
  db: Client | Pool,
  dir: string = MIGRATIONS_DIR,
): Promise<string[]> {
  await ensureLedger(db);
  const migrations = await loadMigrations(dir);
  const applied = await appliedMap(db);
  const ran: string[] = [];

  for (const migration of migrations) {
    const previous = applied.get(migration.name);
    if (previous) {
      if (previous.checksum !== migration.checksum) {
        throw new Error(
          `Migration ${migration.name} was already applied but its contents have changed. ` +
            `Applied migrations are immutable — correct it with a new migration instead.`,
        );
      }
      continue;
    }

    await db.query("begin");
    try {
      await db.query(migration.sql);
      await db.query("insert into schema_migrations (name, checksum) values ($1, $2)", [
        migration.name,
        migration.checksum,
      ]);
      await db.query("commit");
    } catch (cause) {
      await db.query("rollback");
      throw new Error(`Migration ${migration.name} failed: ${(cause as Error).message}`, {
        cause,
      });
    }
    ran.push(migration.name);
  }

  return ran;
}

async function appliedMap(
  db: Queryable,
): Promise<Map<string, { checksum: string; appliedAt: Date }>> {
  const { rows } = await db.query<{ name: string; checksum: string; applied_at: Date }>(
    "select name, checksum, applied_at from schema_migrations",
  );
  return new Map(rows.map((r) => [r.name, { checksum: r.checksum, appliedAt: r.applied_at }]));
}

export async function status(
  db: Client | Pool,
  dir: string = MIGRATIONS_DIR,
): Promise<MigrationStatus[]> {
  await ensureLedger(db);
  const migrations = await loadMigrations(dir);
  const applied = await appliedMap(db);
  return migrations.map((m) => {
    const previous = applied.get(m.name);
    return {
      name: m.name,
      applied: previous !== undefined,
      appliedAt: previous?.appliedAt ?? null,
      drifted: previous !== undefined && previous.checksum !== m.checksum,
    };
  });
}

/**
 * Statements that are forbidden in an additive, forward-only migration.
 *
 * The MVP deploys by rolling the Vercel deployment back while the database
 * stays where it is (design.md, "Migration Plan"). That only works if every
 * migration leaves the previous release's queries valid. Dropping or renaming
 * a column breaks the running release the moment the migration lands, so the
 * deprecation path is: add the new thing, migrate readers, and remove the old
 * thing in a later change once no deployed code references it.
 */
const DESTRUCTIVE: ReadonlyArray<{ pattern: RegExp; why: string }> = [
  { pattern: /\bdrop\s+table\b/i, why: "drop table" },
  { pattern: /\bdrop\s+column\b/i, why: "drop column" },
  { pattern: /\bdrop\s+schema\b/i, why: "drop schema" },
  { pattern: /\bdrop\s+database\b/i, why: "drop database" },
  { pattern: /\brename\s+to\b/i, why: "rename" },
  { pattern: /\brename\s+column\b/i, why: "rename column" },
  { pattern: /\balter\s+column\s+\w+\s+type\b/i, why: "column type change" },
  { pattern: /\btruncate\b/i, why: "truncate" },
];

/** Strip comments so `-- drop table` in prose is not read as a statement. */
function stripComments(sql: string): string {
  return sql.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--[^\n]*/g, " ");
}

export interface LintFinding {
  readonly name: string;
  readonly why: string;
}

export async function lintMigrations(dir: string = MIGRATIONS_DIR): Promise<LintFinding[]> {
  const migrations = await loadMigrations(dir);
  const findings: LintFinding[] = [];
  for (const migration of migrations) {
    const body = stripComments(migration.sql);
    for (const rule of DESTRUCTIVE) {
      if (rule.pattern.test(body)) findings.push({ name: migration.name, why: rule.why });
    }
  }
  return findings;
}

/** `20260827T134501_add_app_config.sql` for a migration created right now. */
export function migrationFilename(slug: string, now: Date = new Date()): string {
  const normalised = slug
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (normalised === "") throw new Error("Migration name must contain letters or digits");
  const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "");
  return `${stamp}_${normalised}.sql`;
}
