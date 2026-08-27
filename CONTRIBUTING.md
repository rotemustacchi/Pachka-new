# Contributing to PACHKA

Short and practical. For the rules that govern what you build, read
`ARCHITECTURE.md`, `TESTING.md`, and `SECURITY.md` first — this file is only
about the mechanics of running and submitting the work.

## Running the app

```bash
npm install                      # npm, not pnpm or yarn — see README.md
cp .env.example .env.local       # then fill it in
npm run dev
```

You need a Postgres somewhere for `npm run dev` to talk to (`npx supabase
start`, or any Postgres with `DATABASE_URL` pointed at it, then `npm run
db:migrate`). You do **not** need one for the test suite — see below.

## Running the tests

```bash
npm test          # everything: unit, ui, integration — see TESTING.md
npm run verify    # typecheck + lint + test — what review, and CI, run
```

The integration project starts its own throwaway PostgreSQL automatically
(`initdb`/`pg_ctl` on `PATH`, or the usual Homebrew/Debian keg locations —
`brew install postgresql@16` on macOS). To point it at an existing server
instead:

```bash
npx supabase start   # optional, needs Docker
PACHKA_TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:54322/postgres npm test
```

Do not add tests that mock PACHKA's own code or that assert a mock was
called instead of an observable outcome — `TESTING.md` covers what review
rejects and why.

## Branch and commit conventions

One feature branch per initiative, named `<type>/<short-description>`
(the codebase so far lives on `feat/pachka-mvp`). Open a pull request into
that branch's target rather than committing straight to it.

Commit subjects follow `type(scope): what changed`, e.g.
`feat(accounts): split artist data across three tables so RLS cannot leak a
column` or `fix(orders): re-check expiry under the reservation lock` — look at
`git log` for the pattern actually in use before writing a new one. The body
explains **why**, not a restatement of the diff: which task or which
`SECURITY.md`/`ARCHITECTURE.md` requirement it satisfies, and any tradeoff
worth recording. Keep commits scoped to one module or one concern; do not mix
an unrelated fix into a feature commit.

## Definition of done

No task is complete until `npm run verify` passes — typecheck, lint, and the
full test suite, integration tests included. This is also exactly what CI
runs on every push and pull request (see `docs/ci.md`); a red CI check on
your branch is the same failure you would have caught locally by running it
yourself first.

Beyond the tests passing, `ARCHITECTURE.md`'s "Definition of done, per task"
applies in full: no boundary violation, no direct writes to another module's
tables, RLS policies present for any new table, and every spec scenario the
task covers has a corresponding test.
