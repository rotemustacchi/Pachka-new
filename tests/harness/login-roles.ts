/**
 * The two login roles the integration suite connects as, and neither of them is
 * a superuser.
 *
 * ## Why this file exists
 *
 * The harness used to hand every test the `postgres` superuser that `initdb`
 * creates. A superuser bypasses row-level security unconditionally — not
 * because of `BYPASSRLS`, and not in spite of `FORCE ROW LEVEL SECURITY`, but
 * before either is consulted. So a suite running as one can demonstrate that a
 * policy *permits* something, and can never demonstrate that a missing policy
 * *forbids* it. Every server-side write in this codebase passed for months on
 * that bypass, on tables carrying `FORCE ROW LEVEL SECURITY` and twenty-seven
 * `for select` policies between them and not much else. Had production's
 * `DATABASE_URL` resolved to a role without `BYPASSRLS`, every write including
 * registration would have failed there while the suite stayed green.
 *
 * ARCHITECTURE.md now makes the rule binding: "Tests connect as a non-superuser
 * role." See also `docs/security-audit-01.md` finding H3.
 *
 * ## Why two roles and not one
 *
 * Production has two distinct database identities, and collapsing them would
 * quietly weaken what the suite proves.
 *
 *   • **The application's own connection** — `shared/db`, the direct Postgres
 *     connection that `withTransaction` and every module's queries run on.
 *     Modelled here by `APP_ROLE`, a member of `service_role` and nothing else.
 *
 *   • **PostgREST's authenticator** — the role the data API connects as before
 *     it issues `set role anon` or `set role authenticated` for the verified
 *     JWT. Modelled here by `AUTHENTICATOR_ROLE`, a member of `anon` and
 *     `authenticated` and nothing else.
 *
 * Postgres matches a policy's `to <role>` clause by role *membership*, not by
 * an exact name. One role that was a member of all three would therefore match
 * `to anon` policies while acting as the server — so a table whose only read
 * policy was `to anon` would appear to grant the server access it does not
 * actually have, and a missing `to service_role` policy could hide behind a
 * public one. Splitting them keeps each surface honest about which policy is
 * doing the work.
 *
 * Neither role is a superuser, neither carries `BYPASSRLS`, and neither owns
 * anything: the migrations run as the cluster's own superuser, so every table
 * is owned by somebody else and RLS applies to these two the ordinary way.
 * `privileged.ts` is the only way back to that superuser, and it is deliberately
 * awkward to reach.
 */
import { Client } from "pg";

/**
 * The server's direct connection: `shared/db`, `withTransaction`, module code.
 *
 * A member of `service_role`, because that is the role every server-side write
 * policy in `db/migrations` names. It inherits, so `service_role`'s table
 * grants apply without an explicit `set role`, exactly as a production
 * `DATABASE_URL` role that had been granted `service_role` would.
 */
export const APP_ROLE = "pachka_test_app";

/**
 * PostgREST's authenticator: the identity behind `asAnon` and `asUser`.
 *
 * `noinherit`, as Supabase's own authenticator is, so it holds none of `anon`'s
 * or `authenticated`'s privileges until it explicitly assumes one of them. A
 * test that forgot to `set role` would then get a permission error rather than
 * silently querying with rights the browser never has.
 */
export const AUTHENTICATOR_ROLE = "pachka_test_authenticator";

/**
 * Set on both roles so that EXTERNAL mode (`PACHKA_TEST_DATABASE_URL`, e.g.
 * Supabase's local stack over TCP) can authenticate. The ephemeral cluster runs
 * `--auth=trust` on a unix socket with no port bound, where this is ignored.
 * It guards nothing and is not a secret.
 */
const PASSWORD = "pachka-test-role";

/**
 * Create the two roles, or bring existing ones back to this definition.
 *
 * Roles are cluster-global, so this runs once per suite rather than once per
 * test database, and every cloned database inherits the table grants the
 * migrations gave `service_role`.
 *
 * The attributes are re-asserted on every run rather than only at creation. In
 * EXTERNAL mode the roles survive between runs, and a role that had picked up
 * `SUPERUSER` or `BYPASSRLS` from somewhere would silently restore exactly the
 * blindness this file exists to remove. `privileges.test.ts` asserts the result
 * against `pg_roles` regardless, so a failure here cannot pass unnoticed.
 */
export async function ensureLoginRoles(adminUrl: string): Promise<void> {
  const client = new Client({ connectionString: adminUrl });
  await client.connect();
  try {
    for (const role of [APP_ROLE, AUTHENTICATOR_ROLE]) {
      await client.query(
        `do $$
         begin
           if not exists (select 1 from pg_roles where rolname = '${role}') then
             create role ${role} login;
           end if;
         end
         $$`,
      );
      // NOSUPERUSER and NOBYPASSRLS are the whole point of the file. NOCREATEDB
      // and NOCREATEROLE are not — they are there so that a test which needs a
      // privilege it should not have fails loudly instead of quietly working.
      await client.query(
        `alter role ${role} login nosuperuser nobypassrls nocreatedb nocreaterole noreplication`,
      );
      await client.query(`alter role ${role} password '${PASSWORD}'`);
    }

    // Inherit: the application's queries run with `service_role`'s grants
    // without an explicit `set role`, the way a production connection does.
    await client.query(`alter role ${APP_ROLE} inherit`);
    await client.query(`grant service_role to ${APP_ROLE}`);

    // Noinherit: the authenticator must assume a role before it holds anything,
    // which is what `applyClaims` in `roles.ts` does.
    await client.query(`alter role ${AUTHENTICATOR_ROLE} noinherit`);
    await client.query(`grant anon, authenticated to ${AUTHENTICATOR_ROLE}`);
  } finally {
    await client.end();
  }
}

/**
 * Rewrite the user info in a libpq URL, keeping host (including a
 * `?host=/unix/socket` override), database and every other parameter.
 *
 * Deliberately separate from `databaseUrl()` in `url.ts`, which swaps the
 * database and keeps the credentials. The two compose: take the admin URL, put
 * a role on it here, then point it at a test database there.
 */
export function urlAsRole(baseUrl: string, role: string): string {
  const SCHEME = "postgresql://";
  if (!baseUrl.startsWith(SCHEME)) {
    throw new Error(`Expected a postgresql:// URL, got: ${baseUrl}`);
  }
  const queryAt = baseUrl.indexOf("?");
  const head = queryAt === -1 ? baseUrl : baseUrl.slice(0, queryAt);
  const tail = queryAt === -1 ? "" : baseUrl.slice(queryAt);

  const pathAt = head.indexOf("/", SCHEME.length);
  const authority = pathAt === -1 ? head.slice(SCHEME.length) : head.slice(SCHEME.length, pathAt);
  const rest = pathAt === -1 ? "" : head.slice(pathAt);

  const at = authority.lastIndexOf("@");
  const host = at === -1 ? authority : authority.slice(at + 1);

  return `${SCHEME}${encodeURIComponent(role)}:${encodeURIComponent(PASSWORD)}@${host}${rest}${tail}`;
}
