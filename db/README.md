# Database — migrations and access

Owner of this document: the foundation. Every module follows it.

## Commands

| Command | What it does |
|---|---|
| `npm run db:migrate` | Applies every pending migration to `DATABASE_URL` |
| `npm run db:status` | Lists each migration as `applied`, `pending`, or `DRIFTED` |
| `npm run db:new -- "add artwork images"` | Creates an empty migration with a correct filename |
| `npx tsx scripts/migrate.ts lint` | Fails if a migration contains destructive DDL |

## The convention

**Filenames are `<UTC timestamp>_<snake_case>.sql`,** e.g.
`20260827T090100_create_app_config.sql`. Timestamps rather than sequence
numbers because ten teams are writing migrations in parallel and two people
would otherwise both claim `0007`. Migrations apply in filename order, which is
chronological order.

**Migrations are forward-only.** There is no `down` file and there never will
be. Rollback of a release is a Vercel deployment revert with the database left
where it is (design.md, "Migration Plan"). A mistake is corrected by writing a
further migration.

**Migrations are additive.** The previous release keeps running for the minutes
between the migration landing and the deployment finishing, and it must keep
working. So a migration may add tables, add nullable columns, add indexes, add
constraints that existing rows already satisfy, and backfill data. It may not
drop a table, drop or rename a column, change a column's type, or truncate.
`scripts/migrate.ts lint` enforces this — it is not left to review.

Removing something is a three-change sequence across releases: add the
replacement, migrate every reader onto it, and only then — in a later change,
once no deployed code refers to the old thing — remove it. The removal
migration is the one place the linter must be overridden, and doing so requires
an explicit note in the migration explaining why nothing reads the column any
more.

**Applied migrations are immutable.** Each is recorded in `schema_migrations`
with a SHA-256 of its contents. Editing a file that has already been applied
makes `db:migrate` and `db:status` fail with `DRIFTED`, because the database in
front of you no longer matches the file the next environment will run.

**One migration, one transaction.** The runner wraps each file and its ledger
row in a single transaction, so an interrupted run always stops on a migration
boundary. Statements that cannot run inside a transaction (e.g. `create index
concurrently`) therefore need their own migration containing nothing else, with
a comment saying so.

**Every migration names its owner** in a header comment. A table is owned by
exactly one module (ARCHITECTURE.md, "Database schema — table ownership"), and
only that module's team writes migrations touching it. Foreign keys pointing
into another module's tables are expected; writes to them are not.

**Every new table gets row-level security in the same migration that creates
it.** A table shipped without policies is a security defect, not a follow-up.

## Two access paths, and why

**`shared/db` (node-postgres, direct connection)** is how module code reads and
writes. It connects as the database owner, so RLS does not constrain it —
server-side module code is trusted and enforces the rules itself. This path
exists because reservation correctness needs `select ... for update` held across
statements inside one transaction, which PostgREST cannot express.

**`@supabase/supabase-js` (anon / authenticated key)** is how the browser and
Supabase Auth talk to the database. This path *is* constrained by RLS, and RLS
is the only thing standing between a hostile client and the data. Write and test
policies as though the anon key is public, because it is.

Both layers are required. Server-side checks without RLS leave the anon key
unguarded; RLS without server-side checks cannot express rules that span tables.

## Supabase compatibility in tests

Integration tests run against a plain PostgreSQL, not against Supabase (see
`TESTING.md`). `20260827T090000_bootstrap_platform.sql` creates the `anon`,
`authenticated` and `service_role` roles and an `auth.uid()` / `auth.role()`
shim reading the same session settings PostgREST populates — but only when they
do not already exist, so on a real Supabase project the migration does nothing.

The payoff is that an RLS policy can be tested for real:

```sql
set local role authenticated;
set local request.jwt.claim.sub = '<uuid>';
```

and the policy sees the same `auth.uid()` it will see in production.

## Not yet provisioned

`pgvector` is required by the uploads and matchmaker modules
(`artwork_embeddings`). It is not enabled by any foundation migration because no
foundation table needs it. Whoever adds the first vector column also adds
`create extension if not exists vector` in that migration, and must confirm the
extension is available in the test cluster — a stock local PostgreSQL does not
ship it.
