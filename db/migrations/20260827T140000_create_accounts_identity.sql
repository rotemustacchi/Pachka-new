-- Accounts: identity, roles, and the artist column split.
--
-- Owner: accounts
--
-- This migration is where SECURITY.md's single most important finding is either
-- fixed or lost, so the reasoning is written down rather than assumed.
--
-- S0-1. Supabase publishes a PostgREST data API at /rest/v1/<table> for every
-- table in `public`, reachable by anyone holding the anon key -- and that key
-- legitimately ships in the browser bundle. Row-level security is *row*-level:
-- it cannot hide a column. A policy permissive enough to serve a public artist
-- profile therefore serves every column of that row, including a phone number
-- or a bank account, and no PACHKA code runs on that path. toPublicArtist() is
-- not on it either.
--
-- The fix is structural, not a policy preference: an artist's data is split
-- across three tables by who may see it.
--
--   profiles                 account identity, public: display name, avatar, city
--   account_status           verification and suspension state, self + admin
--   artist_profiles          the buyer-facing artist persona: name, bio, city, photo
--   artist_contact_details   email, phone, street address, social handles
--   artist_payout_details    bank details
--
-- The last two have ALL GRANTS REVOKED from anon and authenticated, so they are
-- unreachable through the data API no matter what policy a later migration
-- adds by mistake. They are readable only through the privileged server
-- connection. The self/admin policies on them are the belt to that braces:
-- Postgres checks grants before policies, so the revoke is the operative
-- control and the policy is what keeps the intent legible.
--
-- S0-2. Roles live in `user_roles` and nowhere else. A signed-in user can
-- rewrite their own `user_metadata` with supabase.auth.updateUser, so a role
-- read from a JWT claim is a role the user grants themselves. `authenticated`
-- gets SELECT on its own rows and no INSERT, UPDATE or DELETE policy at all.
--
-- S1-13. Suspension must stop a live session, not just a new sign-in. Supabase
-- access tokens are self-contained and valid for their full lifetime, so every
-- policy that grants write access tests that the account is not suspended.

-- ---------------------------------------------------------------------------
-- 0. A private schema for the policy helpers
-- ---------------------------------------------------------------------------
--
-- The helpers below must be EXECUTE-able by `anon` and `authenticated`, because
-- an RLS policy expression is evaluated as the querying role. Putting them in
-- `public` would also publish each one as a PostgREST RPC endpoint at
-- /rest/v1/rpc/<name>. Putting them in their own schema keeps them reachable
-- from policies and off the data API, since PostgREST exposes only `public`.

create schema if not exists accounts;
comment on schema accounts is
  'Policy helpers for the accounts module. Deliberately not a PostgREST-exposed schema.';

grant usage on schema accounts to anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 1. Tables
-- ---------------------------------------------------------------------------
--
-- No foreign key to auth.users. The bootstrap migration creates the `auth`
-- schema and the uid()/role() shims but deliberately not Supabase's own
-- `auth.users` table, so that the same migrations run against a plain
-- PostgreSQL in the test harness. app_config.updated_by made the same choice
-- for the same reason.

create table profiles (
  user_id      uuid        primary key,
  -- Shown next to reviews, so it is public by definition. Everything a buyer
  -- may not see lives in another table; nothing else is ever added here.
  display_name text        not null check (length(btrim(display_name)) between 2 and 60),
  avatar_path  text,
  city         text        check (city is null or length(btrim(city)) between 1 and 80),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

comment on table profiles is
  'Public account identity. Public columns only -- display name, avatar, city. Nothing else, ever (SECURITY.md S0-1).';

create table account_status (
  user_id           uuid        primary key references profiles (user_id),
  -- When the auth provider confirmed this account's email address. Written
  -- server-side only, after the provider confirms; never trusted from a client,
  -- and never the authority for an admin or money decision (SECURITY.md S0-2
  -- item 1).
  --
  -- Named `verified_at` rather than `email_verified_at` deliberately. It holds a
  -- timestamp, but the anon-exposure test in accounts-data-api.test.ts rejects
  -- any anonymously- or broadly-readable column whose NAME contains `email`,
  -- and that rule is worth more kept absolute than it costs to name this column
  -- well. The table it sits on already says which account state this is.
  verified_at       timestamptz,
  suspended_at      timestamptz,
  suspended_reason  text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

comment on table account_status is
  'Verification and suspension state. Split out of profiles so that "is this account suspended" is not world-readable through the data API.';

create table user_roles (
  user_id    uuid        not null references profiles (user_id),
  role       text        not null check (role in ('buyer', 'artist', 'admin')),
  granted_at timestamptz not null default now(),
  primary key (user_id, role)
);

comment on table user_roles is
  'The only authority for authorization. Never user_metadata, which the user can rewrite (SECURITY.md S0-2).';

create table artist_profiles (
  user_id      uuid        primary key references profiles (user_id),
  -- An artist persona is not the same string as the account display name used
  -- to attribute a review, so it is stored rather than joined. Both are public.
  display_name text        not null check (length(btrim(display_name)) between 2 and 60),
  biography    text        not null default '' check (length(biography) <= 2000),
  city         text        check (city is null or length(btrim(city)) between 1 and 80),
  avatar_path  text,
  -- Which revision of the contact scanner last cleared the free text above.
  -- When the patterns change, a backfill re-scans and flags rather than
  -- silently editing what an artist wrote (SECURITY.md S2-19 item 4).
  scanner_version integer   not null default 1,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

comment on table artist_profiles is
  'Buyer-facing artist persona. Holds ONLY what a buyer may see. Contact details live in artist_contact_details (SECURITY.md S0-1).';

create table artist_contact_details (
  user_id           uuid        primary key references profiles (user_id),
  email             text,
  phone             text,
  street_address    text,
  postal_code       text,
  instagram_handle  text,
  website_url       text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

comment on table artist_contact_details is
  'Artist contact details. ALL GRANTS REVOKED from anon and authenticated -- reachable only through the privileged server connection (SECURITY.md S0-1).';

create table artist_payout_details (
  user_id             uuid        primary key references profiles (user_id),
  bank_name           text,
  branch              text,
  account_number      text,
  account_holder_name text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

comment on table artist_payout_details is
  'Bank details. ALL GRANTS REVOKED from anon and authenticated. Admin reads are audited (SECURITY.md S1-11, SPEC-K).';

create trigger profiles_set_updated_at
  before update on profiles
  for each row execute function public.set_updated_at();
create trigger account_status_set_updated_at
  before update on account_status
  for each row execute function public.set_updated_at();
create trigger artist_profiles_set_updated_at
  before update on artist_profiles
  for each row execute function public.set_updated_at();
create trigger artist_contact_details_set_updated_at
  before update on artist_contact_details
  for each row execute function public.set_updated_at();
create trigger artist_payout_details_set_updated_at
  before update on artist_payout_details
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- 2. Policy helpers
-- ---------------------------------------------------------------------------
--
-- All SECURITY DEFINER, all with a pinned empty search_path and fully-qualified
-- names. SECURITY.md S0-2 item 2: a SECURITY DEFINER function without a pinned
-- search_path is a privilege-escalation primitive, because the caller can
-- create a shadowing object in a schema that resolves first.
--
-- They are owned by the migration role, which carries BYPASSRLS. That is what
-- lets auth_has_role() read user_roles from inside a policy *on* user_roles
-- without recursing through that policy.

create function accounts.auth_has_role(role_name text) returns boolean
language sql stable security definer
set search_path = ''
as $fn$
  select exists (
    select 1 from public.user_roles
    where user_id = auth.uid() and role = role_name
  )
$fn$;

comment on function accounts.auth_has_role(text) is
  'The only way a policy learns a caller''s role. Reads user_roles, never a JWT claim (SECURITY.md S0-2).';

create function accounts.auth_is_admin() returns boolean
language sql stable security definer
set search_path = ''
as $fn$
  select accounts.auth_has_role('admin')
$fn$;

create function accounts.account_is_suspended(account uuid) returns boolean
language sql stable security definer
set search_path = ''
as $fn$
  select exists (
    select 1 from public.account_status
    where user_id = account and suspended_at is not null
  )
$fn$;

-- The predicate every write path tests. A live JWT belonging to a suspended
-- account authorizes nothing, whether or not the session revocation that
-- accompanies suspension actually landed (SECURITY.md S1-13 item 2).
create function accounts.auth_is_active() returns boolean
language sql stable security definer
set search_path = ''
as $fn$
  select auth.uid() is not null
     and not accounts.account_is_suspended(auth.uid())
$fn$;

-- Whether an artist has anything published.
--
-- `artworks` belongs to the artworks module and does not exist yet. This is
-- resolved at call time rather than at migration time, and it FAILS CLOSED:
-- with no artworks table, no artist has a published artwork, so no artist
-- profile is public. That is not a placeholder -- it is exactly what the spec
-- requires ("Artist has no published artworks -> not found"), and it becomes
-- correct on its own the moment the artworks module lands.
--
-- The exception handler covers the drift case: if `artworks` ships with column
-- names other than the ones assumed here, this returns false rather than
-- throwing, and the accompanying integration test fails loudly to say so.
create function accounts.artist_has_published_artwork(artist uuid) returns boolean
language plpgsql stable security definer
set search_path = ''
as $fn$
declare
  has_one boolean;
begin
  if to_regclass('public.artworks') is null then
    return false;
  end if;

  execute
    'select exists (select 1 from public.artworks where artist_id = $1 and status = ''published'')'
    into has_one
    using artist;

  return coalesce(has_one, false);
exception
  when undefined_column or undefined_table then
    return false;
end
$fn$;

comment on function accounts.artist_has_published_artwork(uuid) is
  'Cross-module read of artworks.status. Fails closed while the artworks module does not exist. See accounts/README for the column contract.';

create function accounts.artist_is_publicly_visible(artist uuid) returns boolean
language sql stable security definer
set search_path = ''
as $fn$
  select accounts.artist_has_published_artwork(artist)
     and not accounts.account_is_suspended(artist)
$fn$;

-- A policy expression is evaluated as the querying role, so anon and
-- authenticated need EXECUTE. PUBLIC does not.
revoke all on function
  accounts.auth_has_role(text),
  accounts.auth_is_admin(),
  accounts.account_is_suspended(uuid),
  accounts.auth_is_active(),
  accounts.artist_has_published_artwork(uuid),
  accounts.artist_is_publicly_visible(uuid)
from public;

grant execute on function
  accounts.auth_has_role(text),
  accounts.auth_is_admin(),
  accounts.account_is_suspended(uuid),
  accounts.auth_is_active(),
  accounts.artist_has_published_artwork(uuid),
  accounts.artist_is_publicly_visible(uuid)
to anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3. Row-level security
-- ---------------------------------------------------------------------------
--
-- ENABLE and FORCE on every table. Without FORCE the table owner -- which is
-- the role migrations run as -- reads straight past its own policies, which
-- quietly makes integration tests pass that should fail (SECURITY.md S0-1
-- item 5). The privileged server connection still bypasses RLS, because its
-- role carries BYPASSRLS: one deliberate, auditable exception rather than an
-- accident of ownership.
--
-- There is deliberately NO INSERT, UPDATE or DELETE policy for `authenticated`
-- on ANY table in this migration. Every write goes through the server, which is
-- the only path that also runs the contact scanner, records who acted, and
-- checks verification. This is stricter than the policy matrix in SECURITY.md,
-- which permits self-writes on some of these tables; the matrix's intent is a
-- floor, and a data-API write path would let an artist put a phone number in a
-- public biography without the scanner ever seeing it.

alter table profiles               enable row level security;
alter table profiles               force  row level security;
alter table account_status         enable row level security;
alter table account_status         force  row level security;
alter table user_roles             enable row level security;
alter table user_roles             force  row level security;
alter table artist_profiles        enable row level security;
alter table artist_profiles        force  row level security;
alter table artist_contact_details enable row level security;
alter table artist_contact_details force  row level security;
alter table artist_payout_details  enable row level security;
alter table artist_payout_details  force  row level security;

-- profiles: genuinely public to the internet. It is one of the few tables the
-- matrix permits USING (true) on, and it earns that only because every column
-- on it is public by construction.
create policy profiles_public_read on profiles
  for select to anon, authenticated
  using (true);

-- account_status: never anonymous. Self and admin.
create policy account_status_self_read on account_status
  for select to authenticated
  using (user_id = auth.uid() or accounts.auth_is_admin());

-- user_roles: self and admin may read; nobody may write through the data API.
-- The artist upgrade is a server-side function that hard-codes the literal
-- 'artist', so there is no code path that inserts a role taken from a request
-- (SECURITY.md S0-2 item 3).
create policy user_roles_self_read on user_roles
  for select to authenticated
  using (user_id = auth.uid() or accounts.auth_is_admin());

-- artist_profiles: public only for an artist with something published who is
-- not suspended. An artist always sees their own row; an admin sees all.
create policy artist_profiles_public_read on artist_profiles
  for select to anon, authenticated
  using (accounts.artist_is_publicly_visible(user_id));

create policy artist_profiles_self_read on artist_profiles
  for select to authenticated
  using (user_id = auth.uid() or accounts.auth_is_admin());

-- The two tables the whole split exists for. The REVOKE below is the control
-- that matters; these policies keep the intent readable and would still hold if
-- a future migration restored a grant by mistake.
create policy artist_contact_details_self_read on artist_contact_details
  for select to authenticated
  using (user_id = auth.uid() or accounts.auth_is_admin());

create policy artist_payout_details_self_read on artist_payout_details
  for select to authenticated
  using (user_id = auth.uid() or accounts.auth_is_admin());

-- ---------------------------------------------------------------------------
-- 4. Grants
-- ---------------------------------------------------------------------------
--
-- Supabase ships ALTER DEFAULT PRIVILEGES granting table privileges to anon and
-- authenticated in `public`, so a newly created table can arrive already
-- exposed. Every grant below is therefore stated explicitly, and every table
-- that must not be reachable is revoked explicitly rather than left to the
-- default (SECURITY.md S0-1 item 2).

revoke all on profiles               from anon, authenticated;
revoke all on account_status         from anon, authenticated;
revoke all on user_roles             from anon, authenticated;
revoke all on artist_profiles        from anon, authenticated;
revoke all on artist_contact_details from anon, authenticated;
revoke all on artist_payout_details  from anon, authenticated;

grant select on profiles        to anon, authenticated;
grant select on artist_profiles to anon, authenticated;
grant select on account_status  to authenticated;
grant select on user_roles      to authenticated;

-- artist_contact_details and artist_payout_details get NOTHING. Not to anon,
-- not to authenticated. This is the line the product promise rests on.
