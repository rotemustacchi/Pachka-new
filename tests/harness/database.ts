/**
 * A clean, real database for a single test.
 *
 * ARCHITECTURE.md requires that every test create the data it needs, clean up
 * after itself, and pass alone, in any order, and on repeat. The cheapest way
 * to guarantee that for a database is not to clean up at all: give each test
 * its own database, cloned from a template that already has the migrations
 * applied, and drop it afterwards.
 *
 *   • `create database ... template pachka_template` is a file copy inside
 *     Postgres — fast enough to do per test, and byte-identical every time.
 *   • Nothing is shared between tests, so there is no ordering to get wrong and
 *     no truncation list to keep in sync as teams add tables.
 *   • Each test gets a real connection pool, so genuinely parallel transactions
 *     and `select ... for update` behave exactly as they do in production.
 *     A rollback-per-test harness could not offer that.
 *
 * Usage — the common case:
 *
 *     import { useTestDatabase } from "../harness";
 *
 *     describe("reservations", () => {
 *       const db = useTestDatabase();
 *
 *       it("locks the artwork row", async () => {
 *         await db.query("insert into ...");
 *       });
 *     });
 *
 * `db` is live from `beforeEach` onward and is a different database in every
 * test. For finer control, call `createTestDatabase()` yourself and `drop()` it.
 */
import { randomBytes } from "node:crypto";
import { Client, Pool } from "pg";
import { afterEach, beforeEach, inject } from "vitest";
import { createDatabase } from "@/shared/db";
import type { Database } from "@/shared/db";
import { databaseUrl } from "./url";

export interface TestDatabase {
  /** Name of the throwaway database, e.g. `pachka_t_9f3a...`. */
  readonly name: string;
  /** Connection URL for it. Pass to anything that takes a connection string. */
  readonly url: string;
  /** The real `shared/db` client, pointed at this database. */
  readonly db: Database;
  /** A raw pool, for tests that need to hold connections themselves. */
  readonly pool: Pool;
  /** Close connections and delete the database. */
  drop(): Promise<void>;
}

async function onAdmin<T>(fn: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: inject("pachkaAdminUrl") });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

export async function createTestDatabase(): Promise<TestDatabase> {
  const template = inject("pachkaTemplate");
  const name = `pachka_t_${randomBytes(8).toString("hex")}`;

  await onAdmin((admin) => admin.query(`create database ${name} template ${template}`));

  const url = databaseUrl(inject("pachkaAdminUrl"), name);
  const pool = new Pool({ connectionString: url, max: 10 });
  pool.on("error", () => {
    /* discarded by pg on the next checkout */
  });
  const db = createDatabase({ connectionString: url, max: 10 });

  return {
    name,
    url,
    db,
    pool,
    async drop() {
      await Promise.allSettled([db.end(), pool.end()]);
      // `with (force)` terminates any connection a test forgot to close, so one
      // leaky test cannot wedge the run.
      await onAdmin((admin) => admin.query(`drop database if exists ${name} with (force)`));
    },
  };
}

/**
 * Register a fresh database for each test in the enclosing suite.
 *
 * The returned handle proxies to whichever database the current test owns, so
 * it can safely be captured once at describe level.
 */
export function useTestDatabase(): TestDatabase {
  let current: TestDatabase | undefined;

  beforeEach(async () => {
    current = await createTestDatabase();
  });

  afterEach(async () => {
    const finished = current;
    current = undefined;
    await finished?.drop();
  });

  const live = (): TestDatabase => {
    if (!current) {
      throw new Error(
        "useTestDatabase() was read outside a test. Use it inside it()/beforeEach, not at module load.",
      );
    }
    return current;
  };

  return {
    get name() {
      return live().name;
    },
    get url() {
      return live().url;
    },
    get db() {
      return live().db;
    },
    get pool() {
      return live().pool;
    },
    drop: () => live().drop(),
  };
}
