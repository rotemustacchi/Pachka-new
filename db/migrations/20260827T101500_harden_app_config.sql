-- Harden app_config against the attack in SECURITY.md S1-16.
--
-- Owner: shared
--
-- app_config holds the commission rate, the reservation TTL, the quality
-- thresholds and the ranking weights. That makes it the highest-value write
-- target in the system: commission set to zero earns the platform nothing for a
-- month before anyone notices, a reservation TTL of thirty days freezes the
-- catalog from one cart, and rewritten ranking weights let an artist rank
-- themselves first permanently.
--
-- Three changes, in order of how much they matter:
--
--   1. The browser cannot read this table at all unless signed in, and even
--      then only the handful of rows flagged presentational. `anon` loses its
--      grant entirely — Supabase publishes a PostgREST endpoint for every table
--      in `public` to anyone holding the anon key, and that key ships in the
--      client bundle, so a grant to `anon` is a grant to the internet.
--   2. Bounds are enforced by the database, not by the form. A compromised
--      admin session or a fat-fingered operator cannot store 100% commission.
--   3. Commission becomes an integer count of basis points. ARCHITECTURE.md:
--      money is never a float. A commission of 0.15 stored as a JSON number is
--      a float, and 15% of an odd subtotal computed from it is a rounding
--      argument waiting to happen.

-- --------------------------------------------------------------------------
-- 1. Grants and policies
-- --------------------------------------------------------------------------

revoke all on app_config from anon;
grant select on app_config to authenticated;

drop policy if exists app_config_public_read on app_config;

-- Signed-in users may read only the rows explicitly flagged presentational.
-- There is still no insert/update/delete policy: writes happen server-side,
-- which is the only path that also writes an admin_audit row.
create policy app_config_presentational_read on app_config
  for select
  to authenticated
  using (is_public);

-- FORCE makes the policy apply to the table's owner too, so a future migration
-- that runs as the owner cannot quietly read past it. The privileged server
-- connection still bypasses RLS because its role carries BYPASSRLS; that is a
-- deliberate, single, auditable exception rather than an accident of ownership.
alter table app_config force row level security;

-- --------------------------------------------------------------------------
-- 2. The stored value must match its declared type
-- --------------------------------------------------------------------------

alter table app_config add constraint app_config_value_matches_declared_type check (
  case value_type
    when 'integer' then jsonb_typeof(value) = 'number'
                     and (value::numeric = trunc(value::numeric))
    when 'number'  then jsonb_typeof(value) = 'number'
    when 'string'  then jsonb_typeof(value) = 'string'
    when 'boolean' then jsonb_typeof(value) = 'boolean'
    when 'json'    then true
    else false
  end
);

-- --------------------------------------------------------------------------
-- 3. Commission in basis points
-- --------------------------------------------------------------------------

insert into app_config (key, value, value_type, description, is_public) values
  ('platform.commission_rate_bp', '1500', 'integer',
   'Platform commission on the item subtotal in basis points (1500 = 15%), excluding shipping. Integer, because ARCHITECTURE.md forbids float money. The value in force at order time is copied onto the order and never changes retroactively. Bounded to [0, 5000] by app_config_value_within_bounds — SECURITY.md S1-16.',
   false)
on conflict (key) do nothing;

-- The float key it replaces. Removing a *row* is not the schema removal the
-- forward-only convention guards against: no deployed release reads this key,
-- because no release exists yet. Leaving it would give two sources of truth for
-- the single number the platform earns its money from.
delete from app_config where key = 'platform.commission_rate';

-- --------------------------------------------------------------------------
-- 4. Bounds, per key
-- --------------------------------------------------------------------------
--
-- Anything not listed is unconstrained beyond its declared type. Add a row here
-- when you add a key whose value could hurt someone if it were wrong.

alter table app_config add constraint app_config_value_within_bounds check (
  case key
    -- Money and time
    when 'platform.commission_rate_bp'        then value::numeric between 0 and 5000
    when 'checkout.reservation_ttl_minutes'   then value::numeric between 5 and 1440
    when 'payouts.eligibility_delay_days'     then value::numeric between 0 and 180
    when 'returns.window_days'                then value::numeric between 14 and 365
    when 'returns.receipt_window_days'        then value::numeric between 1 and 365
    -- Israeli consumer law permits a cancellation fee of at most 5%.
    when 'returns.cancellation_fee_rate'      then value::numeric between 0 and 0.05
    when 'shipping.unshipped_grace_days'      then value::numeric between 0 and 60

    -- Matchmaker. Weights and normalised scores are fractions of one; a weight
    -- above one lets a single signal swamp the others.
    when 'matchmaker.result_count'            then value::numeric between 1 and 50
    when 'matchmaker.sparse_catalog_threshold' then value::numeric between 0 and 10000
    when 'matchmaker.over_budget_tolerance'   then value::numeric between 0 and 1
    when 'matchmaker.minimum_score'           then value::numeric between 0 and 1
    when 'matchmaker.tie_tolerance'           then value::numeric between 0 and 1
    when 'matchmaker.weight_embedding'        then value::numeric between 0 and 1
    when 'matchmaker.weight_taxonomy'         then value::numeric between 0 and 1
    when 'matchmaker.weight_budget'           then value::numeric between 0 and 1
    when 'matchmaker.weight_size'             then value::numeric between 0 and 1
    when 'matchmaker.weight_freshness'        then value::numeric between 0 and 1

    -- Upload gate. Zero here switches the quality and safety gates off.
    when 'upload.min_shorter_edge_px'         then value::numeric between 200 and 10000
    when 'upload.min_file_size_bytes'         then value::numeric between 1024 and 104857600
    when 'upload.blur_threshold'              then value::numeric between 0 and 10000
    when 'upload.safety_confidence_threshold' then value::numeric between 0 and 1
    when 'upload.max_display_dimension_px'    then value::numeric between 200 and 10000
    when 'upload.display_target_bytes'        then value::numeric between 1024 and 104857600

    else true
  end
);
