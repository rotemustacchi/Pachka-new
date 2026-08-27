-- Shipping and returns: the flat-rate table, the dispatch record, and the
-- return case.
--
-- Owner: shipping
--
-- Five tables. Three of them are the rate table (shipping-and-returns,
-- "Flat-rate shipping tiers": cost comes from a configured zone x size-tier
-- table, editable by an admin without a deployment, and no carrier API is
-- called). The other two are the per-fulfilment dispatch record and the return
-- case.
--
-- ARCHITECTURE.md's ownership table names shipping_zones, shipping_tiers,
-- shipping_rates and returns. `shipping_dispatches` is a fifth table this
-- module owns and that table does not list; it is reported to the lead
-- architect rather than assumed. It exists because carrier name, tracking
-- reference, the packaging confirmation and the dispatch deadline are
-- shipping's rules, while `fulfilments` belongs to orders -- and no module
-- writes another module's tables. Orders keeps the fulfilment state machine;
-- shipping keeps the evidence that a `shipped` transition is allowed to happen
-- at all.
--
-- Four decisions worth writing down.
--
-- 1. Dimensions are integer millimetres and weights integer grams.
--    A tier boundary compared as a float is a money bug waiting for the
--    artwork that is 0.1 mm over. Same reasoning as agorot, one scale down.
--
-- 2. Zone membership lives on the zone row (`cities`, `postal_prefixes`)
--    rather than in a sixth table. It keeps the admin edit surface to one row
--    per zone, and it keeps this migration inside the set of tables the
--    architecture contract already grants this module. There is deliberately
--    NO catch-all zone: `shipping-and-returns` requires an address matching no
--    zone to block checkout, and a fallback row would quietly delete that
--    behaviour for every future address.
--
-- 3. The refund gate and the inventory gate are CHECK constraints, not just
--    module code. SECURITY.md SPEC-E is that the party who loses money by
--    refunding was the only party able to release it; the resolution routes
--    the refund through an operator's receipt record or an admin resolution.
--    `returns_refund_requires_gate` makes "refund authorised out of nowhere"
--    unrepresentable, and `returns_inventory_requires_intact` does the same
--    for restoring a damaged artwork to sale.
--
-- 4. No artist address column anywhere in this migration. Returns route to the
--    PACHKA return address (SECURITY.md SPEC-A, resolved as option 1) and the
--    forwarding label is generated for the operator at the moment of
--    forwarding from `artist_contact_details`, which has every grant revoked.
--    Storing it here would put the artist's street address on a row a buyer's
--    own policy grants them.

-- ---------------------------------------------------------------------------
-- 1. The rate table
-- ---------------------------------------------------------------------------

create table shipping_zones (
  id              uuid        primary key default gen_random_uuid(),
  code            text        not null unique check (code ~ '^[a-z0-9_]+$'),
  display_name    text        not null check (length(btrim(display_name)) > 0),
  country_code    text        not null default 'IL' check (country_code ~ '^[A-Z]{2}$'),
  -- Normalised, lowercased city names this zone covers, and postal-code
  -- prefixes as a second route for addresses whose city string does not match.
  cities          text[]      not null default '{}',
  postal_prefixes text[]      not null default '{}',
  active          boolean     not null default true,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

comment on table shipping_zones is
  'Delivery zones. An address matching none of them blocks checkout by design; there is no catch-all row.';

create table shipping_tiers (
  id               uuid        primary key default gen_random_uuid(),
  code             text        not null unique check (code ~ '^[a-z0-9_]+$'),
  display_name     text        not null check (length(btrim(display_name)) > 0),
  -- Ascending size. Unique so that "the largest applicable tier" is a total
  -- order and never a coin toss between two tiers sharing a rank.
  ordinal          integer     not null unique check (ordinal >= 0),
  max_length_mm    integer     not null check (max_length_mm > 0),
  max_width_mm     integer     not null check (max_width_mm > 0),
  max_height_mm    integer     not null check (max_height_mm > 0),
  max_weight_grams integer     not null check (max_weight_grams > 0),
  active           boolean     not null default true,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

comment on table shipping_tiers is
  'Package size tiers in millimetres and grams. Integers only: a float tier boundary is a rounding bug at the edge.';

create table shipping_rates (
  id            uuid        primary key default gen_random_uuid(),
  zone_id       uuid        not null references shipping_zones (id) on delete cascade,
  tier_id       uuid        not null references shipping_tiers (id) on delete cascade,
  amount_agorot bigint      not null check (amount_agorot >= 0),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),

  constraint shipping_rates_one_per_zone_and_tier unique (zone_id, tier_id)
);

comment on table shipping_rates is
  'Flat rate per zone x tier, in agorot. Admin-editable without a deployment; no carrier API is ever called.';

-- ---------------------------------------------------------------------------
-- 2. The dispatch record
-- ---------------------------------------------------------------------------

create table shipping_dispatches (
  id                              uuid        primary key default gen_random_uuid(),
  -- Owned by orders, which does not exist yet, so no foreign key -- the same
  -- call `reviews.order_id` made. Adding one later is additive and belongs to
  -- whoever ships `fulfilments`.
  fulfilment_id                   uuid        not null unique,
  order_id                        uuid        not null,
  artist_id                       uuid        not null references profiles (user_id),
  -- The artwork's stated lead time, snapshotted when the fulfilment is paid so
  -- that an artist editing the listing afterwards cannot move their own deadline.
  lead_time_days                  integer     not null default 0 check (lead_time_days >= 0),
  -- True for ceramics and objects, and for anything the artist marked fragile.
  packaging_confirmation_required boolean     not null default false,
  -- Lead time plus the configured grace period, in Israeli business days.
  due_at                          timestamptz not null,

  carrier_name                    text,
  tracking_reference              text,
  packaging_confirmed_at          timestamptz,
  shipped_at                      timestamptz,

  flagged_at                      timestamptz,
  artist_notified_at              timestamptz,

  created_at                      timestamptz not null default now(),
  updated_at                      timestamptz not null default now(),

  -- "The system SHALL require the artist to record a carrier name and tracking
  -- reference when marking a fulfilment shipped." Module code rejects the
  -- attempt with a typed error; this is what stops a shipped row existing
  -- without one however it was written.
  constraint shipping_dispatches_shipped_needs_tracking check (
    shipped_at is null or (
      carrier_name is not null and length(btrim(carrier_name)) > 0 and
      tracking_reference is not null and length(btrim(tracking_reference)) > 0
    )
  ),
  constraint shipping_dispatches_fragile_needs_confirmation check (
    shipped_at is null or not packaging_confirmation_required or packaging_confirmed_at is not null
  )
);

comment on table shipping_dispatches is
  'One row per fulfilment: the dispatch obligation, and the carrier/tracking/packaging evidence that permits a shipped transition.';

create index shipping_dispatches_artist on shipping_dispatches (artist_id);
create index shipping_dispatches_overdue on shipping_dispatches (due_at) where shipped_at is null;

-- ---------------------------------------------------------------------------
-- 3. The return case
-- ---------------------------------------------------------------------------

create table returns (
  id                          uuid        primary key default gen_random_uuid(),
  order_id                    uuid        not null,
  fulfilment_id               uuid        not null,
  artwork_id                  uuid        not null,
  buyer_id                    uuid        not null references profiles (user_id),
  artist_id                   uuid        not null references profiles (user_id),

  --   requested          buyer cancelled in time; parcel is on its way to PACHKA
  --   received_intact    operator has it, undamaged: refund released, stock back
  --   disputed           damage reported, by the operator or later by the artist
  --   unreceived         nothing arrived inside the window; admin review, no refund
  --   resolved_refunded  admin resolved in the buyer's favour
  --   resolved_denied    admin resolved against the buyer
  status                      text        not null default 'requested'
    check (status in ('requested', 'received_intact', 'disputed', 'unreceived',
                      'resolved_refunded', 'resolved_denied')),

  delivered_at                timestamptz not null,
  requested_at                timestamptz not null default now(),
  receipt_deadline_at         timestamptz not null,

  -- Snapshotted server-side at request time. SECURITY.md S0-5: no monetary
  -- figure on this row ever came from a request body.
  item_subtotal_agorot        bigint      not null check (item_subtotal_agorot >= 0),
  shipping_agorot             bigint      not null default 0 check (shipping_agorot >= 0),
  cancellation_fee_agorot     bigint      not null default 0 check (cancellation_fee_agorot >= 0),
  refund_amount_agorot        bigint      check (refund_amount_agorot >= 0),
  refund_authorised_at        timestamptz,

  received_at                 timestamptz,
  received_condition          text        check (received_condition in ('intact', 'damaged')),
  operator_id                 uuid        references profiles (user_id),
  operator_notes              text        not null default '' check (length(operator_notes) <= 4000),
  inventory_restored_at       timestamptz,

  forwarded_at                timestamptz,
  artist_response_deadline_at timestamptz,
  artist_confirmed_at         timestamptz,
  artist_damage_reported_at   timestamptz,

  escalated_at                timestamptz,
  escalation_reason           text,
  resolved_at                 timestamptz,
  resolved_by                 uuid        references profiles (user_id),
  resolution_notes            text        not null default '' check (length(resolution_notes) <= 4000),

  created_at                  timestamptz not null default now(),
  updated_at                  timestamptz not null default now(),

  -- One open case per artwork per fulfilment. Per artwork rather than per
  -- fulfilment because a fulfilment may carry several artworks and inventory is
  -- restored one artwork at a time.
  constraint returns_one_per_fulfilment_artwork unique (fulfilment_id, artwork_id),

  -- The refund gate, in the schema. Money is released by an operator's intact
  -- receipt or by an admin resolution -- never by artist silence, never by a
  -- row that simply appeared with a timestamp in it (SECURITY.md SPEC-E).
  constraint returns_refund_requires_gate check (
    refund_authorised_at is null or status in ('received_intact', 'resolved_refunded')
  ),
  -- The inventory gate. "Restore only when the return completes with the
  -- artwork intact" -- so a damaged return can be refunded by an admin without
  -- putting a broken artwork back on sale.
  constraint returns_inventory_requires_intact check (
    inventory_restored_at is null or received_condition = 'intact'
  ),
  constraint returns_received_has_condition check (
    (received_at is null) = (received_condition is null)
  )
);

comment on table returns is
  'Return cases. Deliberately holds no artist address: returns route to the PACHKA return address and the forwarding label is generated at forwarding time (SECURITY.md SPEC-A).';

create index returns_artwork_open on returns (artwork_id)
  where status in ('requested', 'disputed', 'unreceived');
create index returns_buyer on returns (buyer_id);
create index returns_artist on returns (artist_id);
create index returns_awaiting_receipt on returns (receipt_deadline_at) where status = 'requested';

-- ---------------------------------------------------------------------------
-- 4. updated_at
-- ---------------------------------------------------------------------------

create trigger shipping_zones_set_updated_at
  before update on shipping_zones
  for each row execute function public.set_updated_at();

create trigger shipping_tiers_set_updated_at
  before update on shipping_tiers
  for each row execute function public.set_updated_at();

create trigger shipping_rates_set_updated_at
  before update on shipping_rates
  for each row execute function public.set_updated_at();

create trigger shipping_dispatches_set_updated_at
  before update on shipping_dispatches
  for each row execute function public.set_updated_at();

create trigger returns_set_updated_at
  before update on returns
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- 5. Row-level security
-- ---------------------------------------------------------------------------
--
-- The rate table is one of the few things SECURITY.md's policy matrix names as
-- genuinely public: a buyer has to be shown the shipping cost before they pay
-- it. Everything else here is private, and no table in this migration has an
-- INSERT, UPDATE or DELETE policy for `authenticated`. Every write goes through
-- the server, which is the only path that also checks who is asking, snapshots
-- the money server-side, and keeps the artist's address out of the buyer's view.

alter table shipping_zones      enable row level security;
alter table shipping_zones      force  row level security;
alter table shipping_tiers      enable row level security;
alter table shipping_tiers      force  row level security;
alter table shipping_rates      enable row level security;
alter table shipping_rates      force  row level security;
alter table shipping_dispatches enable row level security;
alter table shipping_dispatches force  row level security;
alter table returns             enable row level security;
alter table returns             force  row level security;

create policy shipping_zones_public_read on shipping_zones
  for select to anon, authenticated
  using (active);

create policy shipping_tiers_public_read on shipping_tiers
  for select to anon, authenticated
  using (active);

-- A rate is public only while both sides of its key are. A zone deactivated
-- ahead of a price change should not leak the new price through its rates.
create policy shipping_rates_public_read on shipping_rates
  for select to anon, authenticated
  using (
    exists (select 1 from shipping_zones z where z.id = zone_id and z.active)
    and exists (select 1 from shipping_tiers t where t.id = tier_id and t.active)
  );

-- The artist sees their own dispatches and nobody else's: a cross-artist read
-- returns no row at all, which is the 404 SECURITY.md S1-18 asks for rather
-- than a 403 that confirms the fulfilment exists. The buyer's read is served
-- from the orders module's own tables, not from here.
create policy shipping_dispatches_artist_read on shipping_dispatches
  for select to authenticated
  using (artist_id = auth.uid() or accounts.auth_is_admin());

create policy returns_party_read on returns
  for select to authenticated
  using (buyer_id = auth.uid() or artist_id = auth.uid() or accounts.auth_is_admin());

-- ---------------------------------------------------------------------------
-- 6. Grants
-- ---------------------------------------------------------------------------
--
-- Stated explicitly, because Supabase ships ALTER DEFAULT PRIVILEGES that can
-- hand a newly created table to anon before anyone writes a policy for it
-- (SECURITY.md S0-1 item 2).

revoke all on shipping_zones      from anon, authenticated;
revoke all on shipping_tiers      from anon, authenticated;
revoke all on shipping_rates      from anon, authenticated;
revoke all on shipping_dispatches from anon, authenticated;
revoke all on returns             from anon, authenticated;

grant select on shipping_zones to anon, authenticated;
grant select on shipping_tiers to anon, authenticated;
grant select on shipping_rates to anon, authenticated;
grant select on shipping_dispatches to authenticated;
grant select on returns             to authenticated;

-- ---------------------------------------------------------------------------
-- 7. Starting rate table
-- ---------------------------------------------------------------------------
--
-- Placeholder pricing so that checkout works on a fresh database and so that
-- the shape is legible. Every number here is the operator's to change from the
-- admin screen -- that is the whole point of the table -- and none of it is
-- read by module code as a constant.

insert into shipping_tiers (code, display_name, ordinal, max_length_mm, max_width_mm, max_height_mm, max_weight_grams)
values
  ('small',  'קטן',  10,  400,  300,  100,   3000),
  ('medium', 'בינוני', 20,  800,  600,  300,  10000),
  ('large',  'גדול', 30, 1400, 1000,  600,  25000);

insert into shipping_zones (code, display_name, cities, postal_prefixes)
values
  ('center', 'מרכז',
   array['תל אביב-יפו', 'תל אביב', 'רמת גן', 'גבעתיים', 'חולון', 'בת ים', 'פתח תקווה', 'ראשון לציון', 'הרצליה', 'בני ברק',
         'tel aviv', 'tel aviv yafo', 'ramat gan', 'givatayim', 'holon', 'bat yam', 'petah tikva', 'rishon lezion', 'herzliya', 'bnei brak'],
   array['5', '6', '7']),
  ('jerusalem', 'ירושלים והסביבה',
   array['ירושלים', 'מבשרת ציון', 'בית שמש',
         'jerusalem', 'mevaseret zion', 'beit shemesh'],
   array['9']),
  ('north', 'צפון',
   array['חיפה', 'נהריה', 'עכו', 'טבריה', 'צפת', 'כרמיאל', 'עפולה', 'קריית ביאליק', 'נצרת',
         'haifa', 'nahariya', 'akko', 'tiberias', 'safed', 'karmiel', 'afula', 'kiryat bialik', 'nazareth'],
   array['1', '2', '3']),
  ('south', 'דרום',
   array['באר שבע', 'אשדוד', 'אשקלון', 'קריית גת', 'דימונה', 'ערד', 'אילת',
         'beer sheva', 'ashdod', 'ashkelon', 'kiryat gat', 'dimona', 'arad', 'eilat'],
   array['8']);

insert into shipping_rates (zone_id, tier_id, amount_agorot)
select z.id, t.id,
       case t.code
         when 'small'  then 2900
         when 'medium' then 4900
         else               8900
       end
       + case z.code when 'center' then 0 else 1000 end
from shipping_zones z cross join shipping_tiers t;
