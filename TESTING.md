# Testing

```bash
npm test          # everything: unit, ui, integration
```

That is the whole setup. The integration suite starts its own PostgreSQL.

| Command | Scope |
|---|---|
| `npm test` | All three projects |
| `npm run test:unit` | Pure logic — money, errors, config parsing |
| `npm run test:integration` | Real PostgreSQL, real migrations |
| `npm run test:watch` | Watch mode |
| `npm run verify` | `typecheck` + `lint` + `test` — what review runs |

## What happens when you run the integration suite

1. `initdb` creates a throwaway PostgreSQL data directory under the OS temp dir.
2. A `postgres` starts on a **unix socket inside that directory** — no TCP port
   is bound, so two runs on one machine cannot collide.
3. Every migration in `db/migrations` is applied to a database named
   `pachka_template`.
4. Two non-superuser login roles are created — see "Which role tests run as".
5. **Each test gets its own database**, cloned with
   `create database ... template pachka_template`, and dropped afterwards.
6. At the end of the run the server is stopped and the directory deleted.

Before step 1, the harness also deletes cluster directories left behind by runs
that were killed. A run that is SIGKILLed never reaches `pg_ctl stop`, so its
postmaster survives it; sixteen of these once accumulated on one machine and
starved each other until a single test took 362 seconds, which read as two
modules having become mysteriously slow. The sweep only ever touches
`pachka-pg-*` directories whose postmaster is demonstrably gone.

## Which role tests run as

**Not a superuser, and this is load-bearing.** A superuser bypasses row-level
security before `FORCE ROW LEVEL SECURITY` or `BYPASSRLS` is consulted, so a
suite running as one cannot tell a working policy from a missing one. This
suite ran as `postgres` for months while the schema had `for select` policies
and almost no write policies at all; the day the harness stopped connecting as a
superuser, 432 of 461 integration tests failed, every one of them a real missing
policy or grant. ARCHITECTURE.md, "Tests connect as a non-superuser role".

Two roles, because production has two identities:

| Handle | Role | Member of | Stands in for |
|---|---|---|---|
| `database.db` | `pachka_test_app` | `service_role` | The server's own connection — `shared/db`, module code |
| `database.dataApi` | `pachka_test_authenticator` | `anon`, `authenticated` | PostgREST's authenticator, behind `asAnon` / `asUser` |

Keep them apart. Postgres matches a policy's `to <role>` clause by role
*membership*, so a single role in all three would match the server's policies
while acting as a browser, and every "an anonymous visitor cannot see this" test
would start passing for the wrong reason.

If a test fails with `permission denied` or `new row violates row-level
security policy`, **the fix is a migration, not the harness.** It means the
table is missing a grant or a write policy, and it would have failed the same
way in production.

## When a fixture genuinely needs the superuser

`withPrivilegedConnection(database, reason, fn)`, where `reason` is a closed
union of the uses that have been argued for — applying schema, tampering with
the audit log as an attacker holding the owner's credentials, granting `admin`
out of band, and arranging an `app_config` row no application path can produce.

Adding a fifth means adding a union member, which means writing down why, in a
diff a reviewer sees. Do not reach for it to make a permission error go away:
that error is the suite working.

`harness-privileges.test.ts` asserts all of the above against `pg_roles`, with
positive controls, so none of it can quietly stop being true.

Requires the PostgreSQL server binaries (`initdb`, `pg_ctl`) — `brew install
postgresql@16` on macOS, `apt install postgresql-16` on Debian. The harness
looks on `PATH` first and then in the usual Homebrew and Debian keg locations.

To run against an existing server instead — Supabase's local stack, or a
container in CI:

```bash
npx supabase start   # optional; needs Docker
PACHKA_TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:54322/postgres npm test
```

## Writing an integration test

```ts
import { describe, expect, it } from "vitest";
import { useTestDatabase } from "../harness";

describe("reservations", () => {
  const database = useTestDatabase();          // fresh database per test

  it("refuses a second reservation on a unique artwork", async () => {
    await database.db.query("insert into artworks ...");

    await expect(reserve(database.db, artworkId, buyerB)).rejects.toMatchObject({
      kind: "conflict",
    });
  });
});
```

`database.db` is the real `shared/db` client — the same `withTransaction` module
code uses, so `select ... for update` locks for real. `database.pool` is a raw
`pg.Pool` for tests that need to hold two connections at once and race them.
`database.url` is the connection string, for anything that takes one.

Because each test owns its database, there is nothing to clean up and no
ordering to respect. Do not add a shared fixture that seeds data for several
tests: that reintroduces exactly the coupling this design removes.

## The rules review enforces

From ARCHITECTURE.md, "Test policy". The ones people get wrong:

**Assert the outcome, not the wiring.** `expect(repo.save).toHaveBeenCalled()`
is not a test — it passes when `save` writes nothing. Assert the row that
exists, the value returned, the error thrown, the state the order is now in.

**Do not mock PACHKA's own code.** Fakes are for external boundaries only: the
AI provider, mail, payment. The database is never mocked; that is the whole
point of the harness.

**Test the rejections.** Every spec scenario that blocks or rejects something
needs a test asserting it is blocked. A happy-path-only suite is incomplete.

**Race the concurrent paths for real.** The double-sale test opens two genuine
transactions on two connections and asserts exactly one wins. A test that runs
them one after the other proves nothing about the lock.

**No `sleep`.** If a test needs to wait for something, wait for the something.

## Proving the harness

`tests/integration/harness-isolation-a.test.ts` and `-b.test.ts` are the
harness's own test. Both insert the same `app_config` primary key and create a
table with the same name, so if isolation ever broke — a shared database, a
missed cleanup — whichever ran second would fail on a duplicate. Neither order
survives a broken harness, which is why the proof does not depend on ordering.

Verified against a deliberately broken harness (one database per *file* instead
of per test): both files fail. Verified passing alone, together, in shuffled
order, and on repeat.
