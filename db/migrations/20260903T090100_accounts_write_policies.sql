-- accounts: the server's write path for identity, profiles and reviews.
--
-- Owner: accounts
--
-- Forward-only and additive: see db/README.md. No down migration exists.
--
-- 20260827T140000 said this, and meant it:
--
--   "There is deliberately NO INSERT, UPDATE or DELETE policy for
--    `authenticated` on ANY table in this migration."
--
-- That decision stands and this migration does not touch it. What that
-- migration did not say -- and what turned out to be true -- is that there was
-- no INSERT, UPDATE or DELETE policy for *anyone*, `service_role` included, on
-- any of these tables, all of which carry FORCE ROW LEVEL SECURITY. Every
-- server-side write, registration included, worked only because the connection
-- role bypassed RLS. The migration recorded that as an assumption:
--
--   "The privileged server connection still bypasses RLS because its role
--    carries BYPASSRLS."
--
-- Nothing tested it, and nothing could: the harness connected as a superuser,
-- which bypasses RLS before BYPASSRLS or FORCE is consulted. Had production's
-- DATABASE_URL resolved to a role without that attribute, registration would
-- have failed for every visitor while the suite stayed green. See
-- docs/security-audit-01.md finding H3 and ARCHITECTURE.md, "Tests connect as a
-- non-superuser role".
--
-- So: explicit policies for `service_role`, table by table, for the writes the
-- module actually performs and no others. Where a write does not exist, the
-- absence is stated in words rather than left as silence -- ARCHITECTURE.md
-- treats silence as an omission and an explicit comment as a decision.

-- ---------------------------------------------------------------------------
-- 1. Grants
-- ---------------------------------------------------------------------------
--
-- Stated explicitly, and never wider than the policies below. Supabase ships
-- ALTER DEFAULT PRIVILEGES that grant table privileges to anon and
-- authenticated in `public`, so each revoke is restated rather than assumed
-- (SECURITY.md S0-1 item 2). None of these adds anything for anon or
-- authenticated; the existing SELECT grants from 20260827T140000 stand.

grant select, insert                 on profiles               to service_role;
grant select, insert, update         on account_status         to service_role;
grant select, insert                 on user_roles             to service_role;
grant select, insert, update         on artist_profiles        to service_role;
grant select, insert, update         on artist_contact_details to service_role;
grant select, insert, update         on artist_payout_details  to service_role;
grant select, insert, update         on reviews                to service_role;
grant select, insert, delete         on auth_rate_limit_events to service_role;

-- `auth_rate_limit_events.id` is `bigserial`, so its default calls nextval()
-- and the writer needs the sequence as well as the table. An identity column
-- would not need this -- Postgres reaches its own identity sequence without a
-- separate privilege check -- and every other table here uses one. This single
-- grant is the difference, and without it every rate-limit write fails with
-- "permission denied for sequence".
grant usage on sequence auth_rate_limit_events_id_seq to service_role;

revoke all on artist_contact_details from anon, authenticated;
revoke all on artist_payout_details  from anon, authenticated;
revoke all on auth_rate_limit_events from anon, authenticated;

-- ---------------------------------------------------------------------------
-- 2. Identity: profiles, account_status, user_roles
-- ---------------------------------------------------------------------------
--
-- `registerAccount` writes all three inside one transaction: a profile row, an
-- account-status row, and the literal role 'buyer'.
--
-- Each policy below is `to service_role` and uses an unrestricted predicate.
-- SECURITY.md's cross-cutting rule reserves `using (true)` for rows genuinely
-- public to the internet; the exception taken here is the one 20260827T160000
-- argued for `reports` and is narrow in the same way. `service_role` is
-- server-only by construction, the server has already decided who may do this
-- before it opens a transaction, and a policy predicate restating that decision
-- would mean a reader had to check two places and keep them in step. The rule
-- exists to stop `using (true)` reaching anon or authenticated, and neither
-- appears anywhere in this migration.

create policy profiles_server_read on profiles
  for select to service_role
  using (true);

-- INSERT: registration. The row is created once, when the account is.
create policy profiles_server_insert on profiles
  for insert to service_role
  with check (true);

-- profiles UPDATE and DELETE: NO POLICY, FOR ANY ROLE, INTENTIONALLY.
--
-- Nothing in the module updates a profile row: an artist's public presentation
-- lives in `artist_profiles`, which has its own upsert below and its own
-- contact scan. Adding an UPDATE policy here for symmetry would open a second,
-- unscanned way to change a display name. Account erasure (SECURITY.md S3-30)
-- is a separate documented path that has not been built; when it is, it gets a
-- migration and a decision of its own rather than inheriting a DELETE policy
-- nobody argued for.

create policy account_status_server_read on account_status
  for select to service_role
  using (true);

-- INSERT at registration; UPDATE for suspension, reinstatement and the
-- email-verification mirror.
create policy account_status_server_insert on account_status
  for insert to service_role
  with check (true);

create policy account_status_server_update on account_status
  for update to service_role
  using (true)
  with check (true);

-- account_status DELETE: NO POLICY, INTENTIONALLY. A status row is the account;
-- deleting one would leave a profile with no suspension or verification state
-- and every check that reads it would silently see "not suspended".

create policy user_roles_server_read on user_roles
  for select to service_role
  using (true);

-- INSERT only, and the predicate is not decorative. SECURITY.md S0-2 item 3
-- requires that no code path insert a role value taken from a request:
-- registration hard-codes 'buyer' and `accounts.grant_artist_role()` hard-codes
-- 'artist'. Admin "is a manual database operation" (S0-2 item 4) -- a human at
-- a psql prompt, not an application write -- so the application's own role has
-- no way to mint one even if a caller found a way to reach this insert with an
-- arbitrary string. This is the one place in the migration where a `with check`
-- can restate a real rule instead of an unrestricted one, so it does.
create policy user_roles_server_insert on user_roles
  for insert to service_role
  with check (role in ('buyer', 'artist'));

-- user_roles UPDATE and DELETE: NO POLICY, FOR ANY ROLE, INTENTIONALLY.
--
-- There is no revoke path in the module, and the data-API side is asserted
-- against directly in accounts-roles.test.ts: a signed-in user deleting their
-- own rows here would be deleting the only record of what they are. Removing a
-- role is an operator action taken at the database, in the same place and with
-- the same deliberation as granting admin.

-- ---------------------------------------------------------------------------
-- 3. Artist presentation and the split-out secret columns
-- ---------------------------------------------------------------------------
--
-- ARCHITECTURE.md, "Table split for column-level secrecy": `artist_profiles`
-- holds only what a buyer may see; email, phone, street address and social
-- handles live in `artist_contact_details` and bank details in
-- `artist_payout_details`, both with every grant revoked from anon and
-- authenticated and reachable only through the server.
--
-- All three take INSERT and UPDATE, because all three are written with
-- `on conflict (user_id) do update` -- an artist editing their profile hits the
-- update arm of the same statement that created it, and a policy that covered
-- only INSERT would let them create a profile once and never change it.

create policy artist_profiles_server_read on artist_profiles
  for select to service_role
  using (true);

create policy artist_profiles_server_insert on artist_profiles
  for insert to service_role
  with check (true);

create policy artist_profiles_server_update on artist_profiles
  for update to service_role
  using (true)
  with check (true);

create policy artist_contact_details_server_read on artist_contact_details
  for select to service_role
  using (true);

create policy artist_contact_details_server_insert on artist_contact_details
  for insert to service_role
  with check (true);

create policy artist_contact_details_server_update on artist_contact_details
  for update to service_role
  using (true)
  with check (true);

-- `artist_payout_details` has no writer in the module yet -- `payouts` is not
-- built. It gets policies anyway, and that is not speculative granting: the
-- table exists precisely so that bank details are reachable only through the
-- server, which is a write path the design already specifies and which the
-- accounts data-API tests already exercise. Leaving it closed would say "no
-- role may ever write bank details", which is not the decision anyone made.
create policy artist_payout_details_server_read on artist_payout_details
  for select to service_role
  using (true);

create policy artist_payout_details_server_insert on artist_payout_details
  for insert to service_role
  with check (true);

create policy artist_payout_details_server_update on artist_payout_details
  for update to service_role
  using (true)
  with check (true);

-- No DELETE on any of the three. An artist who withdraws replaces their details
-- or has the account suspended; erasing the row is the data-retention path,
-- which tokenises rather than deletes and does not exist yet.

-- anon and authenticated: NO WRITE POLICY OF ANY KIND ON ANY TABLE IN THIS
-- MIGRATION, INTENTIONALLY. This restates 20260827T140000's decision because a
-- migration that adds write policies is exactly where a future reader will look
-- to see whether it still holds.
--
-- The reason is not squeamishness about the data API. `artist_profiles.biography`
-- is scanned for contact details on the way in -- an artist who writes their
-- phone number into their public biography is refused, because the whole point
-- of splitting `artist_contact_details` out is that contact information reaches
-- buyers through PACHKA and not around it. A `for update to authenticated`
-- policy on `artist_profiles` would let an artist PATCH /rest/v1/artist_profiles
-- straight past the scanner. The scan runs in the module, so the write has to
-- as well.

-- ---------------------------------------------------------------------------
-- 4. Reviews
-- ---------------------------------------------------------------------------
--
-- Written by the server for the same reason: review bodies are contact-scanned
-- too, and `published` is flipped by the returns flow rather than by the buyer.

create policy reviews_server_read on reviews
  for select to service_role
  using (true);

create policy reviews_server_insert on reviews
  for insert to service_role
  with check (true);

create policy reviews_server_update on reviews
  for update to service_role
  using (true)
  with check (true);

-- reviews DELETE: NO POLICY, FOR ANY ROLE, INTENTIONALLY. A review that should
-- not be shown is unpublished, which is reversible and leaves the record of
-- what the buyer said; `unpublishReviewsForOrder` and `restoreReviewsForOrder`
-- are both UPDATEs for that reason. Deleting would make a returned order look
-- like one that was never reviewed.

-- ---------------------------------------------------------------------------
-- 5. Rate-limit counters
-- ---------------------------------------------------------------------------
--
-- Server-only in every direction, as 20260827T140100 intended: a client that
-- could delete rows here could lift its own rate limit, and one that could read
-- them could confirm whether an address has been tried. The existing
-- admin-read policy for `authenticated` is untouched.
--
-- SELECT is a real requirement and not a courtesy: the limiter counts rows in
-- the window before it decides. Without a read policy the count comes back
-- zero, RLS filters rather than raises, and the rate limit silently stops
-- limiting -- an outcome strictly worse than an error, because sign-in and
-- registration would keep working while the brute-force guard was gone.

create policy auth_rate_limit_events_server_read on auth_rate_limit_events
  for select to service_role
  using (true);

create policy auth_rate_limit_events_server_insert on auth_rate_limit_events
  for insert to service_role
  with check (subject ~ '^[0-9a-f]{64}$');

-- DELETE is the prune sweep. `occurred_at < now()` is deliberate: the sweep
-- removes attempts that have aged out of their window, and there is no reason
-- for it to be able to delete a row being written this instant. Same shape as
-- the moderation counter prune in 20260827T160000.
create policy auth_rate_limit_events_server_prune on auth_rate_limit_events
  for delete to service_role
  using (occurred_at < now());

-- No UPDATE policy: an attempt is a fact about a moment. It is written once and
-- swept, never amended.
