/**
 * Invariants that must hold for EVERY table in `public`, not just the ones a
 * given team remembered.
 *
 * SECURITY.md S0-1 asks for exactly this test and says why: "This test is what
 * stops the eleventh table from shipping unprotected." It is deliberately
 * written against the catalog rather than against a list of table names, so it
 * starts covering a new table the moment that table exists, with no edit here.
 *
 * It lives outside `modules/` because it belongs to no module. Whichever team
 * ships a table without row-level security finds out from this file.
 */
import { describe, expect, it } from "vitest";
import { useTestDatabase } from "../harness";

interface TableRow {
  readonly table_name: string;
  readonly rls_enabled: boolean;
  readonly rls_forced: boolean;
  readonly policy_count: string;
}

async function tables(db: {
  query<T>(text: string, params?: readonly unknown[]): Promise<{ rows: T[] }>;
}): Promise<TableRow[]> {
  const { rows } = await db.query<TableRow>(`
    select
      c.relname                                          as table_name,
      c.relrowsecurity                                   as rls_enabled,
      c.relforcerowsecurity                              as rls_forced,
      (select count(*) from pg_policy p
        where p.polrelid = c.oid)::text                  as policy_count
    from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relkind = 'r'
      -- The migration ledger is infrastructure, not application data. It holds
      -- filenames and checksums, is written only by the migration runner on the
      -- privileged connection, and has no grant to anon or authenticated.
      and c.relname <> 'schema_migrations'
    order by c.relname
  `);
  return rows;
}

describe("every table in public", () => {
  const database = useTestDatabase();

  it("has row-level security enabled", async () => {
    const offenders = (await tables(database.db))
      .filter((t) => !t.rls_enabled)
      .map((t) => t.table_name);

    expect(offenders, `tables without ENABLE ROW LEVEL SECURITY: ${offenders.join(", ")}`).toEqual(
      [],
    );
  });

  it("has row-level security forced, so the owner cannot read past its own policies", async () => {
    // Without FORCE, the role migrations run as bypasses the policies on the
    // tables it owns -- which quietly makes integration tests pass that should
    // fail (SECURITY.md S0-1 item 5).
    const offenders = (await tables(database.db))
      .filter((t) => !t.rls_forced)
      .map((t) => t.table_name);

    expect(offenders, `tables without FORCE ROW LEVEL SECURITY: ${offenders.join(", ")}`).toEqual(
      [],
    );
  });

  it("has at least one policy, so RLS is a rule and not just a switch", async () => {
    // ENABLE with no policy denies everything, which is safe but is almost
    // always an unfinished migration rather than an intent.
    const offenders = (await tables(database.db))
      .filter((t) => t.policy_count === "0")
      .map((t) => t.table_name);

    expect(offenders, `tables with RLS enabled but no policy: ${offenders.join(", ")}`).toEqual([]);
  });

  it("is covered by this test at all", async () => {
    // Guards against the query above silently matching nothing -- which would
    // make all three assertions above vacuously pass forever.
    const names = (await tables(database.db)).map((t) => t.table_name);

    expect(names).toContain("app_config");
    expect(names).toContain("artist_contact_details");
    expect(names.length).toBeGreaterThanOrEqual(7);
  });
});

describe("every SECURITY DEFINER function", () => {
  const database = useTestDatabase();

  it("pins its search_path", async () => {
    // SECURITY.md S0-2 item 2: a SECURITY DEFINER function without a pinned
    // search_path is a privilege-escalation primitive. The caller creates an
    // object in a schema that resolves earlier and the definer runs it with the
    // definer's rights.
    const { rows } = await database.db.query<{ schema: string; name: string }>(`
      select n.nspname as schema, p.proname as name
      from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
      where p.prosecdef
        and n.nspname not in ('pg_catalog', 'information_schema')
        and not exists (
          select 1 from unnest(coalesce(p.proconfig, '{}')) as cfg
          where cfg like 'search\\_path=%'
        )
      order by 1, 2
    `);

    const offenders = rows.map((r) => `${r.schema}.${r.name}`);
    expect(offenders, `SECURITY DEFINER without a pinned search_path: ${offenders.join(", ")}`)
      .toEqual([]);
  });

  it("includes the accounts policy helpers, so the check above is not vacuous", async () => {
    const { rows } = await database.db.query<{ name: string }>(`
      select p.proname as name
      from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
      where p.prosecdef and n.nspname = 'accounts'
      order by 1
    `);

    expect(rows.map((r) => r.name)).toContain("auth_has_role");
    expect(rows.map((r) => r.name)).toContain("auth_is_active");
  });
});
