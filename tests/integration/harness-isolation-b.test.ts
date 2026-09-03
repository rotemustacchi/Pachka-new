/**
 * Isolation proof, half B. See `harness-isolation-a.test.ts` for half A.
 *
 * These two files are the harness's own test. Both write a row with the SAME
 * primary key into `app_config` and both create a table with the same name. If
 * the harness ever stopped giving each test its own database — if it started
 * sharing one and truncating, or forgot to clean up — whichever of the two ran
 * second would fail on a duplicate key or a duplicate table. The proof does not
 * depend on which order they run in, because either order breaks.
 *
 * They also assert the positive property directly: the seeded configuration is
 * present and unmodified at the start of every test, so a mutation made by an
 * earlier test cannot be observed by a later one.
 */
import { describe, expect, it } from "vitest";
import { defineScratchTable, useTestDatabase } from "../harness";

const SHARED_KEY = "test.harness.isolation_probe";
const SHARED_TABLE = "harness_isolation_probe";

describe("harness isolation (B)", () => {
  const database = useTestDatabase();

  it("starts from the migrated schema with defaults intact", async () => {
    const row = await database.db.one<{ value: string }>(
      "select value::text as value from app_config where key = $1",
      ["platform.commission_rate_bp"],
    );
    expect(row.value).toBe("1500");
  });

  it("B: claims the shared config key and the shared table name", async () => {
    await database.db.query(
      "insert into app_config (key, value, value_type, description) values ($1, $2, 'string', $3)",
      [SHARED_KEY, JSON.stringify("written-by-B"), "written by isolation test B"],
    );
    await defineScratchTable(
      database,
      SHARED_TABLE,
      `create table ${SHARED_TABLE} (id integer primary key)`,
    );
    await database.db.query(`insert into ${SHARED_TABLE} (id) values (1)`);

    const probe = await database.db.one<{ value: string }>(
      "select value #>> '{}' as value from app_config where key = $1",
      [SHARED_KEY],
    );
    expect(probe.value).toBe("written-by-B");
  });

  it("B: sees no trace of the row the previous test in this very file wrote", async () => {
    const probe = await database.db.maybeOne("select 1 from app_config where key = $1", [
      SHARED_KEY,
    ]);
    expect(probe).toBeNull();

    const table = await database.db.maybeOne("select to_regclass($1) as oid", [SHARED_TABLE]);
    expect(table).toEqual({ oid: null });
  });

  it("B: gets a database nobody else is using", async () => {
    const { rows } = await database.db.query<{ current_database: string }>(
      "select current_database()",
    );
    expect(rows[0]?.current_database).toBe(database.name);
    expect(database.name).toMatch(/^pachka_t_[0-9a-f]{16}$/);
  });
});
