-- shipping: the server's write path for the rate table, dispatch and returns.
--
-- Owner: shipping
--
-- Forward-only and additive: see db/README.md. No down migration exists.
--
-- 20260827T151000 gave all five tables `for select` policies and no write
-- policy of any kind, with FORCE ROW LEVEL SECURITY on every one. Publishing a
-- rate table, opening a dispatch, recording a shipment and opening a return all
-- depended on the connection role bypassing RLS. ARCHITECTURE.md, "Every table
-- needs write policies, not just read policies".

-- ---------------------------------------------------------------------------
-- 1. Grants
-- ---------------------------------------------------------------------------

grant select, insert, update on shipping_zones       to service_role;
grant select, insert, update on shipping_tiers       to service_role;
grant select, insert, update on shipping_rates       to service_role;
grant select, insert, update on shipping_dispatches  to service_role;
grant select, insert, update on returns              to service_role;

-- ---------------------------------------------------------------------------
-- 2. The rate table: zones, tiers, rates
-- ---------------------------------------------------------------------------
--
-- Operator-maintained reference data. All three are written with
-- `on conflict ... do update`, so each needs INSERT and UPDATE together: the
-- upsert that creates a zone is the same statement that later re-prices it.
--
-- SELECT for `service_role` is separate from the public policies rather than
-- redundant with them. The public ones show anon the *active* rows; quoting has
-- to read the table as it is, including rows an operator has just deactivated,
-- to tell "this tier is switched off" apart from "this tier does not exist".

create policy shipping_zones_server_read on shipping_zones
  for select to service_role
  using (true);

create policy shipping_zones_server_insert on shipping_zones
  for insert to service_role
  with check (true);

create policy shipping_zones_server_update on shipping_zones
  for update to service_role
  using (true)
  with check (true);

create policy shipping_tiers_server_read on shipping_tiers
  for select to service_role
  using (true);

create policy shipping_tiers_server_insert on shipping_tiers
  for insert to service_role
  with check (true);

create policy shipping_tiers_server_update on shipping_tiers
  for update to service_role
  using (true)
  with check (true);

create policy shipping_rates_server_read on shipping_rates
  for select to service_role
  using (true);

create policy shipping_rates_server_insert on shipping_rates
  for insert to service_role
  with check (true);

create policy shipping_rates_server_update on shipping_rates
  for update to service_role
  using (true)
  with check (true);

-- NO DELETE POLICY ON ANY OF THE THREE, FOR ANY ROLE, INTENTIONALLY.
--
-- Retirement is what the `active` flag on zones and tiers is for, and the
-- module offers no delete at all. The difference matters because `shipping_rates`
-- references both by id and a fulfilment's quote is only reconstructible while
-- the zone and tier it named still exist. Deleting a zone would take its rates
-- with it and leave every past quote citing a zone that is not there.
--
-- Deactivating is also the reversible one. An operator who switches off the
-- wrong tier switches it back on; an operator who deletes it re-creates it with
-- a new id and silently orphans nothing anyone will notice until a report is
-- run months later.

-- anon and authenticated: NO WRITE POLICY, INTENTIONALLY. The rate table is
-- what the platform charges for delivery. It is read by the world and written
-- by an operator through the server, where the write is audited.

-- ---------------------------------------------------------------------------
-- 3. Dispatches
-- ---------------------------------------------------------------------------
--
-- INSERT opens a dispatch when a fulfilment starts; UPDATE records the carrier
-- and tracking reference when the artist ships, and stamps `flagged_at` on the
-- overdue sweep.

create policy shipping_dispatches_server_read on shipping_dispatches
  for select to service_role
  using (true);

create policy shipping_dispatches_server_insert on shipping_dispatches
  for insert to service_role
  with check (true);

create policy shipping_dispatches_server_update on shipping_dispatches
  for update to service_role
  using (true)
  with check (true);

-- shipping_dispatches DELETE: NO POLICY, INTENTIONALLY. A dispatch is the
-- record that an artist was asked to ship something and what happened next. A
-- cancelled order leaves a dispatch that was never shipped, which is a fact
-- worth keeping; deleting it would make the artist's on-time record depend on
-- which orders were later cancelled.

-- ---------------------------------------------------------------------------
-- 4. Returns
-- ---------------------------------------------------------------------------
--
-- INSERT opens a return request; UPDATE carries it through receipt, condition
-- and refund. The artist-read policy from 20260827T151000 is untouched.

create policy returns_server_read on returns
  for select to service_role
  using (true);

create policy returns_server_insert on returns
  for insert to service_role
  with check (true);

create policy returns_server_update on returns
  for update to service_role
  using (true)
  with check (true);

-- returns DELETE: NO POLICY, FOR ANY ROLE, INTENTIONALLY. A return is the
-- evidence for a refund, and the money moved. Deleting the row would leave a
-- payment reversal with nothing explaining it.

-- anon and authenticated: NO WRITE POLICY on dispatches or returns,
-- INTENTIONALLY. A buyer who could UPDATE a return row through the data API
-- could mark their own return received and in resaleable condition, which is
-- the refund gate. An artist who could UPDATE a dispatch could stamp
-- `shipped_at` without a carrier or a tracking reference and clear their own
-- overdue flag. Both writes go through the module, which checks the state
-- machine first.
