/**
 * The escape hatch back to the cluster superuser. Read this before using it.
 *
 * Every test connects as a non-superuser role (`login-roles.ts`), because a
 * superuser bypasses row-level security before `FORCE` or `BYPASSRLS` is even
 * consulted, and a suite running as one cannot tell a working policy from a
 * missing one. That property is worth almost nothing if a superuser connection
 * is also lying around ambient, one property access away, for whoever finds the
 * non-privileged one inconvenient. The first time a test reaches for this to
 * make a permission error go away, the suite is back to proving nothing and
 * nobody will notice.
 *
 * So the hatch is here, in its own module, behind a `reason` argument whose type
 * is a closed union of the uses that have actually been argued for. Adding a use
 * means adding a member to that union, which means writing down why — in a diff,
 * where a reviewer sees it. "It failed and this fixed it" is not a reason; a
 * permission error under the app role is a missing policy or a missing grant,
 * and the fix is a migration.
 *
 * Note what is NOT here. The migration runner also needs the superuser, and it
 * gets it directly from the cluster in `global-setup.ts` — one call, at the
 * start of the run, outside any test. It has no business being reachable from a
 * test file at all.
 */
import { Client } from "pg";
import { inject } from "vitest";
import { APP_ROLE } from "./login-roles";
import { databaseUrl } from "./url";

/**
 * The superuser connection URL for a test database.
 *
 * Prefer `withPrivilegedConnection`, which closes the connection for you. This
 * exists for the fixtures that must hold one open across several statements --
 * the migration-runner tests drive `migrate()` against a `Client` they own.
 */
export function privilegedUrl(
  database: { readonly name: string },
  reason: PrivilegedReason,
): string {
  void reason;
  return databaseUrl(inject("pachkaAdminUrl"), database.name);
}

/**
 * The sanctioned uses of a superuser connection from inside a test.
 *
 * Three members. Each one is a case where the application role's inability to
 * do the thing is the design working, not a policy missing -- so the fixture
 * has to step outside it to set up a test that then runs, as everything else
 * does, on the ordinary connection. A fourth member should be hard to justify.
 */
export type PrivilegedReason =
  /**
   * Schema-owning work: the migration runner, and the scratch tables a test
   * about `withTransaction` itself has to create before there is anything to
   * transact over.
   *
   * `migrate()` runs `create table`, `alter table` and every other piece of DDL
   * a migration contains, and deploys run it with credentials that own the
   * schema. A test of the runner that could not create a table would not be
   * testing the runner. This is not the hatch being used to route around RLS:
   * the application role deliberately has no CREATE on `public` and should not.
   */
  | "applying schema, which the migration runner does with owner credentials"
  /**
   * Arranging a database state that no application role can produce, because
   * the code under test exists to survive exactly such a state.
   *
   * `shared/config` falls back to the registry's compiled-in default when a key
   * is missing from `app_config`, and refuses a stored value whose shape
   * contradicts its declared type. Neither state is reachable through
   * `setConfig`: there is no DELETE policy on `app_config` (key removal is a
   * migration) and a check constraint makes the mismatched row impossible to
   * write. They arrive by restored backup, by hand-edited row, or by a key
   * deployed ahead of its migration -- and the reader's fallbacks are what
   * catches them. Constructing the state needs the credentials those paths had.
   */
  | "arranging a database state only a migration or a restored backup produces"
  /**
   * `moderation`'s tamper fixture. `admin_audit` is append-only, enforced by a
   * trigger, and the test that proves the hash chain detects tampering has to
   * actually tamper — which means `alter table admin_audit disable trigger`,
   * which requires ownership.
   *
   * This is not the hatch being used to route around RLS. The threat being
   * modelled *is* an attacker who holds the database owner's credentials: the
   * whole claim under test is that even they cannot rewrite history
   * undetectably. Running that fixture as a role that could not disable the
   * trigger would test a weaker attacker than the one the design defends
   * against.
   */
  | "simulating an attacker who holds the database owner's credentials"
  /**
   * Granting `admin`, which SECURITY.md S0-2 item 4 puts outside the
   * application entirely: "Adding or removing `admin` is not possible through
   * the application at all in the MVP. It is a manual DB operation."
   *
   * `user_roles_server_insert` now enforces that -- its `with check` admits
   * 'buyer' and 'artist' and nothing else -- so a fixture that needs an admin
   * has to do what a real deployment does, which is a human at a psql prompt.
   * Prefer `grantAdminRole` below to spelling this out.
   */
  | "granting admin, which SECURITY.md makes a manual database operation";

/**
 * Run `fn` against `database` as the cluster superuser.
 *
 * The connection is opened for this call and closed after it, so nothing
 * privileged outlives the fixture that asked for it.
 */
export async function withPrivilegedConnection<T>(
  database: { readonly name: string },
  reason: PrivilegedReason,
  fn: (client: Client) => Promise<T>,
): Promise<T> {
  // Referenced so the argument is not merely decorative to a reader skimming
  // for whether it is used.
  void reason;

  const client = new Client({
    connectionString: databaseUrl(inject("pachkaAdminUrl"), database.name),
  });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

/**
 * Give an account the `admin` role, out of band.
 *
 * This is not a convenience wrapper around a write the application could have
 * made. The application specifically cannot make it: SECURITY.md S0-2 item 4
 * says adding `admin` "is not possible through the application at all in the
 * MVP", and `user_roles_server_insert` enforces exactly that by admitting only
 * 'buyer' and 'artist'. Before that policy existed the rule lived in a comment
 * and a hard-coded literal, which is a coding style rather than a control --
 * any bug that reached the insert with an attacker-supplied string would have
 * minted an admin.
 *
 * So a test that needs an admin gets one the way the operator would: with
 * database credentials, outside the application. That the seeding looks
 * different from `seedAccount`'s other roles is the point, not an inconvenience.
 */
export function grantAdminRole(
  database: { readonly name: string },
  userId: string,
): Promise<unknown> {
  return withPrivilegedConnection(
    database,
    "granting admin, which SECURITY.md makes a manual database operation",
    (client) =>
      client.query("insert into user_roles (user_id, role) values ($1, 'admin')", [userId]),
  );
}

/**
 * Create a table that exists only for the duration of one test, and hand it to
 * the application role.
 *
 * Several tests need something to transact over, lock, or join against that is
 * not any module's real table: a stand-in for `orders` in a module that may not
 * read `orders`, a counter to race two transactions on, a probe table to prove
 * two test databases cannot see each other. Creating one needs CREATE on
 * `public`, which the application role does not have and should not -- nothing
 * in production creates tables at runtime.
 *
 * So the DDL runs with owner credentials and the grant immediately hands the
 * table back, which keeps the test itself running on the ordinary connection.
 * Note what is granted: privileges on this one table, by name. Not `all tables
 * in schema public`, which would paper over exactly the missing grants the
 * suite now exists to catch.
 */
export function defineScratchTable(
  database: { readonly name: string },
  name: string,
  ddl: string,
): Promise<void> {
  return withPrivilegedConnection(
    database,
    "applying schema, which the migration runner does with owner credentials",
    async (client) => {
      await client.query(ddl);
      await client.query(`grant select, insert, update, delete on ${name} to ${APP_ROLE}`);
    },
  );
}

/**
 * A scratch table that behaves like a real PACHKA table: RLS on and forced,
 * nothing for anon or authenticated, and one explicit policy for the role the
 * server connects as.
 *
 * Several modules take an injected port over a table another module owns and
 * has not built yet -- `stand_in_payout_ledger`, `stand_in_reservations`,
 * `stand_in_upload_events`. Those fixtures used to enable RLS and stop, which
 * denies everything, and got away with it because the harness connected as a
 * superuser and bypassed the check. Standing in for a table means standing in
 * for its authorisation too: a fixture that is quietly more permissive than the
 * real table proves the port against conditions production will not offer, and
 * a fixture that is quietly less permissive fails for reasons that have nothing
 * to do with the code under test.
 */
export function defineGuardedScratchTable(
  database: { readonly name: string },
  name: string,
  ddl: string,
): Promise<void> {
  return withPrivilegedConnection(
    database,
    "applying schema, which the migration runner does with owner credentials",
    async (client) => {
      await client.query(ddl);
      await client.query(`alter table ${name} enable row level security`);
      await client.query(`alter table ${name} force row level security`);
      await client.query(
        `create policy ${name}_server on ${name} for all to service_role using (true) with check (true)`,
      );
      await client.query(`grant select, insert, update, delete on ${name} to service_role`);
    },
  );
}
