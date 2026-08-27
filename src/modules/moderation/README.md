# moderation

Reporting, the admin queue, takedown, suspension, and the append-only admin
audit. Owns `admin_audit` and `reports` (ARCHITECTURE.md ownership map).

## State of this module

Complete for the MVP scope: the append-only `admin_audit`, public reporting,
the admin queue, artwork takedown, and account suspension and reinstatement.

Two things are stubbed at a seam rather than built, because the modules that
own them have not shipped — see "What this module needs from others" below.

## The audit log

The interesting file is the migration, not the TypeScript. `audit.ts` is a thin
typed wrapper; every control lives in
`db/migrations/20260827T150000_moderation_admin_audit.sql`:

| Property | Enforced by | Defeated by |
|---|---|---|
| actor and timestamp are not the caller's to choose | `BEFORE INSERT` trigger, from the session | nothing short of a schema change |
| no UPDATE, no DELETE from the data API | revoked grants, no policy | nothing short of a schema change |
| no UPDATE, no DELETE from the application either | `BEFORE UPDATE OR DELETE` trigger that always raises | a role that can disable a trigger |
| alteration and mid-log deletion are detectable | hash chain | nothing — that is the point |
| entries cut from the END are detectable | hash chain **plus a checkpoint held outside the table** | losing the checkpoint |
| an action cannot commit unaudited | one transaction, in `withAdminAction` | calling `deps.db` instead of the `tx` |

The last row is the one a future change is most likely to break, and
`tests/integration/moderation-suspension.test.ts` has the test that catches it:
it makes the audit write fail on a real column constraint and asserts the
suspension did not happen. It was checked against a deliberately broken
implementation — audit written in a second transaction after the action commits
— and it fails there, which is the only reason to believe it.

`verifyAuditChain` wants running on a schedule with an alert on a break, and
wants a checkpoint fed back to it. Nothing in this module owns a scheduler.

## What this module needs from others

Written down as interfaces in `./ports` rather than built here, because no
module writes another module's tables.

- **`PayoutLedgerPort`** (`payouts`) — outstanding eligible entries for an
  artist, and a way to flag them for an operator decision. The spec is emphatic
  that suspension **retains** them: "the ledger entries are retained and flagged
  for operator decision rather than cancelled". Until it is wired in,
  `payoutLedgerUnavailable` reports `known: false` and every suspension records
  `payout_review_required: true`, so an operator can tell "nothing owed" from
  "nobody asked".
- **`FlaggedUploadSource`** (`uploads`) — uploads the automated pipeline could
  not clear, which the queue lists alongside reports. `noFlaggedUploads`
  returns nothing until `uploads` ships, which is honest: there is no pipeline,
  so nothing has been flagged.
- **`Mailer`** — the operator notification and the artist's takedown notice.
  The one genuinely external boundary here, and the only thing the tests fake.
- **`InventoryDemandSource`** (`orders`, via `artworks`) — not consumed by
  moderation directly, but `takeDownArtwork` passes `deps.artworks` straight
  through to `artworks.removeArtwork`, so the composition root must supply the
  real one once `orders` ships. The takedown tests back it with a real table and
  assert an in-flight order is untouched by a takedown.

`artworks` used to be a port here and no longer is: it has shipped, and
ARCHITECTURE.md's dependency table allows moderation → artworks, so
`takedown.ts` imports `removeArtwork` directly.

## Config keys this module needs registered

`moderation.operator_email` is already registered. Reporting needs two more,
which are **not** registered yet. They are used, so until they land they are
literals in `rate-limit.ts` marked `// TODO(config):` — the only two magic
numbers in this module.

| Key | Type | Default in code | Why |
|---|---|---|---|
| `moderation.report_window_minutes` | integer | 60 | Window over which reports are counted, per client |
| `moderation.report_max_per_window` | integer | 10 | Reports permitted per window. Flooding must be refused **without** inflating the recorded count |

## Conflicts reported, not resolved

1. **ARCHITECTURE.md puts the audit writer in `shared/audit`**, while its own
   ownership map gives `admin_audit` to `moderation`. The writer is in
   `moderation/audit.ts`. Everything in it takes an `Sql` and holds no
   moderation state, so moving it is an export change and nothing else.
2. **The migration linter forbids the word TRUNCATE**, which SECURITY.md S1-14
   item 1 asks for explicitly (`REVOKE UPDATE, DELETE, TRUNCATE`) and which a
   `BEFORE TRUNCATE` trigger would also need. `revoke all` removes the privilege
   without the word, covering every role but the owner and a superuser; for
   those two, detection falls to the hash chain, where it would have fallen
   anyway. Working around the linter by assembling the keyword at runtime would
   have defeated a guard rail on purpose, so it was left alone and reported.

## Two design decisions worth arguing with

**The report count is derived, never stored.** A counter column satisfies
"group them into a single queue item showing the report count" and quietly
breaks "the report count already recorded is not inflated by the refused
attempts", because every path that refuses a report then has to remember not to
increment. `count(*)` over the rows that exist cannot drift from the rows that
exist.

**Anonymous visitors get no INSERT grant on `reports`**, which is stricter than
SECURITY.md's matrix ("anon INSERT, rate-limited"). Rate limiting is a
server-side control — it counts prior attempts in another table and decides — so
an anon INSERT grant on the PostgREST data API is precisely the flood the spec
requires be refused, arriving on a path where nothing counts it. A test asserts
the anonymous insert is refused, which is what makes every rate-limit test above
it meaningful rather than decorative.
