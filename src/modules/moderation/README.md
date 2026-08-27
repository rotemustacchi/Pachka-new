# moderation

Reporting, the admin queue, takedown, suspension, and the append-only admin
audit. Owns `admin_audit` and `reports` (ARCHITECTURE.md ownership map).

## State of this module

**Shipped:** `admin_audit` — the table, the writer, the chain verifier — and
account suspension and reinstatement, plus the admin-only gate every other
surface will sit behind.

**Not shipped:** public reporting, the admin queue, and artwork takedown. All
three need `reports`, which carries a foreign key to `artworks`, and the
artworks migration was not committed at the time this work was done. Building
`reports` against a table that did not exist yet would have meant either
inventing `artworks` here — two owners on one table — or dropping the foreign
key, which is the constraint that stops a report pointing at nothing. Neither is
a trade worth making to tick a box a day earlier.

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
- **`ArtworkModerationPort`** (`artworks`) — move one artwork to `removed`
  inside the caller's transaction, without touching orders. `removed` must be
  terminal for the artist; that rule belongs to the artworks lifecycle machine.
- **`Mailer`** — the one genuinely external boundary here.

## Config keys this module will need

`moderation.operator_email` is already registered. Reporting needs two more,
which are **not** registered yet and are not used by any shipped code path:

| Key | Type | Suggested default | Why |
|---|---|---|---|
| `moderation.report_window_minutes` | integer | 60 | Window over which reports are counted, per client and per subject |
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
