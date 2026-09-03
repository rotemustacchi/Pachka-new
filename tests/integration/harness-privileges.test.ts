/**
 * The test that stops all of this regressing.
 *
 * Every other integration test in this directory proves something about PACHKA.
 * This one proves something about the harness: that the connection those tests
 * run on is not quietly a superuser again.
 *
 * The distinction matters more than it sounds. For months the suite was green
 * while twenty-seven `for select` policies, four `for insert`, one `for update`
 * and one `for delete` were the entire write authorisation story across every
 * table in the schema — all of them carrying FORCE ROW LEVEL SECURITY. Nothing
 * caught it, because `initdb --username=postgres` and a harness that handed
 * that connection to every test meant every write ran as a superuser, and a
 * superuser bypasses row-level security before FORCE or BYPASSRLS is consulted.
 * The suite could not distinguish a policy that worked from a policy that did
 * not exist. Had production's role lacked BYPASSRLS, every write including
 * registration would have failed there against a green build here.
 *
 * A green suite is therefore not evidence that the fix is real: the suite was
 * green before. What is evidence is an assertion about the connection itself,
 * made against `pg_roles` rather than against anyone's intent. If someone ever
 * "fixes" a permission failure by pointing the harness back at the superuser,
 * or by adding BYPASSRLS to make an error go away, this file fails and says so
 * in as many words.
 *
 * ARCHITECTURE.md, "Tests connect as a non-superuser role";
 * docs/security-audit-01.md finding H3.
 *
 * The positive controls are not decoration. An assertion that a role cannot do
 * something passes just as happily when nothing is connected, when the query
 * returns no rows, or when the whole mechanism has been disabled — so each
 * refusal below is paired with a demonstration that the same machinery, in the
 * same database, still permits what it is supposed to permit.
 */
import { describe, expect, it } from "vitest";
import {
  APP_ROLE,
  AUTHENTICATOR_ROLE,
  asAnon,
  useTestDatabase,
  withPrivilegedConnection,
} from "../harness";
import type { Database } from "@/shared/db";

interface RoleAttributes {
  readonly rolname: string;
  readonly rolsuper: boolean;
  readonly rolbypassrls: boolean;
  readonly rolcreatedb: boolean;
  readonly rolcreaterole: boolean;
}

/** What Postgres itself says about the role this connection is authenticated as. */
const attributes = (db: Database): Promise<RoleAttributes> =>
  db.one<RoleAttributes>(
    `select rolname, rolsuper, rolbypassrls, rolcreatedb, rolcreaterole
       from pg_roles
      where rolname = current_user`,
  );

describe("the connection integration tests run on", () => {
  const database = useTestDatabase();

  it("is the application role, not the cluster superuser", async () => {
    // Named explicitly rather than merely "not postgres": a harness that had
    // drifted to some third role would be just as unproven, and the name is
    // what ties this assertion to `login-roles.ts`.
    const role = await attributes(database.db);
    expect(role.rolname).toBe(APP_ROLE);
  });

  it("is not a superuser, so FORCE ROW LEVEL SECURITY means what it says", async () => {
    // A superuser bypasses RLS unconditionally. Not because of an attribute
    // that could be inspected and reasoned about — the check short-circuits
    // ahead of BYPASSRLS and ahead of FORCE — which is what made the old
    // harness structurally incapable of detecting a missing policy.
    const role = await attributes(database.db);
    expect(role.rolsuper).toBe(false);
  });

  it("does not carry BYPASSRLS, so a missing write policy is a failure and not a shrug", async () => {
    // This is the attribute the accounts migration assumed production's role
    // would have, in a comment, with nothing checking it. The suite now runs
    // without it, so the policies have to be real.
    const role = await attributes(database.db);
    expect(role.rolbypassrls).toBe(false);
  });

  it("cannot create databases or roles either", async () => {
    // Not RLS, but the same argument: privileges the production connection has
    // no use for are privileges a test can accidentally come to depend on.
    const role = await attributes(database.db);
    expect(role.rolcreatedb).toBe(false);
    expect(role.rolcreaterole).toBe(false);
  });

  it("owns none of the tables it writes", async () => {
    // Ownership would put the connection back in the position FORCE exists to
    // address, and `relforcerowsecurity` would become the only thing standing
    // between the application and its own policies. It should not be load
    // bearing in the first place.
    const { rows } = await database.db.query<{ table_name: string }>(
      `select c.relname as table_name
         from pg_class c
         join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public'
          and c.relkind = 'r'
          and pg_get_userbyid(c.relowner) = current_user
        order by 1`,
    );
    const owned = rows.map((r) => r.table_name);
    expect(owned, `tables owned by the application role: ${owned.join(", ")}`).toEqual([]);
  });

  it("is refused by row-level security on a table with no policy for it", async () => {
    // The positive control for every "cannot" above, and the only one that
    // demonstrates the mechanism rather than an attribute.
    //
    // `admin_audit` has an INSERT policy for `service_role` and no UPDATE or
    // DELETE policy for anybody — it is append-only by design. If the
    // connection were bypassing RLS, the DELETE below would report a row count
    // instead of raising, whatever `pg_roles` happened to say.
    //
    // A permission error and an RLS refusal are different failures and this
    // asserts the RLS one specifically: `service_role` HAS been granted
    // select and insert on this table, so reaching a policy decision at all is
    // part of what is being shown.
    await expect(
      database.db.query("delete from admin_audit where seq is not null"),
    ).rejects.toThrow(/permission denied|row-level security/i);
  });

  it("still writes the tables it does have policies for, so none of this is an outage", async () => {
    // The other half of the control. Refusals prove nothing if the connection
    // is simply broken: a role that could write nothing at all would satisfy
    // every assertion above and fail the entire product. Registration is the
    // write that would have gone down in production had the BYPASSRLS
    // assumption been wrong, so it is the one worth demonstrating here.
    const { rows } = await database.db.query<{ user_id: string }>(
      `insert into profiles (user_id, display_name)
       values (gen_random_uuid(), 'Harness Control')
       returning user_id`,
    );
    expect(rows).toHaveLength(1);
  });
});

describe("the connection the data-API tests run on", () => {
  const database = useTestDatabase();

  it("is the authenticator role, and is no more privileged than the application one", async () => {
    // `asAnon`/`asUser` reach PostgREST's surface by assuming `anon` or
    // `authenticated`. If the role underneath were a superuser, every policy
    // those tests assert against would be bypassed and the whole data-API suite
    // would be theatre.
    const role = await attributes(database.dataApi);
    expect(role.rolname).toBe(AUTHENTICATOR_ROLE);
    expect(role.rolsuper).toBe(false);
    expect(role.rolbypassrls).toBe(false);
  });

  it("is not a member of service_role, so the server's policies do not apply to it", async () => {
    // Postgres matches a policy's `to <role>` clause by membership, not by
    // name. One login role that was a member of `service_role` as well as
    // `anon` would silently match the server's policies while acting as a
    // browser, and every "an anonymous visitor cannot see this" test in this
    // directory would start passing for the wrong reason. The two surfaces are
    // separate roles precisely so that cannot happen.
    const membership = await database.dataApi.one<{ member: boolean }>(
      "select pg_has_role(current_user, 'service_role', 'MEMBER') as member",
    );
    expect(membership.member).toBe(false);
  });

  it("sees only what a policy admits once it becomes anon", async () => {
    // Positive control, in both directions, on one table. `artist_payout_details`
    // holds bank details and has every grant revoked from anon; `artist_profiles`
    // is public by policy. An anonymous caller that could reach the first, or
    // could not reach the second, would mean the role switch is not doing what
    // the rest of the suite believes.
    await expect(
      asAnon(database.dataApi, (tx) => tx.query("select * from artist_payout_details")),
    ).rejects.toThrow(/permission denied/i);

    await expect(
      asAnon(database.dataApi, (tx) => tx.query("select * from artist_profiles")),
    ).resolves.toBeDefined();
  });
});

describe("the privileged escape hatch", () => {
  const database = useTestDatabase();

  it("is a superuser, which is exactly why it is not the default connection", async () => {
    // Kept honest from the other side. `privileged.ts` argues that the hatch is
    // dangerous enough to deserve a closed union of written-down reasons; that
    // argument only holds if the hatch really does hand back the privileges it
    // claims to. If this ever stopped being a superuser, the tamper fixture
    // would be modelling a weaker attacker than the audit chain is designed to
    // catch, and would quietly stop proving its point.
    const { rows } = await withPrivilegedConnection(
      database,
      "simulating an attacker who holds the database owner's credentials",
      (client) =>
        client.query<{ rolsuper: boolean }>(
          "select rolsuper from pg_roles where rolname = current_user",
        ),
    );
    expect(rows[0]?.rolsuper).toBe(true);
  });
});
