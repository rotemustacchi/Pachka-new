-- Accounts: the artist upgrade, and rate limits on the anonymous auth surface.
--
-- Owner: accounts
--
-- Two things that have to exist before registration and the upgrade flow can be
-- written safely.
--
-- 1. The artist upgrade. SECURITY.md S0-2 item 3 requires that the upgrade be a
--    server-side SECURITY DEFINER function which hard-codes the literal
--    'artist', so that there is no code path anywhere that inserts a role value
--    taken from a request. A buyer who POSTs {"role":"admin"} to a legitimately
--    public endpoint must get the artist role and nothing else. Hard-coding it
--    in the function rather than in the caller means a bug in the caller cannot
--    reach a different role either.
--
-- 2. Rate limits. SECURITY.md's cross-cutting table requires them on
--    registration, sign-in, password reset and the artist upgrade -- credential
--    stuffing and address enumeration on the first three, bulk fake-artist
--    creation on the last. SPEC-J records that not one of the ten specs
--    mentions rate limiting at all, on a free tier with open registration.

-- ---------------------------------------------------------------------------
-- 1. The artist upgrade
-- ---------------------------------------------------------------------------

create function accounts.grant_artist_role(account uuid) returns void
language sql security definer
set search_path = ''
as $fn$
  insert into public.user_roles (user_id, role)
  values (account, 'artist')
  on conflict (user_id, role) do nothing
$fn$;

comment on function accounts.grant_artist_role(uuid) is
  'The only way the artist role is granted. The literal is in here, not in the caller, so no request value can reach it (SECURITY.md S0-2 item 3).';

-- Callable only by the privileged server connection. `authenticated` invoking
-- this directly through PostgREST would be an unauthenticated self-upgrade --
-- and it is not in an exposed schema anyway, so this is belt and braces.
revoke all on function accounts.grant_artist_role(uuid) from public;

-- ---------------------------------------------------------------------------
-- 2. Rate-limit events
-- ---------------------------------------------------------------------------
--
-- One row per attempt, counted over a window. A table rather than an in-memory
-- counter because the application runs as serverless functions with no shared
-- memory between invocations, so an in-process limiter would reset constantly
-- and limit nothing.
--
-- `subject` holds a SHA-256 hash, never a raw value. SECURITY.md's log
-- redaction rule puts raw client IPs on the never-stored list and requires them
-- hashed, and the same argument applies to the email addresses counted here:
-- this table would otherwise become a list of every address that has ever tried
-- to register.

create table auth_rate_limit_events (
  id          bigserial   primary key,
  -- Which limit this attempt counts against: registration, signin, and so on.
  bucket      text        not null check (length(bucket) between 1 and 40),
  -- SHA-256 of the IP or address being limited. Never the value itself.
  subject     text        not null check (subject ~ '^[0-9a-f]{64}$'),
  occurred_at timestamptz not null default now()
);

comment on table auth_rate_limit_events is
  'Attempt counters for the anonymous auth surface. Subjects are hashed, never stored raw (SECURITY.md, log redaction).';

create index auth_rate_limit_events_lookup
  on auth_rate_limit_events (bucket, subject, occurred_at desc);

alter table auth_rate_limit_events enable row level security;
alter table auth_rate_limit_events force  row level security;

-- Server-only. Nobody reads or writes this through the data API: a client that
-- could delete rows here could lift its own rate limit, and a client that could
-- read it could confirm whether an address has been tried.
create policy auth_rate_limit_events_admin_read on auth_rate_limit_events
  for select to authenticated
  using (accounts.auth_is_admin());

revoke all on auth_rate_limit_events from anon, authenticated;
revoke all on sequence auth_rate_limit_events_id_seq from anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3. Configuration
-- ---------------------------------------------------------------------------
--
-- ARCHITECTURE.md: every configurable number lives in app_config. The limits
-- below are deliberately generous -- they exist to stop scripted abuse, not to
-- inconvenience someone who mistyped a password twice. The numbers are the lead
-- architect's to tune; what this migration fixes is that the limits exist.

insert into app_config (key, value, value_type, description, is_public) values
  ('accounts.min_password_length', '10', 'integer',
   'Minimum password length at registration. Length is the only strength rule: composition rules push people towards Passw0rd! and away from passphrases.', true),

  ('accounts.registration_window_minutes', '60', 'integer',
   'Window over which registration attempts are counted, per IP and per address.', false),
  ('accounts.registration_max_per_window', '5', 'integer',
   'Registration attempts permitted per window. Open self-service registration is a bulk-account-creation surface (SECURITY.md, rate limit table).', false),

  ('accounts.signin_window_minutes', '15', 'integer',
   'Window over which sign-in attempts are counted, per IP and per address.', false),
  ('accounts.signin_max_per_window', '10', 'integer',
   'Sign-in attempts permitted per window. Guards credential stuffing.', false),

  ('accounts.password_reset_window_minutes', '60', 'integer',
   'Window over which password-reset requests are counted.', false),
  ('accounts.password_reset_max_per_window', '3', 'integer',
   'Password-reset requests permitted per window. Also an outbound mail cap.', false),

  ('accounts.artist_upgrade_window_minutes', '1440', 'integer',
   'Window over which artist-upgrade attempts are counted, per account.', false),
  ('accounts.artist_upgrade_max_per_window', '3', 'integer',
   'Artist-upgrade attempts permitted per window. Guards bulk fake-artist creation.', false)
on conflict (key) do nothing;

alter table app_config add constraint app_config_accounts_bounds check (
  case key
    -- Below ten characters is not a password policy, it is a formality.
    when 'accounts.min_password_length'          then value::numeric between 10 and 128
    when 'accounts.registration_window_minutes'  then value::numeric between 1 and 1440
    when 'accounts.registration_max_per_window'  then value::numeric between 1 and 1000
    when 'accounts.signin_window_minutes'        then value::numeric between 1 and 1440
    when 'accounts.signin_max_per_window'        then value::numeric between 1 and 1000
    when 'accounts.password_reset_window_minutes' then value::numeric between 1 and 1440
    when 'accounts.password_reset_max_per_window' then value::numeric between 1 and 1000
    when 'accounts.artist_upgrade_window_minutes' then value::numeric between 1 and 43200
    when 'accounts.artist_upgrade_max_per_window' then value::numeric between 1 and 1000
    else true
  end
);
