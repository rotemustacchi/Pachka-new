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
4. **Each test gets its own database**, cloned with
   `create database ... template pachka_template`, and dropped afterwards.
5. At the end of the run the server is stopped and the directory deleted.

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
