-- Payouts: the append-only ledger of what PACHKA owes each artist.
--
-- Owner: payouts. Tables: `payout_ledger` (ARCHITECTURE.md, table ownership).
--
-- WHY THIS TABLE HAS NO STATUS COLUMN
-- -----------------------------------
-- `artist-payouts` asks the ledger to record "payout status" and, three lines
-- later, that "ledger entries SHALL be append-only; corrections SHALL be
-- recorded as new adjusting entries rather than edits". A mutable status column
-- cannot be both. ARCHITECTURE.md settles it by naming the mechanism -- "revoked
-- grants plus a trigger, not application convention" -- and a trigger that
-- refuses every UPDATE refuses the one that would flip a status.
--
-- So status is DERIVED, exactly as availability is derived in `artworks`:
--
--   pending    a sale entry whose fulfilment has no delivered transition yet,
--              or whose return window has not closed
--   eligible   delivered + `payouts.eligibility_delay_days`, no blocking return,
--              no settlement, no open hold
--   settled    a settlement entry references the sale entry
--   held       a hold entry references it and no later settlement does
--
-- Deriving it also removes the second copy of the eligibility rule. A stored
-- status would have to be recomputed by something, and whatever recomputed it
-- would be a second answer to "is this payable" that could disagree with the
-- one the settlement transaction uses (SECURITY.md S1-10 item 3 forbids exactly
-- that: eligibility is re-evaluated inside the settlement transaction, never
-- read from a cache).
--
-- WHY THERE IS NO delivered_at OR eligible_at COLUMN EITHER
-- ---------------------------------------------------------
-- SECURITY.md S1-10 item 2: "Eligibility is computed from the server-written
-- timestamp on the `order_transitions` row for the `-> delivered` edge. No date
-- supplied by any client is an input to eligibility." A copy of that timestamp
-- on this row would be a second input, writable by whoever writes this row. The
-- ledger therefore stores money and nothing about time except when the row
-- itself was appended.
--
-- EVERY ROW IS A SIGNED DELTA
-- ---------------------------
-- `gross/commission/net` on a row are what that row DOES to the artist's
-- balance, not a restatement of the sale. Only a `sale` row carries the sale's
-- own figures. A `settlement` carries the negative of what it paid out, so that
-- `sum(net_agorot)` over an artist's rows is exactly what is still owed --
-- which is what makes "no agora invented or lost" a single arithmetic check
-- over the whole table rather than a property somebody has to remember.
--
-- `payout_ledger_conserves_money` states the other half in the schema:
-- commission + net = gross on every row, for every entry type, always. The
-- rounding that makes it true lives in `modules/payouts/commission.ts` and is
-- proved exhaustively there.

-- ---------------------------------------------------------------------------
-- 0. A private schema, off the data API
-- ---------------------------------------------------------------------------
--
-- Same reasoning as `accounts` and `moderation`: PostgREST publishes every
-- function in `public` as an RPC endpoint at /rest/v1/rpc/<name>. The
-- append-only guard is not an endpoint.

create schema if not exists payouts;
comment on schema payouts is
  'Append-only guard for the payout ledger. Deliberately not a PostgREST-exposed schema.';

grant usage on schema payouts to anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 1. The table
-- ---------------------------------------------------------------------------

create table payout_ledger (
  -- The append order. Not required for correctness -- entries link by
  -- `parent_entry_id` -- but it gives an operator a stable position to quote
  -- and the append-only trigger something to name in its error.
  seq                bigint      generated always as identity unique,
  id                 uuid        primary key default gen_random_uuid(),

  -- Who is owed. `artist_profiles`, not `profiles`: only an artist has a
  -- payout, and the narrower key makes that true by reference rather than by
  -- convention.
  artist_id          uuid        not null references artist_profiles (user_id),

  -- What it is owed for. `orders` owns both; this module never writes them.
  fulfilment_id      uuid        not null references fulfilments (id),
  order_id           uuid        not null references orders (id),

  --   sale        the artist earned this. One per fulfilment, at `paid`.
  --   settlement  an operator recorded a bank transfer against a sale.
  --   adjustment  a correction. Appended, never an edit -- see the header.
  --   hold        an admin action (suspension) parked the entry for a decision.
  entry_type         text        not null check (entry_type in (
                                   'sale', 'settlement', 'adjustment', 'hold'
                                 )),

  -- The entry this one acts on. Null only for a `sale`, which acts on nothing.
  -- This is the "referencing the original" the spec requires of a correction,
  -- expressed as a foreign key so it cannot be a dangling identifier in prose.
  parent_entry_id    uuid        references payout_ledger (id),

  -- Agorot, signed, as a delta to the artist's balance. bigint because
  -- ARCHITECTURE.md: "A price column is bigint" -- and node-postgres hands
  -- bigint back as a string, which `shared/money.fromDbValue` is the only
  -- sanctioned way to read.
  gross_agorot       bigint      not null,
  -- Basis points, snapshotted from `orders.commission_rate_bp`, which was
  -- itself snapshotted from `app_config` at placement (SECURITY.md S0-5 item 3).
  -- Copied here so a correction splits at the rate the sale was made at, and so
  -- an auditor reading one row can check its own arithmetic without a join.
  commission_rate_bp integer     not null check (commission_rate_bp between 0 and 10000),
  commission_agorot  bigint      not null,
  net_agorot         bigint      not null,

  -- Settlement, and only settlement. `date` rather than timestamptz: an
  -- operator records the day the bank transfer went out, which is a calendar
  -- fact about someone else's system, not an instant in ours.
  settled_on         date,
  bank_reference     text        check (bank_reference is null
                                        or length(btrim(bank_reference)) between 1 and 120),
  settled_by         uuid        references profiles (user_id),

  -- The admin_audit entry that caused this row, for `settlement`, `adjustment`
  -- and `hold`. A cross-module foreign key, which ARCHITECTURE.md permits and
  -- expects; the write stays on moderation's side of the boundary.
  audit_entry_id     uuid        references admin_audit (id),

  reason             text        not null default '' check (length(reason) <= 2000),

  created_at         timestamptz not null default now(),

  -- THE MONEY INVARIANT, IN THE SCHEMA.
  -- Not a comment, not a unit test: a constraint. Any row that would create or
  -- destroy an agora is refused by Postgres, including one written by a
  -- privileged connection with the trigger disabled.
  constraint payout_ledger_conserves_money
    check (commission_agorot + net_agorot = gross_agorot),

  -- A sale is the only entry with no parent, and the only one that may not
  -- carry settlement columns. Its figures are non-negative because a sale that
  -- owes the artist a negative amount is a correction, not a sale.
  constraint payout_ledger_sale_shape check (
    entry_type <> 'sale' or (
      parent_entry_id is null
      and gross_agorot      >= 0
      and commission_agorot >= 0
      and net_agorot        >= 0
      and settled_on     is null
      and bank_reference is null
      and settled_by     is null
    )
  ),

  -- Every other entry acts on one that already exists.
  constraint payout_ledger_derived_has_parent check (
    entry_type = 'sale' or parent_entry_id is not null
  ),

  -- A settlement records a transfer that a human performed. All three facts are
  -- mandatory: without the date and the reference there is nothing to reconcile
  -- against a bank statement, and without the operator there is nobody to ask.
  -- The money is the negative of what was paid, so the balance falls by exactly
  -- what left the account (see the header). Commission does not move: it was
  -- taken at the sale.
  constraint payout_ledger_settlement_shape check (
    entry_type <> 'settlement' or (
      settled_on        is not null
      and bank_reference is not null
      and settled_by     is not null
      and audit_entry_id is not null
      and commission_agorot = 0
      and net_agorot       <= 0
    )
  ),

  -- A hold moves no money. It is a flag with a paper trail, which is what
  -- `moderation`'s suspension path needs: SECURITY.md S1-13's test is that the
  -- entries "still exist and are flagged, not deleted or zeroed".
  constraint payout_ledger_hold_shape check (
    entry_type <> 'hold' or (
      gross_agorot = 0
      and commission_agorot = 0
      and net_agorot = 0
      and audit_entry_id is not null
      and settled_on     is null
      and bank_reference is null
    )
  ),

  -- A correction states why. An adjusting entry with no reason is unreadable
  -- six months later, which defeats the point of appending one.
  constraint payout_ledger_adjustment_shape check (
    entry_type <> 'adjustment' or (
      length(btrim(reason)) > 0
      and audit_entry_id is not null
      and settled_on     is null
      and bank_reference is null
    )
  )
);

comment on table payout_ledger is
  'Append-only, per-artist record of what PACHKA owes and what it has paid. Grants revoked, trigger-enforced. Status and eligibility are derived, never stored (artist-payouts; SECURITY.md S1-10, S1-13).';
comment on column payout_ledger.net_agorot is
  'Signed delta to the artist''s balance. sum(net_agorot) for an artist is exactly what is still owed.';
comment on column payout_ledger.commission_rate_bp is
  'Snapshotted from orders.commission_rate_bp. A later rate change never reprices a completed sale (artist-payouts, Rate changes later).';

-- One sale per fulfilment. Without this, an accrual run that raced itself would
-- pay an artist twice for one parcel.
create unique index payout_ledger_one_sale_per_fulfilment
  on payout_ledger (fulfilment_id) where entry_type = 'sale';

-- SECURITY.md S1-10 item 4, verbatim: "a unique constraint on
-- (fulfilment_id, entry_type = 'settlement') so a double-submitted admin form
-- produces a constraint violation, not two payouts." This is the structural
-- half of settlement idempotence; the row lock in `settlement.ts` is the half
-- that turns the violation into a readable error instead of a 500.
create unique index payout_ledger_one_settlement_per_fulfilment
  on payout_ledger (fulfilment_id) where entry_type = 'settlement';

create index payout_ledger_artist_idx on payout_ledger (artist_id, created_at desc);
create index payout_ledger_fulfilment_idx on payout_ledger (fulfilment_id);
create index payout_ledger_parent_idx on payout_ledger (parent_entry_id);
create index payout_ledger_open_sales_idx
  on payout_ledger (artist_id) where entry_type = 'sale';

-- Deliberately NO set_updated_at trigger, and no updated_at column. Nothing is
-- ever updated, so a column recording when it last was would be a lie.

-- ---------------------------------------------------------------------------
-- 2. Refuse every update and every delete
-- ---------------------------------------------------------------------------
--
-- The grants below stop anon and authenticated. This stops the roles the grants
-- cannot: the service role, which is what the application connects as, and the
-- table owner. `moderation`'s admin_audit does the same thing for the same
-- reason -- "the application only ever calls INSERT" is a coding style, not a
-- control (SECURITY.md S1-14) -- and this is the other table in the system
-- where an in-place edit would be worth money to the person making it.

create function payouts.payout_ledger_immutable() returns trigger
language plpgsql
set search_path = ''
as $fn$
begin
  raise exception
    'payout_ledger is append-only: % on entry seq=% is refused', tg_op, old.seq
    using errcode = 'restrict_violation',
          hint = 'Corrections are appended as a new adjusting entry referencing the original (artist-payouts, Correction recorded).';
end
$fn$;

create trigger payout_ledger_append_only
  before update or delete on payout_ledger
  for each row execute function payouts.payout_ledger_immutable();

-- ---------------------------------------------------------------------------
-- 3. Row-level security and grants
-- ---------------------------------------------------------------------------
--
-- Matrix (SECURITY.md, "Cross-cutting: the RLS policy matrix"):
--   payout_ledger | anon SELECT: none | authenticated SELECT: artist_id =
--                 | auth.uid(), admin | INSERT only; no UPDATE, no DELETE
--
-- The read predicate is the whole of SECURITY.md S1-18 for this table: "on
-- payout_ledger [a USING (true) policy] exposes every artist's revenue". It
-- names a concrete subject, which is what item 1 of that finding requires.

alter table payout_ledger enable row level security;
alter table payout_ledger force  row level security;

create policy payout_ledger_artist_read on payout_ledger
  for select to authenticated
  using (artist_id = auth.uid() or accounts.auth_is_admin());

-- The server path. Reads for the artist view, the payable queue and the
-- eligibility recheck; the insert for every appended entry.
create policy payout_ledger_server_read on payout_ledger
  for select to service_role
  using (true);

create policy payout_ledger_server_insert on payout_ledger
  for insert to service_role
  with check (true);

-- INSERT, authenticated: unreachable, and deliberately kept -- there is no
-- INSERT grant behind it. It states, where a reader will look for it, that even
-- if a future migration restored the grant by mistake, a non-admin still could
-- not append to another artist's ledger. Same shape as admin_audit's.
create policy payout_ledger_admin_insert on payout_ledger
  for insert to authenticated
  with check (accounts.auth_is_admin());

-- UPDATE and DELETE: NO POLICY, FOR ANY ROLE, INTENTIONALLY.
--
-- ARCHITECTURE.md asks that a table taking no writes from an application role
-- say so rather than stay silent, so: nothing in PACHKA updates or deletes a
-- ledger entry. Not the application, not an admin, not an operator correcting a
-- mistake -- that last one appends an adjusting entry instead, which is the
-- whole of `artist-payouts`, *Correction recorded*. There is deliberately no
-- always-false policy either: an expression that exists is an expression a
-- later change can widen, and none is the stronger statement.
--
-- Account deletion is the one path that will want to remove rows, and it does
-- not: SECURITY.md S1-11 item 5 is explicit that "ledger entries retain amounts
-- and dates -- which are business records" while the payout DETAILS are purged.
-- Those live in `accounts.artist_payout_details`, not here, and nothing in this
-- table is a bank detail.

-- Supabase ships ALTER DEFAULT PRIVILEGES that grant table privileges to anon
-- and authenticated in `public`, so a new table can arrive already exposed.
revoke all on payout_ledger from public;
revoke all on payout_ledger from anon, authenticated;

-- Read only, and only their own rows, through the policy above. No INSERT
-- grant: appending is a server-side operation and the data API is not on that
-- path.
grant select on payout_ledger to authenticated;

grant select, insert on payout_ledger to service_role;

-- anon gets nothing at all. An anonymous visitor has no business knowing that
-- an artist sold anything, let alone for how much.

revoke all on function payouts.payout_ledger_immutable() from public;
