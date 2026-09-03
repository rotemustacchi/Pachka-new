-- Orders: the cart's destination, the reservation ledger, the state machine,
-- and the money as it stood at placement.
--
-- Owner: orders
--
-- Forward-only and additive: see db/README.md. No down migration exists.
--
-- This module exists to prevent one bug. A one-of-a-kind painting sold twice is
-- unrecoverable -- there is no second copy, and two people have paid for one
-- object. Everything below is shaped by that, so the reasoning is written down
-- rather than left to be rediscovered.
--
-- O1. THERE IS NO AVAILABILITY COLUMN, HERE OR ON `artworks`. ARCHITECTURE.md:
-- "Availability is derived, never stored. stock - active_reservations - sold."
-- `reservations` below is the ledger those two middle terms are counted from,
-- and `src/modules/orders/demand.ts` is the one query that counts them. A
-- `sold_units` column on this table would be a second answer to a question that
-- must only have one.
--
-- O2. ONE RESERVATION ROW IS ONE UNIT. Not a row with a quantity. That is what
-- makes the defensive constraint in section 6 expressible: a unique index over
-- (artwork_id, unit_index) caps the number of simultaneously-held units at the
-- number of distinct ordinals the application is willing to issue, which for a
-- `unique` artwork is exactly one.
--
--   SECURITY.md S0-4 item 3 asks for a different index:
--
--     create unique index ... on reservations (artwork_id)
--       where released_at is null and expires_at > now()
--
--   That index cannot be created. PostgreSQL requires an index predicate to be
--   IMMUTABLE, and `now()` is STABLE; the statement fails with "functions in
--   index predicate must be marked IMMUTABLE". The requirement is real and the
--   given form is not creatable, so it is implemented as written in section 6 --
--   which is strictly stronger, because it constrains editions as well as
--   unique pieces, where S0-4 fell back to "the derived-availability assertion
--   inside the locked transaction" and no constraint at all. Reported to the
--   lead architect rather than silently substituted.
--
-- O3. `order_shipping_details` IS A SEPARATE TABLE. SECURITY.md S1-18 item 2
-- requires it: `checkout-orders` says an artist sees the buyer's name, phone and
-- address only after `paid` and only for their own fulfilment, and RLS grants or
-- denies a ROW, never a column at a point in time. Splitting the columns into
-- their own table is what turns a timing rule into something a policy can say.
-- ARCHITECTURE.md's ownership map does not list this table; the RLS matrix in
-- SECURITY.md does, marked "(split out)". Reported to the lead architect.
--
-- O4. FULFILMENTS CARRY THEIR OWN STATUS. `checkout-orders` requires that each
-- fulfilment be "shipped, tracked, and paid out independently" while the buyer
-- sees one order, and that the buyer's order can show "one item shipped and one
-- still awaiting dispatch". A single order status cannot express that. The
-- fulfilment vocabulary is deliberately the SAME seven values as the order's,
-- because S1-18's policy predicate is written `f.status <> 'awaiting_payment'`
-- and a second vocabulary would make that clause quietly wrong.
--
-- O5. AMOUNTS ARE IMMUTABLE AFTER PLACEMENT. SECURITY.md S0-5 item 3: "`orders`
-- has no UPDATE policy for `authenticated`". Neither does `order_items`, and
-- neither does anything else here. The only writer is the server, and the
-- server never rewrites an amount -- the money columns are set once, in the
-- reservation transaction that read the prices under the artwork row lock.

-- ---------------------------------------------------------------------------
-- 1. Orders
-- ---------------------------------------------------------------------------

create table orders (
  -- Random, not sequential. SECURITY.md S3-29: "an order ID of 47 tells a
  -- competitor how many orders PACHKA has taken", and sequential ids make
  -- authorization the only defence against enumeration.
  id                  uuid        primary key default gen_random_uuid(),

  buyer_id            uuid        not null references profiles (user_id),

  -- `checkout-orders`, "Order state machine": exactly one of seven. The
  -- permitted edges are NOT expressed here -- they live in
  -- src/modules/orders/state-machine.ts and are enforced by transition(),
  -- because a check constraint can see the new row but not the old one.
  status              text        not null default 'awaiting_payment'
                                  check (status in (
                                    'awaiting_payment', 'paid', 'shipped', 'delivered',
                                    'return_requested', 'returned', 'cancelled'
                                  )),

  -- Money is an integer count of agorot in a bigint column (ARCHITECTURE.md).
  -- Never numeric, never a float, never a decimal string.
  --
  -- All three are derived server-side inside the reservation transaction from
  -- `artworks.price_agorot` read under the row lock and from the shipping rate
  -- table. SECURITY.md S0-5 item 1: "The checkout request body contains only
  -- artwork IDs, quantities, and the delivery address."
  subtotal_agorot     bigint      not null check (subtotal_agorot >= 0),
  shipping_agorot     bigint      not null check (shipping_agorot >= 0),
  total_agorot        bigint      not null check (total_agorot >= 0),

  constraint orders_total_is_the_sum check (total_agorot = subtotal_agorot + shipping_agorot),

  -- Snapshotted at placement from `app_config` (SECURITY.md S0-5 item 3), so a
  -- later commission change cannot retroactively re-price a completed sale, and
  -- so an artist checking out through their own device cannot set it to zero.
  -- Basis points, matching the `platform.commission_rate_bp` registry key.
  commission_rate_bp  integer     not null check (commission_rate_bp between 0 and 10000),

  -- Israel-only in the MVP, but recorded rather than assumed: an amount without
  -- a currency is a defect waiting for the second market.
  currency            text        not null default 'ILS' check (currency = 'ILS'),

  -- The shipping quote the order was placed against, for reconstruction. Codes,
  -- not ids: `shipping_zones` rows are deactivated rather than deleted, and a
  -- code survives a re-pricing that an id would not make legible.
  shipping_zone_code  text,

  placed_at           timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create index orders_buyer_placed_idx on orders (buyer_id, placed_at desc);
create index orders_status_idx on orders (status);

create trigger orders_set_updated_at
  before update on orders
  for each row execute function public.set_updated_at();

comment on table orders is
  'A buyer-facing order. Amounts are derived server-side inside the reservation transaction and never rewritten (SECURITY.md S0-5).';
comment on column orders.commission_rate_bp is
  'Basis points, snapshotted from app_config at placement. Never supplied by the client (SECURITY.md S0-5 item 3).';

-- ---------------------------------------------------------------------------
-- 2. The buyer's delivery details, split out
-- ---------------------------------------------------------------------------
--
-- See O3. One row per order, so the primary key IS the order id.

create table order_shipping_details (
  order_id      uuid        primary key references orders (id),

  -- `checkout-orders`, "Checkout collects delivery and contact details": full
  -- name, phone number, and delivery address, all required before payment.
  full_name     text        not null check (length(btrim(full_name)) between 2 and 120),
  phone         text        not null check (length(btrim(phone)) between 6 and 32),
  line1         text        not null check (length(btrim(line1)) between 2 and 200),
  line2         text        check (line2 is null or length(line2) <= 200),
  city          text        not null check (length(btrim(city)) between 1 and 120),
  postal_code   text        check (postal_code is null or length(postal_code) <= 20),
  country_code  text        not null check (country_code ~ '^[A-Z]{2}$'),

  created_at    timestamptz not null default now()
);

comment on table order_shipping_details is
  'Buyer name, phone and delivery address. Separate from `orders` so the artist policy can be predicated on fulfilment state as well as ownership (SECURITY.md S1-18 item 2).';

-- ---------------------------------------------------------------------------
-- 3. Fulfilments -- one per artist per order
-- ---------------------------------------------------------------------------

create table fulfilments (
  id                    uuid        primary key default gen_random_uuid(),
  order_id              uuid        not null references orders (id),

  -- artist_profiles, not profiles: only an account that completed the artist
  -- upgrade can hold a listing, so only one can owe a fulfilment.
  artist_id             uuid        not null references artist_profiles (user_id),

  -- See O4. Same seven values as the order.
  status                text        not null default 'awaiting_payment'
                                    check (status in (
                                      'awaiting_payment', 'paid', 'shipped', 'delivered',
                                      'return_requested', 'returned', 'cancelled'
                                    )),

  -- This artist's share of the order. `shipping-and-returns` charges shipping
  -- per fulfilment using the largest applicable size tier, not the sum of the
  -- tiers, so this is one parcel's cost and not a per-item total.
  items_subtotal_agorot bigint      not null check (items_subtotal_agorot >= 0),
  shipping_agorot       bigint      not null check (shipping_agorot >= 0),
  shipping_tier_code    text,

  shipped_at            timestamptz,
  delivered_at          timestamptz,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),

  -- One fulfilment per artist per order. Two rows would split one parcel into
  -- two shipping charges, which is the exact double-charge quote.ts avoids.
  constraint fulfilments_one_per_artist unique (order_id, artist_id)
);

create index fulfilments_artist_status_idx on fulfilments (artist_id, status);

create trigger fulfilments_set_updated_at
  before update on fulfilments
  for each row execute function public.set_updated_at();

comment on table fulfilments is
  'One artist''s share of an order, shipped, tracked and paid out independently while the buyer sees one order (checkout-orders).';

-- ---------------------------------------------------------------------------
-- 4. Order items
-- ---------------------------------------------------------------------------

create table order_items (
  id                  uuid        primary key default gen_random_uuid(),
  order_id            uuid        not null references orders (id),
  fulfilment_id       uuid        not null references fulfilments (id),
  artwork_id          uuid        not null references artworks (id),

  -- Denormalised from the fulfilment so that a per-artist query does not need
  -- the join, and so an item can never disagree with its fulfilment about whose
  -- work it is -- the constraint below is what makes that a guarantee.
  artist_id           uuid        not null references artist_profiles (user_id),

  quantity            integer     not null check (quantity > 0),

  -- Read from `artworks.price_agorot` under the row lock taken in the same
  -- transaction. SECURITY.md S0-5 item 2: price and inventory are decided
  -- against the same snapshot.
  unit_price_agorot   bigint      not null check (unit_price_agorot >= 0),
  line_total_agorot   bigint      not null check (line_total_agorot >= 0),

  constraint order_items_line_total_is_the_product
    check (line_total_agorot = unit_price_agorot * quantity),

  -- The title as it was when bought. An artist may edit a listing afterwards,
  -- and a receipt that changes wording after the fact is not a receipt.
  title_snapshot      text,

  created_at          timestamptz not null default now(),

  -- An artwork appears at most once per order: two lines for one piece would
  -- make the reservation count and the item count disagree.
  constraint order_items_one_line_per_artwork unique (order_id, artwork_id)
);

create index order_items_fulfilment_idx on order_items (fulfilment_id);
create index order_items_artwork_idx on order_items (artwork_id);

comment on table order_items is
  'One artwork on one order, priced from the artwork row read under the reservation lock (SECURITY.md S0-5).';

-- ---------------------------------------------------------------------------
-- 5. Transition history
-- ---------------------------------------------------------------------------
--
-- `checkout-orders`, "Transition history recorded": the previous state, the new
-- state, the acting account, and a timestamp. INSERT only -- there is no UPDATE
-- and no DELETE policy for any role, which is what makes the history a history.

create table order_transitions (
  id             uuid        primary key default gen_random_uuid(),
  order_id       uuid        not null references orders (id),

  -- Null for an order-level move. Set when the move was on one artist's
  -- fulfilment, so "one item shipped and one still awaiting dispatch" has a
  -- record for each half.
  fulfilment_id  uuid        references fulfilments (id),

  from_status    text        not null,
  to_status      text        not null,

  -- Null for `system`: the expiry sweep has no account behind it, and inventing
  -- one would put a person's name on a machine's decision.
  actor_id       uuid        references profiles (user_id),
  actor_kind     text        not null check (actor_kind in ('buyer', 'artist', 'admin', 'system')),

  reason         text,
  occurred_at    timestamptz not null default now()
);

create index order_transitions_order_idx on order_transitions (order_id, occurred_at);

comment on table order_transitions is
  'Append-only record of every order and fulfilment state change, with actor and timestamp (checkout-orders).';

-- ---------------------------------------------------------------------------
-- 6. Reservations -- the inventory ledger
-- ---------------------------------------------------------------------------
--
-- One row is one unit (O2). A reservation is created inside the transaction
-- that holds `artworks`' row lock, and it is the ONLY thing that makes an
-- artwork unavailable.
--
-- The three states a row can be in, and the lifecycle that moves between them:
--
--   held      released_at is null, confirmed_at is null, expires_at > now()
--             An in-progress checkout. Counts as `reservedUnits`.
--   sold      released_at is null, confirmed_at is not null
--             Payment landed. Counts as `soldUnits`, and never expires.
--   released  released_at is not null
--             Expired and swept, cancelled, or returned. Counts as nothing,
--             and the artwork becomes purchasable again.
--
-- A row is never deleted. `released_at` is why an artwork came back, and a
-- deleted row is a unit that reappeared with no explanation.

create table reservations (
  id            uuid        primary key default gen_random_uuid(),
  artwork_id    uuid        not null references artworks (id),
  buyer_id      uuid        not null references profiles (user_id),

  -- Null between "the buyer began checkout" and "the order row exists". In
  -- practice both happen in one transaction, so this is not null in any
  -- committed row the application writes -- but the column stays nullable so a
  -- future two-phase checkout does not need a migration to express it.
  order_id      uuid        references orders (id),

  -- Which unit of the edition this row claims. Zero-based, so a `unique`
  -- artwork only ever has unit 0. See the constraint below.
  unit_index    integer     not null check (unit_index >= 0),

  expires_at    timestamptz not null,
  confirmed_at  timestamptz,
  released_at   timestamptz,
  release_reason text       check (release_reason is null or release_reason in (
                              'expired', 'cancelled', 'returned', 'superseded'
                            )),

  created_at    timestamptz not null default now(),

  -- A released row must say why. Silence about a returned unit is how an
  -- inventory discrepancy becomes unexplainable six months later.
  constraint reservations_release_has_a_reason
    check ((released_at is null) = (release_reason is null))
);

-- THE DEFENSIVE CONSTRAINT. SECURITY.md S0-4 item 3, in the form PostgreSQL
-- will accept -- see O2 for why the form given in SECURITY.md cannot be created.
--
-- What it buys: with the application issuing unit ordinals 0..stock-1, at most
-- `stock` units of an artwork can be un-released at any moment, and for a
-- `unique` artwork (stock 1) at most one. A logic bug that lost the row lock
-- becomes a constraint violation -- a failed checkout, loud and recoverable --
-- rather than a painting sold twice.
--
-- Note it covers held AND confirmed rows together. A confirmed sale must block
-- a new hold on the same unit just as firmly as a live checkout does, and the
-- version that excluded confirmed rows would have allowed exactly the sale this
-- whole module exists to prevent.
create unique index reservations_one_live_row_per_unit
  on reservations (artwork_id, unit_index)
  where released_at is null;

-- The sweep's working set, and the demand query's. Partial, because a released
-- row is never interesting to either.
create index reservations_live_idx
  on reservations (artwork_id)
  where released_at is null;

create index reservations_expiry_idx
  on reservations (expires_at)
  where released_at is null and confirmed_at is null;

create index reservations_buyer_idx on reservations (buyer_id) where released_at is null;

comment on table reservations is
  'The inventory ledger: one row per unit held or sold. Availability is derived from it and never stored (ARCHITECTURE.md).';
comment on column reservations.unit_index is
  'Which unit of the edition this row claims, zero-based. With the unique index on (artwork_id, unit_index) where released_at is null, this is the defensive constraint behind the double-sale invariant (SECURITY.md S0-4 item 3).';

-- ---------------------------------------------------------------------------
-- 7. Payments
-- ---------------------------------------------------------------------------
--
-- `checkout-orders`, "Payment provider abstraction": every payment operation
-- goes through one internal interface, and the MVP ships a manual adapter that
-- records a payment as pending settlement and marks it paid on operator
-- confirmation. The provider name is stored so that a later real adapter's rows
-- are distinguishable from the manual ones without guessing.

create table payments (
  id                  uuid        primary key default gen_random_uuid(),

  -- One payment per order in the MVP. A partial-capture or split-payment world
  -- would relax this, and would be a migration and a spec change together.
  order_id            uuid        not null unique references orders (id),

  provider            text        not null check (length(btrim(provider)) between 1 and 60),

  -- The provider's own identifier for the attempt. Unique per provider so a
  -- webhook replay cannot create a second row for one payment.
  provider_reference  text        not null,

  status              text        not null default 'pending'
                                  check (status in (
                                    'pending', 'authorized', 'captured', 'refunded', 'failed'
                                  )),

  amount_agorot       bigint      not null check (amount_agorot >= 0),
  currency            text        not null default 'ILS' check (currency = 'ILS'),

  -- Who confirmed receipt, for the manual adapter. An operator action on other
  -- people's money is not anonymous.
  settled_by          uuid        references profiles (user_id),

  authorized_at       timestamptz,
  captured_at         timestamptz,
  refunded_at         timestamptz,
  failure_reason      text,

  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),

  constraint payments_reference_unique_per_provider unique (provider, provider_reference)
);

create trigger payments_set_updated_at
  before update on payments
  for each row execute function public.set_updated_at();

comment on table payments is
  'One payment attempt per order, recorded through the PaymentProvider interface. No provider-specific column exists here by design (checkout-orders).';

-- ---------------------------------------------------------------------------
-- 7b. Policy helpers, and why they have to exist
-- ---------------------------------------------------------------------------
--
-- The policies in this module are cross-table by nature: a buyer reaches a
-- fulfilment through the order they own, and an artist reaches an order through
-- the fulfilment they own. Written as plain EXISTS subqueries that is a cycle --
-- reading `orders` evaluates a policy that reads `fulfilments`, whose own policy
-- reads `orders` -- and PostgreSQL stops it with "infinite recursion detected in
-- policy for relation". Not a theoretical risk; it is the first thing that
-- happens when you select an order.
--
-- So the cross-table half of every predicate goes through a SECURITY DEFINER
-- function, which runs as the owner and therefore does not re-enter the other
-- table's policies. `accounts.auth_has_role` exists for exactly this reason and
-- says so in its own migration.
--
-- Same schema reasoning as accounts, artworks and moderation: a policy
-- expression is evaluated as the querying role, so these must be EXECUTE-able by
-- `authenticated`; putting them in `public` would also publish each one as a
-- PostgREST RPC at /rest/v1/rpc/<name>. PostgREST exposes only `public`, so
-- their own schema keeps them reachable from policies and off the data API.
--
-- Each pins `search_path` (SECURITY.md S0-2 item 2, asserted by the schema
-- invariant test), takes only the caller's own `auth.uid()` rather than a
-- subject parameter, and answers a yes/no question about one row. None of them
-- returns data, so a caller who invokes one directly learns only what a policy
-- would have told them anyway.

create schema if not exists orders;
comment on schema orders is
  'Policy helpers for the orders module. Deliberately not a PostgREST-exposed schema.';

grant usage on schema orders to anon, authenticated, service_role;

create function orders.is_order_buyer(target_order uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.orders o
    where o.id = target_order and o.buyer_id = auth.uid()
  )
$$;

comment on function orders.is_order_buyer(uuid) is
  'True when the caller placed this order. SECURITY DEFINER to break the orders <-> fulfilments policy cycle.';

create function orders.is_order_artist(target_order uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.fulfilments f
    where f.order_id = target_order and f.artist_id = auth.uid()
  )
$$;

comment on function orders.is_order_artist(uuid) is
  'True when the caller owns a fulfilment on this order. Says nothing about which one, or about any other artist''s.';

-- The timing rule from SECURITY.md S1-18 item 2, as a function rather than an
-- inline EXISTS -- for the recursion reason above, and because the rule is
-- subtle enough to deserve one definition rather than one per table.
--
-- `checkout-orders`: the buyer's name, phone and address reach the artist "only
-- after the order reaches `paid`". A fulfilment leaves `awaiting_payment` only
-- by being paid or cancelled, and a cancelled one must not open the address --
-- so both are excluded, and the predicate is stated as a positive list of the
-- states that DO disclose rather than as `<> 'awaiting_payment'`. A state added
-- later then defaults to withholding.
create function orders.artist_may_see_buyer_details(target_order uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.fulfilments f
    where f.order_id = target_order
      and f.artist_id = auth.uid()
      and f.status in ('paid', 'shipped', 'delivered', 'return_requested', 'returned')
  )
$$;

comment on function orders.artist_may_see_buyer_details(uuid) is
  'True only for an artist''s own fulfilment that has reached paid or beyond (checkout-orders; SECURITY.md S1-18 item 2).';

-- Revoke from `public` first: a SECURITY DEFINER function is EXECUTE-able by
-- everyone by default, which would hand these to any role that ever gains a
-- connection.
revoke all on function orders.is_order_buyer(uuid)               from public;
revoke all on function orders.is_order_artist(uuid)              from public;
revoke all on function orders.artist_may_see_buyer_details(uuid) from public;

grant execute on function orders.is_order_buyer(uuid)               to authenticated, service_role;
grant execute on function orders.is_order_artist(uuid)              to authenticated, service_role;
grant execute on function orders.artist_may_see_buyer_details(uuid) to authenticated, service_role;

-- anon gets no EXECUTE. There is no anonymous read of anything in this module,
-- so there is no policy anon evaluates and no reason for the grant.

-- ---------------------------------------------------------------------------
-- 8. Row-level security
-- ---------------------------------------------------------------------------
--
-- ENABLE and FORCE on every table, verified by tests/integration/schema-invariants.
-- FORCE matters: without it the role the migrations run as reads past its own
-- policies, and every "another artist cannot see this" test passes for the
-- wrong reason (SECURITY.md S0-1 item 5).

alter table orders                  enable row level security;
alter table orders                  force  row level security;
alter table order_shipping_details  enable row level security;
alter table order_shipping_details  force  row level security;
alter table fulfilments             enable row level security;
alter table fulfilments             force  row level security;
alter table order_items             enable row level security;
alter table order_items             force  row level security;
alter table order_transitions       enable row level security;
alter table order_transitions       force  row level security;
alter table reservations            enable row level security;
alter table reservations            force  row level security;
alter table payments                enable row level security;
alter table payments                force  row level security;

-- ---------------------------------------------------------------------------
-- 9. Grants
-- ---------------------------------------------------------------------------
--
-- anon gets nothing at all. There is no such thing as an anonymous read of an
-- order, and the RLS matrix in SECURITY.md gives anon "none" on every table in
-- this module. The revoke is explicit rather than assumed, because on a hosted
-- Supabase project default privileges hand new tables in `public` to anon and
-- authenticated, and a policy no grant lets you reach is not a defence you can
-- rely on having.

revoke all on orders                 from anon, authenticated;
revoke all on order_shipping_details from anon, authenticated;
revoke all on fulfilments            from anon, authenticated;
revoke all on order_items            from anon, authenticated;
revoke all on order_transitions      from anon, authenticated;
revoke all on reservations           from anon, authenticated;
revoke all on payments               from anon, authenticated;

-- `authenticated` reads its own rows and writes nothing. Every write in this
-- module goes through the server, because every write is either money or a
-- state-machine edge, and neither is safe to expose to a role that reaches the
-- table over HTTP with a key that ships in the browser bundle.
grant select on orders                 to authenticated;
grant select on order_shipping_details to authenticated;
grant select on fulfilments            to authenticated;
grant select on order_items            to authenticated;
grant select on order_transitions      to authenticated;
grant select on reservations           to authenticated;
grant select on payments               to authenticated;

grant select, insert, update on orders                 to service_role;
grant select, insert         on order_shipping_details to service_role;
grant select, insert, update on fulfilments            to service_role;
grant select, insert         on order_items            to service_role;
grant select, insert         on order_transitions      to service_role;
grant select, insert, update on reservations           to service_role;
grant select, insert, update on payments               to service_role;

-- No UPDATE grant on `order_shipping_details`, `order_items` or
-- `order_transitions`, for any role, intentionally. All three are written once,
-- in the transaction that creates the order or records the move. An address
-- correction is an operator conversation, not a silent UPDATE that would leave
-- a parcel already dispatched to the old one; an amended item is SECURITY.md
-- S0-5's forbidden re-price; an amended transition is a falsified history.
-- No DELETE grant anywhere in this module, for any role, intentionally.

-- ---------------------------------------------------------------------------
-- 10. Policies -- `orders`
-- ---------------------------------------------------------------------------
--
-- SECURITY.md S1-18 item 1: every policy names a concrete subject. Not one
-- `using (true)` for `authenticated` appears below; nothing in this module is
-- public data.

create policy orders_buyer_read on orders
  for select to authenticated
  using (buyer_id = auth.uid());

-- The artist reaches the order only through their own fulfilment. An EXISTS
-- against a row the caller owns is one of the four predicate shapes S1-18
-- permits, and it is what keeps an artist from listing the marketplace's orders.
create policy orders_artist_read on orders
  for select to authenticated
  using (orders.is_order_artist(id));

create policy orders_admin_read on orders
  for select to authenticated
  using (accounts.auth_is_admin());

-- authenticated INSERT/UPDATE/DELETE on `orders`: NO POLICY, INTENTIONALLY, and
-- SECURITY.md S0-5 item 3 names this one specifically. A buyer who could UPDATE
-- their own order row would set `total_agorot` to 1 after placing it. A buyer
-- who could INSERT one would mint an order that no reservation transaction ever
-- checked availability for.

create policy orders_server_read on orders
  for select to service_role
  using (true);

create policy orders_server_insert on orders
  for insert to service_role
  with check (true);

-- UPDATE is the status column and nothing else in practice; the amounts are
-- never rewritten (O5). The `with check` repeats the `using` clause rather than
-- being `true`, so a server-side bug cannot move a row out from under the
-- policy that admitted it.
create policy orders_server_update on orders
  for update to service_role
  using (true)
  with check (true);

-- orders DELETE: NO POLICY, FOR ANY ROLE, INTENTIONALLY. A cancelled order is
-- `status = 'cancelled'`, which keeps the transition history, the released
-- reservations and the payment record legible. Deleting it would orphan all
-- three and lose the evidence for a refund.

-- ---------------------------------------------------------------------------
-- 11. Policies -- `order_shipping_details`
-- ---------------------------------------------------------------------------
--
-- The timing rule, made enforceable. SECURITY.md S1-18 item 2 gives the
-- predicate verbatim: ownership AND state together.
--
-- `checkout-orders`: the artist sees the buyer's name, phone and delivery
-- address "only after the order reaches `paid`", and only for their own
-- fulfilment. `f.status <> 'awaiting_payment'` is that rule -- a fulfilment
-- leaves `awaiting_payment` only by being paid or cancelled, and a cancelled
-- fulfilment is handled below.

create policy order_shipping_details_buyer_read on order_shipping_details
  for select to authenticated
  using (orders.is_order_buyer(order_id));

create policy order_shipping_details_artist_read on order_shipping_details
  for select to authenticated
  using (orders.artist_may_see_buyer_details(order_id));

create policy order_shipping_details_admin_read on order_shipping_details
  for select to authenticated
  using (accounts.auth_is_admin());

create policy order_shipping_details_server_read on order_shipping_details
  for select to service_role
  using (true);

create policy order_shipping_details_server_insert on order_shipping_details
  for insert to service_role
  with check (true);

-- order_shipping_details UPDATE and DELETE: NO POLICY, FOR ANY ROLE,
-- INTENTIONALLY. See the grants section.

-- ---------------------------------------------------------------------------
-- 12. Policies -- `fulfilments`
-- ---------------------------------------------------------------------------
--
-- `checkout-orders`: "the system returns a not-found response" when an artist
-- requests another artist's fulfilment. The policy is the first half of that --
-- the row is not visible, so the module's read returns nothing -- and
-- `fulfilment-views.ts` turns nothing into `not_found` rather than `forbidden`,
-- because a 403 confirms the resource exists (SECURITY.md S1-18 item 3).

create policy fulfilments_artist_read on fulfilments
  for select to authenticated
  using (artist_id = auth.uid());

create policy fulfilments_buyer_read on fulfilments
  for select to authenticated
  using (orders.is_order_buyer(order_id));

create policy fulfilments_admin_read on fulfilments
  for select to authenticated
  using (accounts.auth_is_admin());

-- authenticated INSERT/UPDATE/DELETE: NO POLICY, INTENTIONALLY. An artist who
-- could UPDATE their fulfilment would set it to `shipped` with no carrier and
-- no tracking reference, and to `delivered` -- which is the payout clock
-- (SECURITY.md SPEC-D, S1-10). Both moves go through orders.transition().

create policy fulfilments_server_read on fulfilments
  for select to service_role
  using (true);

create policy fulfilments_server_insert on fulfilments
  for insert to service_role
  with check (true);

create policy fulfilments_server_update on fulfilments
  for update to service_role
  using (true)
  with check (true);

-- fulfilments DELETE: NO POLICY, FOR ANY ROLE, INTENTIONALLY. Same reason as
-- `orders`: a cancelled fulfilment is a fact about what an artist was asked to
-- do, and `shipping_dispatches` references it by id.

-- ---------------------------------------------------------------------------
-- 13. Policies -- `order_items`
-- ---------------------------------------------------------------------------

create policy order_items_buyer_read on order_items
  for select to authenticated
  using (orders.is_order_buyer(order_id));

-- The artist sees their own lines and no others. On a two-artist order this is
-- what stops each artist reading the other's price -- which is commercially
-- sensitive between competitors on one marketplace.
create policy order_items_artist_read on order_items
  for select to authenticated
  using (artist_id = auth.uid());

create policy order_items_admin_read on order_items
  for select to authenticated
  using (accounts.auth_is_admin());

create policy order_items_server_read on order_items
  for select to service_role
  using (true);

create policy order_items_server_insert on order_items
  for insert to service_role
  with check (true);

-- order_items UPDATE and DELETE: NO POLICY, FOR ANY ROLE, INTENTIONALLY.
-- SECURITY.md S0-5: an amended line is a re-priced sale.

-- ---------------------------------------------------------------------------
-- 14. Policies -- `order_transitions`
-- ---------------------------------------------------------------------------

create policy order_transitions_buyer_read on order_transitions
  for select to authenticated
  using (orders.is_order_buyer(order_id));

create policy order_transitions_artist_read on order_transitions
  for select to authenticated
  using (orders.is_order_artist(order_id));

create policy order_transitions_admin_read on order_transitions
  for select to authenticated
  using (accounts.auth_is_admin());

create policy order_transitions_server_read on order_transitions
  for select to service_role
  using (true);

create policy order_transitions_server_insert on order_transitions
  for insert to service_role
  with check (true);

-- order_transitions UPDATE and DELETE: NO POLICY, FOR ANY ROLE, INTENTIONALLY.
-- The history is append-only. `checkout-orders` requires that every transition
-- be recorded with actor and timestamp, and a record that can be edited records
-- nothing.

-- ---------------------------------------------------------------------------
-- 15. Policies -- `reservations`
-- ---------------------------------------------------------------------------
--
-- SECURITY.md S1-18 item 4: readable only by its own buyer and admins.
-- Deliberately NOT by the artist -- "otherwise an artist watches who is about to
-- buy, and a competitor watches demand." Note this is the one table in the
-- module where the artist gets nothing at all.

create policy reservations_buyer_read on reservations
  for select to authenticated
  using (buyer_id = auth.uid());

create policy reservations_admin_read on reservations
  for select to authenticated
  using (accounts.auth_is_admin());

-- authenticated writes: NO POLICY, INTENTIONALLY, and this is the most
-- important absence in the file. A buyer who could INSERT a reservation through
-- the data API would take the hold outside the transaction that holds the
-- artwork row lock -- which is the double sale, arrived at by a different road.
-- A buyer who could UPDATE one would set `confirmed_at` and own a painting they
-- never paid for.

create policy reservations_server_read on reservations
  for select to service_role
  using (true);

create policy reservations_server_insert on reservations
  for insert to service_role
  with check (true);

create policy reservations_server_update on reservations
  for update to service_role
  using (true)
  with check (true);

-- reservations DELETE: NO POLICY, FOR ANY ROLE, INTENTIONALLY. Release is
-- `released_at` plus a reason, never a delete. The row is the answer to "why
-- did this piece come back onto the market", and the sweep would otherwise
-- erase its own evidence.

-- ---------------------------------------------------------------------------
-- 16. Policies -- `payments`
-- ---------------------------------------------------------------------------

create policy payments_buyer_read on payments
  for select to authenticated
  using (orders.is_order_buyer(order_id));

create policy payments_admin_read on payments
  for select to authenticated
  using (accounts.auth_is_admin());

-- The artist does NOT read `payments`. They learn that an order is paid from
-- their fulfilment's status, which is all they need to dispatch; the payment
-- reference and the settling operator are not theirs to see.

create policy payments_server_read on payments
  for select to service_role
  using (true);

create policy payments_server_insert on payments
  for insert to service_role
  with check (true);

create policy payments_server_update on payments
  for update to service_role
  using (true)
  with check (true);

-- payments DELETE: NO POLICY, FOR ANY ROLE, INTENTIONALLY. A failed or refunded
-- payment is part of the money's history.
