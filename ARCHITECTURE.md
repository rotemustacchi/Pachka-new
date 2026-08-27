# PACHKA — Architecture Contract

Authoritative for every agent working on this codebase. It exists so ten domain
teams can work in parallel without colliding. Where this document and a task
description disagree, this document wins; where this document and
`openspec/changes/pachka-marketplace-mvp/specs/**` disagree, **the spec wins**
and the conflict must be reported, not resolved silently.

## Shape

One Next.js (App Router, TypeScript) application. One Postgres database via
Supabase. No microservices, no separate deployments, no inter-service calls.
"Service" in this project means a **module with an enforced boundary**, not a
process.

```
src/
  modules/
    accounts/          artworks/        uploads/
    catalog/           matchmaker/      orders/
    shipping/          payouts/         certificates/
    moderation/
  shared/
    db/                # client, migrations, transaction helper
    config/            # runtime config service (see below)
    ui/                # design-system primitives, tokens
    money/             # integer agorot helpers
    errors/            # AppError taxonomy
  app/                 # routes only — thin, no business logic
```

### Module boundary rules

1. A module exposes a **public API** from `modules/<name>/index.ts`. Nothing
   outside the module may import any deeper path.
2. A module may import `shared/*` and other modules' `index.ts` **only** as
   listed in "Allowed dependencies" below. Anything else is a boundary
   violation and fails review.
3. A module owns its own tables. **No module writes another module's tables.**
   Cross-module effects go through the owning module's public API.
4. `app/` routes contain no business logic — they parse input, call a module
   API, and render.

### Allowed dependencies

| Module | May call |
|---|---|
| accounts | — |
| artworks | accounts |
| uploads | artworks |
| catalog | artworks, accounts |
| matchmaker | artworks, catalog |
| orders | artworks, accounts, shipping |
| shipping | orders |
| payouts | orders, accounts |
| certificates | orders, artworks |
| moderation | artworks, accounts, uploads |

`shipping` and `orders` are mutually visible by design (quoting at checkout,
fulfilment state); every other edge is one-directional. Any need for an edge not
in this table is an architecture question — raise it, do not add the import.

## Non-negotiable technical decisions

**Money is an integer count of agorot.** Never a float, never a decimal string.
`shared/money` owns formatting to `₪1,250.00`. A price column is `bigint`.

**Availability is derived, never stored.** `stock - active_reservations - sold`.
Any counter column for availability is a defect.

**Reservation is transactional.** `SELECT ... FOR UPDATE` on the artwork row
inside a transaction. There is no application-level lock, no optimistic retry
loop, no advisory-lock substitute.

**Order state changes go through one function.** `orders.transition()` validates
the edge against the state machine and writes `order_transitions`. No module and
no route sets an order status directly.

**Every configurable number lives in `app_config`,** read through
`shared/config`. Commission rate, quality thresholds, ranking weights,
reservation TTL, sparse-catalog threshold, over-budget tolerance, result count.
No magic numbers in module code.

**Row-level security is on for every table.** A missing RLS policy is a security
defect, not a follow-up.

**Every table needs write policies, not just read policies.** A table with
`FORCE ROW LEVEL SECURITY` and only `for select` policies permits no writes
except by a role that bypasses RLS. That makes correctness depend on a
deployment setting rather than on the schema, and it fails in production while
tests stay green. Each table therefore declares explicit `for insert`,
`for update` and `for delete` policies — with `with check` — for the roles
entitled to them. If a table genuinely takes no writes from any application
role, say so in a comment; silence is treated as an omission.

**Tests connect as a non-superuser role.** A superuser bypasses RLS
unconditionally, so a suite running as one can never prove a policy works. The
harness runs as a role matching production's privileges, which makes a missing
write policy a loud test failure instead of a silent production outage. See
`docs/security-audit-01.md` finding 3.

**RLS cannot hide a column.** Supabase publishes a PostgREST data API at
`/rest/v1/<table>` for every table in `public`, reachable by anyone holding the
anon key — which legitimately ships in the client bundle. RLS is row-level: a
policy that lets an anonymous visitor read an artist's row lets them read
*every column of it*, and no server-side serializer sits on that path. Therefore
**sensitive columns live in separate tables with grants revoked**, never as
extra columns on a publicly-readable row. `toPublicArtist()` protects the
application's own routes; it does not protect the data API, and must not be
relied on as the only control.

**Roles are never read from `user_metadata`.** A signed-in user can rewrite
their own `user_metadata` via `supabase.auth.updateUser`, which would make admin
self-grantable. Authorization reads `user_roles` only.

**The service-role key is server-only.** It may not appear in any module that
can be bundled for the browser, in any `NEXT_PUBLIC_*` variable, or in any
client component.

**Reservation uses the direct Postgres connection, not supabase-js.** PostgREST
runs every request in its own transaction, so a `FOR UPDATE` issued through it
releases immediately and the lock buys nothing. Use `shared/db`'s
`withTransaction`.

**Artist contact details never leave the server for a buyer-facing response.**
`accounts` exposes a single `toPublicArtist()` serializer; nothing else may
shape artist data for a buyer.

**No outbound AI call at query time.** Embeddings are computed at upload and
stored. If a matchmaker code path can reach an AI provider, it is wrong.

## Database schema — table ownership

Each table is owned by exactly one module. Migrations for a table may only be
written by its owner.

| Module | Tables |
|---|---|
| accounts | `profiles`, `user_roles`, `artist_profiles`, `artist_contact_details`, `artist_payout_details`, `reviews` |
| artworks | `artworks`, `artwork_images` |
| uploads | `upload_events`, `artwork_embeddings` |
| matchmaker | `match_queries`, `match_impressions`, `notify_requests` |
| orders | `orders`, `order_items`, `fulfilments`, `order_transitions`, `reservations`, `payments` |
| shipping | `shipping_zones`, `shipping_tiers`, `shipping_rates`, `returns` |
| payouts | `payout_ledger` |
| certificates | `certificates` |
| moderation | `reports`, `admin_audit` |

| shared | `app_config` |

Foreign keys across module boundaries are permitted and expected. Writes are
not.

**The audit writer lives with the table it writes.** An earlier draft of this
document listed a `shared/audit` module while the ownership map gave
`admin_audit` to `moderation`. The map wins: the writer is
`modules/moderation/audit.ts`. It takes an `Sql` and holds no module state, so
other modules record their admin actions by calling `moderation`'s public API
on their own open transaction — which is what makes the action and its audit
row atomic.

**Table split for column-level secrecy.** `artist_profiles` holds only what a
buyer may see — display name, photo, biography, city. An artist's email, phone,
street address and social handles live in `artist_contact_details`, and bank
details in `artist_payout_details`. Both have all grants revoked from `anon` and
`authenticated` and are reachable only through the privileged server
connection. This is a schema requirement, not a policy preference: see the RLS
matrix in `SECURITY.md`.

## Test policy

Every module ships unit tests and integration tests. Review rejects anything
that fails these:

1. **Tests prove behavior, not wiring.** Asserting that a mock was called is not
   a test. Assert the observable outcome: the row that exists, the value
   returned, the error raised, the state the order is now in.
2. **Integration tests run against real Postgres** with real migrations applied.
   The database is never mocked, and neither is the code under test.
3. **Hermetic.** No live network. AI providers, email, and payment are reached
   only through injected interfaces, and tests supply deterministic fakes for
   those *external boundaries only* — never for PACHKA's own logic.
4. **Independent.** Each test creates the data it needs and cleans up after
   itself. Tests pass alone, in any order, and on repeat runs. No shared
   fixtures that carry state between tests, no reliance on execution order, no
   `sleep`.
5. **Failure cases are mandatory.** Every spec scenario with a rejection or a
   block gets a test asserting it is rejected. A suite that only tests happy
   paths is incomplete.
6. **Concurrency is tested for real.** The double-sale test runs genuinely
   parallel transactions and asserts exactly one wins.

A test written to make the suite green rather than to catch a defect is a
defect.

## Definition of done, per task

- Code compiles, lints, and type-checks.
- Unit and integration tests exist and pass, meeting the policy above.
- Every spec scenario the task covers has a corresponding test.
- No boundary violation, no direct writes to another module's tables.
- RLS policies present for any new table.
- The task checkbox in `tasks.md` is ticked only after all of the above.

## Reporting

An agent that finds a genuine conflict between the spec, this contract, and what
it needs to build **stops and reports it**. It does not invent a resolution, and
it does not weaken a test to get past it.
