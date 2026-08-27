# PACHKA

An Israeli marketplace for original art by community creators, with a
questionnaire-driven matchmaker instead of endless scrolling.

Hebrew, RTL, shekels. One Next.js application, one Postgres database, no
separate services.

## Getting started

```bash
npm install                      # npm, not pnpm or yarn — see below
cp .env.example .env.local       # then fill it in
npm run dev
```

For a working database locally you need one of:

```bash
npx supabase start               # full Supabase stack; needs Docker
npm run db:migrate               # then apply migrations
```

or any PostgreSQL you already have, with `DATABASE_URL` pointed at it. The test
suite needs neither — it starts its own (see `TESTING.md`).

## Commands

| Command | What it does |
|---|---|
| `npm run dev` | Development server |
| `npm run build` | Production build |
| `npm test` | Unit, UI and integration tests |
| `npm run verify` | `typecheck` + `lint` + `test` — what review runs |
| `npm run db:migrate` | Apply pending migrations |
| `npm run db:status` | Show applied / pending / drifted migrations |
| `npm run db:new -- "add artwork images"` | Scaffold a migration |

## npm, deliberately

Not pnpm, not yarn. This is built by one developer as a favour, and every tool
that has to be installed before the project will run is friction with no
payoff. npm ships with Node. The choice is pinned in `package.json`'s
`packageManager` field so it does not get re-litigated per contributor; a
lockfile from another manager should not be committed.

## Where things live

```
src/
  app/        routes only — thin, no business logic
  modules/    one directory per bounded module, public API in index.ts
  shared/
    db/       Postgres client, withTransaction, migration runner
    config/   app_config reader and typed environment access
    ui/       design-system primitives and tokens
    money/    integer agorot
    errors/   AppError taxonomy
db/migrations/  forward-only, additive SQL
tests/
  harness/    the per-test real-Postgres harness
  integration/  tests that use it
```

## Read before writing code

- **`ARCHITECTURE.md`** — module boundaries, table ownership, the decisions that
  are not open for reinterpretation, and the test policy review enforces. Where
  it disagrees with a task description, it wins; where it disagrees with a spec
  in `openspec/changes/pachka-marketplace-mvp/specs/`, the spec wins and the
  conflict gets reported rather than quietly resolved.
- **`TESTING.md`** — how to write a test here, and what gets rejected.
- **`db/README.md`** — the migration convention, and why there are two paths to
  the database.
- **`OPEN-QUESTIONS.md`** — what is still undecided. Several are blocking for
  launch, none for implementation; the undecided numbers live in `app_config`
  precisely so they can be answered later without a deployment.
