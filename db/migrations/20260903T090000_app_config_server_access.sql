-- app_config: the server's own read and write path.
--
-- Owner: shared
--
-- Forward-only and additive: see db/README.md. No down migration exists.
--
-- ARCHITECTURE.md, "Every table needs write policies, not just read policies":
-- a table with FORCE ROW LEVEL SECURITY and only `for select` policies permits
-- no writes except by a role that bypasses RLS, which makes correctness depend
-- on a deployment setting and fails in production while tests stay green.
--
-- This table had exactly one policy: `app_config_presentational_read`, for
-- `authenticated`, restricted to rows flagged `is_public`. Nothing for the
-- server at all, and no grant to `service_role`. Two consequences, and the
-- second is worse than the first:
--
--   1. `setConfig` could not write. An operator changing the commission rate
--      would get "new row violates row-level security policy".
--
--   2. `getConfig` could not READ ANY NON-PUBLIC KEY. It would not error --
--      RLS filters rows, it does not raise -- so every non-public setting would
--      come back missing and `reader.ts` would quietly return the registry's
--      compiled-in default instead. The commission rate, the reservation TTL,
--      the ranking weights and the safety thresholds are all `is_public =
--      false`. Operator tuning would have appeared to save and then done
--      nothing, on the highest-value settings in the system, with no error
--      anywhere. That is the exact shape of failure ARCHITECTURE.md's rule was
--      written to prevent.
--
-- Both were invisible because the test harness connected as a superuser. It no
-- longer does; see tests/harness/login-roles.ts.

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------
--
-- `anon` keeps nothing: 20260827T101500 revoked it deliberately, because the
-- anon key ships in the browser bundle and a grant to `anon` is a grant to the
-- internet. `authenticated` keeps its existing SELECT and gains nothing.

grant select, insert, update on app_config to service_role;

-- ---------------------------------------------------------------------------
-- Policies
-- ---------------------------------------------------------------------------

-- SELECT, service_role: every key, public or not. This is the read `getConfig`
-- performs, and it must see rows `authenticated` may not -- that is what
-- `is_public` distinguishes.
create policy app_config_server_read on app_config
  for select to service_role
  using (true);

-- INSERT and UPDATE, service_role: `setConfig` upserts, so it needs both. A
-- key deployed ahead of its migration is inserted on first write, which is why
-- INSERT is a real requirement and not only UPDATE.
--
-- `with check (true)`, and SECURITY.md's cross-cutting rule says no policy uses
-- it "except on rows that are genuinely public to the internet". The exception
-- is the one 20260827T160000 already took for `reports`, for the same reason:
-- the policy is scoped `to service_role`, which is server-only by construction,
-- and any narrower predicate here would restate a decision the server has
-- already made in code so that a reader had to check both places. What actually
-- constrains the value is in the schema and applies to every writer including
-- this one: `app_config_value_matches_declared_type` and
-- `app_config_value_within_bounds` are check constraints, not policies, so a
-- compromised admin session still cannot store a 100% commission.
create policy app_config_server_write on app_config
  for insert to service_role
  with check (true);

create policy app_config_server_update on app_config
  for update to service_role
  using (true)
  with check (true);

-- DELETE: NO POLICY, FOR ANY ROLE, INTENTIONALLY.
--
-- A key exists because a migration seeded it and the registry declares it, and
-- `registry.test.ts` asserts those two never drift apart. Removing a key is
-- therefore a schema change and belongs in a migration, where the deletion is
-- reviewed alongside the code that stops reading it -- which is exactly how
-- 20260827T101500 retired the float commission rate. A runtime DELETE path
-- would let a compromised server erase settings that the reader would then
-- silently replace with compiled-in defaults, leaving no row and no audit
-- entry to say anything had changed.

-- anon and authenticated: NO WRITE POLICY OF ANY KIND, INTENTIONALLY.
--
-- Writes go through the server because that is the only path that also writes
-- an `admin_audit` row (SECURITY.md S1-16). A data-API write would change the
-- commission rate with nothing recording who did it.
