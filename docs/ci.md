# CI

`.github/workflows/ci.yml`, triggered on every push and every pull request.

## Two jobs

**`checks`** — `typecheck` and `lint`. No database, so it needs nothing to
wait on and runs in parallel with `test`.

**`test`** — the full suite `npm test` documented in `TESTING.md`: unit, ui,
and integration, the last against a real PostgreSQL.

## Why integration tests are not skipped in CI

This is the part worth getting right, because a pipeline that quietly skips
the integration project is worse than no pipeline: it reports green while
proving nothing about the database code (reservations, RLS, the migration
runner).

1. `tests/harness/cluster.ts` supports an EXTERNAL mode: set
   `PACHKA_TEST_DATABASE_URL` and it points the harness at that server
   instead of `initdb`-ing an ephemeral one. The `test` job runs a
   `postgres:16` **service container** (matching the version
   `TESTING.md`/`cluster.ts` tell local contributors to install —
   `brew install postgresql@16`) and sets that env var to it. This is the
   exact mechanism the harness's own comment names for CI use.
2. `tests/harness/global-setup.ts` — which runs once before any integration
   test — applies every migration in `db/migrations` to a fresh database and
   **throws** if zero migrations were applied. A misconfigured database
   connection fails the job; it cannot silently produce an empty, trivially
   "passing" integration run.
3. Vitest's default behaviour is to exit non-zero when a project's `include`
   glob matches zero test files, unless `--passWithNoTests` is passed.
   Nothing in this pipeline passes that flag. If `tests/integration/**`
   ever ends up empty, or the "integration" project is dropped from
   `vitest.config.ts`, `npm test` fails instead of quietly reporting fewer
   tests.
4. A `pg_isready` step confirms the exact URL the harness will use is
   reachable before the suite starts, independent of the service
   container's own health check (which already gates job start).

Together, (1)–(3) mean there is no code path in this pipeline where
integration tests are silently absent: either they run for real against a
real database, or the job fails.

## Migration check

There is no separate "does the migration convention hold" step. It doesn't
need one:

- **Additive-only / forward-only convention.**
  `tests/unit/migration-convention.test.ts` lints every committed migration
  under `db/migrations` and is part of the `unit` Vitest project, which
  `npm test` always runs. CI wires this in by running the existing suite,
  not by re-implementing the check.
- **Migrations apply cleanly from empty.** `tests/harness/global-setup.ts`
  (point 2 above) *is* this check — it creates a fresh database and applies
  every migration in filename order before the integration project's first
  test.

## Node, npm, dependency caching

- Node version comes from `node-version-file: package.json`, which reads
  `engines.node` (`>=20.11`) — one source of truth instead of a version
  number copied into the workflow that can drift from `package.json`.
- npm is pinned to the exact version in `packageManager`
  (`npm@12.0.2`) via `npm install -g "npm@$(node -p "require('./package.json').packageManager...")"`,
  read from `package.json` at run time rather than hard-coded, for the same
  reason.
- `actions/setup-node`'s `cache: npm` caches `~/.npm` keyed on
  `package-lock.json`, and `npm ci` is used (not `npm install`) so the
  lockfile is authoritative and reproducible.

## Concurrency and permissions

- `concurrency: { group: ci-${{ github.workflow }}-${{ github.ref }},
  cancel-in-progress: true }` — a second push to the same branch or PR
  cancels the run already in flight for it.
- `permissions: { contents: read }` at the workflow level, not overridden
  per job. Nothing here pushes, comments, or publishes, and the `test` job
  sets exactly one environment variable (`PACHKA_TEST_DATABASE_URL`,
  pointing at the throwaway service-container database) — no
  `secrets.*` reference anywhere in the workflow, so no secret is exposed to
  it. `src/shared/config/env.ts` parses `NEXT_PUBLIC_*`/service-role env vars
  lazily on first call (see its header comment); nothing reached by
  `typecheck`, `lint`, or `npm test` calls `serverEnv()`/`publicEnv()`, so
  none of those variables need to exist in CI at all.
- Third-party actions (`actions/checkout`, `actions/setup-node`) are pinned
  to a commit SHA, not a floating tag, with the tag noted in a comment for
  humans.

## Deliberately out of scope

No build, deploy, or release step. There is no hosting target chosen yet
(`ARCHITECTURE.md` doesn't name one), and a deploy workflow now would be
speculative — see the task this file was added for. Add it when a target is
chosen, not before.
