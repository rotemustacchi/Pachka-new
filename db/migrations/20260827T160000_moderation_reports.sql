-- Moderation: public reports, and the counters that stop them being a flood.
--
-- Owner: moderation
--
-- The MVP publishes artwork with no human review beforehand, so moderation is
-- reactive: anyone can report a listing, and the operator acts. That makes the
-- report endpoint one of exactly two places an anonymous stranger can write to
-- this database, which is why so much of this file is about refusing them.
--
-- THREE DECISIONS WORTH ARGUING WITH
--
-- 1. The report count is DERIVED, never stored.
--    The spec wants repeated reports on one subject grouped "into a single
--    admin queue item showing the report count", and separately wants flooding
--    refused without "the report count already recorded" being inflated. A
--    counter column satisfies the first and quietly breaks the second: every
--    path that refuses a report has to remember not to increment, and the one
--    that forgets is invisible until an artist is taken down over a number that
--    was never real. `count(*)` over the rows that exist cannot drift from the
--    rows that exist. ARCHITECTURE.md makes the same call for availability, for
--    the same reason.
--
-- 2. `anon` and `authenticated` get NO insert grant, which is stricter than
--    SECURITY.md's RLS matrix ("anon INSERT, rate-limited").
--    Rate limiting is a server-side control: it counts prior attempts in
--    another table and decides. A row-level security policy cannot do that, so
--    an anon INSERT grant on the data API is, precisely, the flood the spec
--    requires be refused -- with the policy waving it through. Reports
--    therefore go through the server, which is the only path that also hashes
--    the reporter, counts the window, and notifies the operator. The accounts
--    migration made this same call for the same reason and wrote it down; this
--    is that precedent, applied where it matters more.
--
-- 3. A report's substance is immutable once filed.
--    An admin may resolve a report. An admin may not edit what it says. The
--    difference matters because a takedown is justified by the report, and a
--    reason that can be rewritten after the fact justifies nothing. Enforced by
--    a trigger, not by which columns the application happens to name in its
--    UPDATE -- the same argument as SECURITY.md S1-14 makes for the audit log,
--    one notch down in severity.

-- ---------------------------------------------------------------------------
-- 1. Reports
-- ---------------------------------------------------------------------------

create table reports (
  id            uuid        primary key default gen_random_uuid(),

  -- A report is filed against an artwork or against an artist profile. Both are
  -- real foreign keys: a report pointing at nothing is a queue item an operator
  -- cannot action, and the database is the only thing that can promise it never
  -- happens. `artworks` is owned by the artworks module and `artist_profiles`
  -- by accounts; ARCHITECTURE.md permits foreign keys across module boundaries
  -- and forbids only writes.
  subject_type  text        not null check (subject_type in ('artwork', 'artist')),
  artwork_id    uuid        references artworks (id),
  artist_id     uuid        references artist_profiles (user_id),

  -- Derived so that grouping, indexing and the queue never have to care which
  -- of the two columns is populated, and so the answer cannot disagree with the
  -- foreign keys it is derived from.
  subject_id    uuid        generated always as (coalesce(artwork_id, artist_id)) stored,

  -- moderation-admin, "Public reporting": a reason from a fixed set. Closed,
  -- server-side, and enumerated here as well as in TypeScript so that a report
  -- carrying a reason nobody can render is impossible rather than merely
  -- unlikely.
  reason        text        not null check (reason in (
                              'not_original_work',
                              'mass_produced',
                              'undeclared_ai',
                              'offensive_content',
                              'misleading_listing',
                              'other'
                            )),
  -- Optional free text. Bounded, because it is written by an anonymous stranger.
  details       text        check (details is null or length(details) <= 2000),

  -- Null for an anonymous visitor, which is the common case and the one the
  -- spec names first.
  reporter_id   uuid        references profiles (user_id),

  -- A salted hash of whatever identified the client, never the client itself.
  -- SECURITY.md's log-redaction rule puts raw client IPs on the never-stored
  -- list, and S3-30 names "hashed reporter IPs" as a data class this system
  -- holds. Unhashed, this column would make the reports table a list of every
  -- address that has ever objected to a listing -- which is exactly the list an
  -- artist with a grudge would want.
  reporter_fingerprint text  not null check (length(reporter_fingerprint) = 64),

  status        text        not null default 'open'
                            check (status in ('open', 'dismissed', 'actioned')),

  -- Resolution. All three together or none of them; see the check below and the
  -- update policy, which say the same thing to two different audiences.
  resolved_by      uuid,
  resolved_at      timestamptz,
  resolution_note  text     check (resolution_note is null or length(resolution_note) <= 2000),

  -- The operator notification. Recorded on the row rather than only logged,
  -- because "the report is still recorded and the failure is logged" is a spec
  -- scenario, and a log line is not something a test can assert against or an
  -- operator can query for "which reports did we never hear about".
  notified_at         timestamptz,
  notification_error  text   check (notification_error is null or length(notification_error) <= 500),

  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),

  -- Exactly one subject, and it agrees with subject_type.
  constraint reports_subject_matches_type check (
    (subject_type = 'artwork' and artwork_id is not null and artist_id is null)
    or
    (subject_type = 'artist'  and artist_id  is not null and artwork_id is null)
  ),

  -- A resolved report says who, when, and why. An audit trail with a blank
  -- reason is how "we took this down because someone complained" becomes
  -- unanswerable six months later.
  constraint reports_resolution_is_complete check (
    (status = 'open'
      and resolved_by is null and resolved_at is null and resolution_note is null)
    or
    (status in ('dismissed', 'actioned')
      and resolved_by is not null and resolved_at is not null
      and length(btrim(resolution_note)) > 0)
  )
);

comment on table reports is
  'Public reports against an artwork or an artist. Filed through the server only; the count per subject is derived, never stored.';
comment on column reports.reporter_fingerprint is
  'Salted SHA-256 of the client identifier. Never the raw IP (SECURITY.md log redaction, S3-30).';
comment on column reports.subject_id is
  'Derived from the two foreign keys so grouping cannot disagree with them.';

-- The queue reads open reports grouped by subject, newest first. Partial,
-- because a resolved report is never grouped again and the open set stays small
-- even when the table does not.
create index reports_open_subject_idx on reports (subject_type, subject_id)
  where status = 'open';
create index reports_created_at_idx on reports (created_at desc);
create index reports_subject_idx on reports (subject_type, subject_id);

create trigger reports_set_updated_at
  before update on reports
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- 2. What a report says cannot be edited after it is filed
-- ---------------------------------------------------------------------------
--
-- An admin resolves a report; an admin does not rewrite it. A takedown is
-- justified by the report that prompted it, so a reason that can be edited
-- afterwards justifies nothing. Only the resolution and notification columns
-- are writable, and this says so in the one place that cannot be bypassed by
-- writing a different UPDATE statement somewhere else.

create function moderation.reports_substance_is_immutable() returns trigger
language plpgsql
set search_path = ''
as $fn$
begin
  if new.subject_type          is distinct from old.subject_type
     or new.artwork_id         is distinct from old.artwork_id
     or new.artist_id          is distinct from old.artist_id
     or new.reason             is distinct from old.reason
     or new.details            is distinct from old.details
     or new.reporter_id        is distinct from old.reporter_id
     or new.reporter_fingerprint is distinct from old.reporter_fingerprint
     or new.created_at         is distinct from old.created_at then
    raise exception
      'reports: what a report says is fixed when it is filed; only its resolution and notification may change'
      using errcode = 'restrict_violation',
            hint = 'Resolve the report, or file a new one. Do not edit the original.';
  end if;
  return new;
end
$fn$;

create trigger reports_substance_is_immutable
  before update on reports
  for each row execute function moderation.reports_substance_is_immutable();

-- ---------------------------------------------------------------------------
-- 3. Rate-limit counters
-- ---------------------------------------------------------------------------
--
-- Its own table rather than the one `accounts` uses: that table belongs to the
-- accounts module and its bucket set is the auth surface. No module writes
-- another module's tables.
--
-- Counted in Postgres, not in memory, for the reason the accounts limiter
-- records: the application runs as serverless functions with no shared memory
-- between invocations, so an in-process counter resets on almost every request
-- and limits nothing at all.
--
-- Subjects are hashed here too. Unhashed, this becomes the same directory of
-- client addresses that hashing `reports.reporter_fingerprint` was meant to
-- avoid, sitting one table over.

create table moderation_rate_limit_events (
  id          bigint      generated always as identity primary key,
  bucket      text        not null check (bucket in ('report')),
  subject     text        not null check (length(subject) = 64),
  occurred_at timestamptz not null default now()
);

comment on table moderation_rate_limit_events is
  'Attempt counters for the anonymous reporting surface. Recorded whether or not the attempt is allowed, and outside the report transaction, so a refusal still counts.';

create index moderation_rate_limit_events_lookup_idx
  on moderation_rate_limit_events (bucket, subject, occurred_at desc);

-- ---------------------------------------------------------------------------
-- 4. Row-level security, read and WRITE
-- ---------------------------------------------------------------------------
--
-- ARCHITECTURE.md, "Every table needs write policies, not just read policies":
-- a table with FORCE RLS and only `for select` policies permits no writes
-- except by a role that bypasses RLS, which makes correctness depend on a
-- deployment setting and fails in production while tests stay green. Every
-- role's write side is stated below, and where a role has none, that is said in
-- words rather than left as silence.

alter table reports enable row level security;
alter table reports force  row level security;
alter table moderation_rate_limit_events enable row level security;
alter table moderation_rate_limit_events force  row level security;

-- SELECT, admin only. SECURITY.md's matrix is explicit that this is not merely
-- "not public": "Artists must not read reports against them." An artist who can
-- read their own reports can correlate the timing against their own visitor
-- logs, and an anonymous reporter stops being anonymous.
create policy reports_admin_read on reports
  for select to authenticated
  using (accounts.auth_is_admin());

-- SELECT and the writes, service_role: the only real path.
--
-- `using (true)` here, and SECURITY.md's cross-cutting rule says no policy uses
-- it "except on rows that are genuinely public to the internet". The exception
-- taken is deliberate and narrow: this policy is scoped `to service_role`, a
-- role that is server-only by construction and bypasses RLS in production
-- anyway. Any narrower predicate would be theatre -- it would restate a
-- decision the server has already made in code, and a reader would have to
-- check both. The rule exists to stop `using (true)` reaching anon or
-- authenticated, and neither appears on this table at all.
create policy reports_server_read on reports
  for select to service_role
  using (true);

-- INSERT: a new report is always open, always unresolved, and always carries a
-- fingerprint. The `with check` restates the resolution invariant at the moment
-- of writing rather than trusting the caller to have got it right.
create policy reports_server_insert on reports
  for insert to service_role
  with check (
    status = 'open'
    and resolved_by is null and resolved_at is null and resolution_note is null
    and length(reporter_fingerprint) = 64
  );

-- UPDATE: only an OPEN report may be written to, which is what makes resolution
-- one-way -- a dismissed report cannot be quietly re-dismissed with a different
-- note, and a closed one cannot be reopened to change its outcome. The `with
-- check` is the resolution invariant again, on the row as it will be.
create policy reports_server_resolve on reports
  for update to service_role
  using (status = 'open')
  with check (
    (status = 'open' and resolved_by is null and resolved_at is null)
    or
    (status in ('dismissed', 'actioned')
      and resolved_by is not null and resolved_at is not null
      and length(btrim(resolution_note)) > 0)
  );

-- DELETE: NO POLICY, FOR ANY ROLE, INTENTIONALLY.
--
-- A report is evidence for a takedown or a suspension, and deleting one makes
-- the action it justified unauditable. Data-retention erasure (SECURITY.md
-- S3-30) is a separate, documented path that tokenises the personal columns and
-- keeps the row; it is not this, and it is not built yet.

-- anon and authenticated: NO WRITE POLICY OF ANY KIND, INTENTIONALLY.
--
-- See decision 2 in the header. An anon INSERT grant on the data API would be
-- the flood the spec requires be refused, arriving on a path where nothing
-- counts it. Reports are filed through the server.

-- The counters are server-only in both directions. `delete` is a real
-- requirement, not a courtesy: `pruneRateLimitEvents` sweeps expired rows, and
-- without a delete policy that sweep silently does nothing the moment the
-- connection role stops bypassing RLS.
create policy moderation_rate_limit_events_server_read on moderation_rate_limit_events
  for select to service_role
  using (true);

create policy moderation_rate_limit_events_server_insert on moderation_rate_limit_events
  for insert to service_role
  with check (length(subject) = 64);

create policy moderation_rate_limit_events_server_prune on moderation_rate_limit_events
  for delete to service_role
  using (occurred_at < now());

-- No UPDATE policy: a counter row is a fact about a moment. It is written once
-- and swept, never amended.
--
-- No policy of any kind for anon or authenticated: these rows say which hashed
-- clients have been reporting how often, which is nobody's business but the
-- server's. Not even an admin reads them through the data API; the queue shows
-- reports, not reporters.

-- ---------------------------------------------------------------------------
-- 5. Grants
-- ---------------------------------------------------------------------------
--
-- Supabase ships ALTER DEFAULT PRIVILEGES granting table privileges to anon and
-- authenticated in `public`, so a new table can arrive already exposed. Both
-- revokes are stated explicitly rather than left to the default.

revoke all on reports from public;
revoke all on reports from anon, authenticated;
revoke all on moderation_rate_limit_events from public;
revoke all on moderation_rate_limit_events from anon, authenticated;

-- Admins read the queue. Nobody else reads anything, and nobody writes.
grant select on reports to authenticated;

grant select, insert, update on reports to service_role;
grant select, insert, delete on moderation_rate_limit_events to service_role;
