-- Moderation: the append-only admin audit log.
--
-- Owner: moderation
--
-- SECURITY.md S1-14 is the whole reason this file is long. Its finding is that
-- "the application only ever calls INSERT" is a coding style, not a control:
-- the application holds the service-role key, which bypasses RLS, so anyone who
-- can run application code edits history. The audit log exists precisely for the
-- case where the admin -- or someone holding the admin's credentials -- did
-- something they want hidden. A log the attacker can edit answers no question.
--
-- Four properties, each enforced by a different mechanism, because each one
-- fails to a different attacker:
--
--   1. Grants.   UPDATE/DELETE (and TRUNCATE, via `revoke all`) are revoked
--                from PUBLIC, anon and authenticated. Stops anyone reaching the
--                table through the PostgREST data API.
--   2. Trigger.  A BEFORE UPDATE OR DELETE trigger raises unconditionally, so a
--                connection that holds the privileges anyway -- the service
--                role, the owner -- fails loudly instead of silently rewriting.
--   3. Coupling. The row is written in the same transaction as the action it
--                records (enforced in `modules/moderation`, proved by test).
--   4. Chain.    Every row stores the hash of the one before it. This is the
--                property that survives 1 and 2 being defeated outright: a
--                superuser can disable a trigger, but cannot alter or remove a
--                row without breaking the chain at a detectable position.
--
-- Actor and timestamp are stamped by the trigger from the session, never from a
-- column supplied by the caller. Whatever a caller puts in `actor` or `at` is
-- overwritten before the row lands. See the trigger body.
--
-- KNOWN DEVIATION, reported rather than worked around: SECURITY.md asks for
-- `REVOKE UPDATE, DELETE, TRUNCATE` and item 2 is written as one trigger. The
-- repository's own migration linter (`lintMigrations`, proved by
-- tests/unit/migration-convention.test.ts) rejects any migration whose body
-- contains the word TRUNCATE, so neither the explicit grant list nor a
-- BEFORE TRUNCATE trigger can be written here. `revoke all` removes the
-- TRUNCATE privilege along with everything else, which covers every role that
-- is not the table owner or a superuser; for those two, detection falls to the
-- hash chain, which is where it would fall anyway.

-- ---------------------------------------------------------------------------
-- 0. A private schema, off the data API
-- ---------------------------------------------------------------------------
--
-- Same reasoning as `accounts`: PostgREST publishes every function in `public`
-- as an RPC endpoint at /rest/v1/rpc/<name>. The audit writer and the chain
-- verifier are not endpoints.

create schema if not exists moderation;
comment on schema moderation is
  'Audit writer, chain verifier, and policy helpers for the moderation module. Deliberately not a PostgREST-exposed schema.';

grant usage on schema moderation to anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 1. The table
-- ---------------------------------------------------------------------------

create table admin_audit (
  -- The chain order. A gapless identity is not required for correctness -- the
  -- chain links by hash, not by number -- but it gives the verifier a stable
  -- position to report and makes "the tip" a single cheap read.
  seq         bigint      generated always as identity primary key,
  -- A public handle for the entry, so a queue item or an email can link to one
  -- without leaking how many admin actions have ever been taken.
  id          uuid        not null default gen_random_uuid() unique,

  -- Stamped by the trigger from auth.uid(). NOT from a parameter: S1-14's
  -- second failure mode is "the audit row records an actor taken from the
  -- caller, so the caller writes whatever actor they like".
  actor       uuid        not null,
  at          timestamptz not null,

  -- The six actions SECURITY.md S1-14 enumerates, plus the two SPEC-K and
  -- S1-16 add. A closed set, because an audit log with a free-text verb cannot
  -- be queried for "every takedown". Adding an action means a new migration.
  action      text        not null check (action in (
                            'artwork_takedown',
                            'account_suspension',
                            'account_reinstatement',
                            'report_resolution',
                            'commission_change',
                            'config_change',
                            'rate_table_change',
                            'payout_settlement',
                            'payout_details_access'
                          )),

  target_type text        not null check (target_type in (
                            'artwork', 'account', 'report', 'config', 'shipping_rate', 'payout'
                          )),
  -- Text rather than uuid: a config change targets a key, not a row id.
  target_id   text        not null check (length(btrim(target_id)) between 1 and 200),

  -- Bounded, and the bound is load-bearing for the atomicity test: an
  -- over-long note makes the audit insert fail, which must take the action it
  -- was recording down with it.
  note        text        not null default '' check (length(note) <= 2000),
  details     jsonb       not null default '{}'::jsonb,

  prev_hash   bytea       not null,
  row_hash    bytea       not null
);

comment on table admin_audit is
  'Append-only record of every admin action. Grants revoked, trigger-enforced, hash-chained (SECURITY.md S1-14).';
comment on column admin_audit.actor is
  'Stamped from auth.uid() by the chain trigger. A value supplied by the caller is discarded.';
comment on column admin_audit.row_hash is
  'sha256(prev_hash || canonical payload). Breaks if the row is altered; the next row breaks if this one is removed.';

create index admin_audit_at_idx on admin_audit (at desc);
create index admin_audit_target_idx on admin_audit (target_type, target_id);

-- Deliberately NO set_updated_at trigger. There is no updated_at, because
-- nothing is ever updated.

-- ---------------------------------------------------------------------------
-- 2. The canonical payload
-- ---------------------------------------------------------------------------
--
-- What gets hashed. Two properties matter and both are easy to lose:
--
--   * Determinism. `to_jsonb(timestamptz)` renders in the SESSION's TimeZone,
--     so the same row would hash differently for a verifier running in Asia and
--     one running in UTC. The timestamp is therefore formatted explicitly in
--     UTC to microsecond precision -- which is exactly what the column stores.
--   * Canonical form. jsonb, not json: jsonb normalises key order and
--     whitespace on the way in, so two logically identical payloads always
--     produce the same text.
--
-- Every field a reader would rely on is covered. `prev_hash` is covered too,
-- which is what makes the links tamper-evident rather than merely present.

create function moderation.audit_payload(
  p_prev_hash   bytea,
  p_actor       uuid,
  p_at          timestamptz,
  p_action      text,
  p_target_type text,
  p_target_id   text,
  p_note        text,
  p_details     jsonb
) returns bytea
language sql immutable
set search_path = ''
as $fn$
  select convert_to(
    (jsonb_build_object(
      'prev',        encode(p_prev_hash, 'hex'),
      'actor',       p_actor::text,
      'at',          to_char(p_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
      'action',      p_action,
      'target_type', p_target_type,
      'target_id',   p_target_id,
      'note',        p_note,
      'details',     p_details
    ))::text,
    'utf8'
  )
$fn$;

comment on function moderation.audit_payload(bytea, uuid, timestamptz, text, text, text, text, jsonb) is
  'The exact bytes that get hashed. Used by both the insert trigger and the verifier, so the two cannot drift apart.';

-- The anchor. A chain has to start somewhere, and starting it at NULL would
-- make "row one has no predecessor" indistinguishable from "everything before
-- row one was deleted".
create function moderation.audit_genesis_hash() returns bytea
language sql immutable
set search_path = ''
as $fn$
  select sha256(convert_to('pachka:admin_audit:genesis:v1', 'utf8'))
$fn$;

-- ---------------------------------------------------------------------------
-- 3. Append: stamp the actor, stamp the time, link the chain
-- ---------------------------------------------------------------------------

create function moderation.admin_audit_chain() returns trigger
language plpgsql security definer
set search_path = ''
as $fn$
declare
  tip       bytea;
  stamped_actor uuid;
  stamped_at    timestamptz;
begin
  -- Serialise appends. Two concurrent inserts that both read the same tip would
  -- produce two rows claiming the same predecessor, which reads exactly like
  -- tampering. A transaction-scoped advisory lock on a fixed key is released at
  -- commit or rollback with no cleanup path to forget.
  perform pg_advisory_xact_lock(7213904471553218301);

  -- The actor comes from the session, never from the row. On the data API path
  -- this is the verified JWT `sub`; on the server path the moderation module
  -- publishes the same setting from the session it has already authorised,
  -- inside the same transaction. Either way the caller cannot name someone else
  -- as the actor, because whatever they put in the column is discarded here.
  stamped_actor := auth.uid();
  stamped_at    := now();

  if stamped_actor is null then
    raise exception
      'admin_audit: refusing an entry with no acting identity in the session'
      using errcode = 'raise_exception',
            hint = 'Admin actions run inside moderation.withAdminAction(), which publishes the acting admin into request.jwt.claim.sub.';
  end if;

  new.actor := stamped_actor;
  new.at    := stamped_at;

  select a.row_hash into tip from public.admin_audit a order by a.seq desc limit 1;
  new.prev_hash := coalesce(tip, moderation.audit_genesis_hash());

  new.row_hash := sha256(
    new.prev_hash ||
    moderation.audit_payload(
      new.prev_hash, new.actor, new.at, new.action,
      new.target_type, new.target_id, new.note, new.details
    )
  );

  return new;
end
$fn$;

create trigger admin_audit_chain
  before insert on admin_audit
  for each row execute function moderation.admin_audit_chain();

-- ---------------------------------------------------------------------------
-- 4. Refuse every update and every delete
-- ---------------------------------------------------------------------------
--
-- The grants below already stop anon and authenticated. This stops the roles
-- the grants cannot: the service role, which carries BYPASSRLS and is what the
-- application itself connects as, and the table owner. A privileged connection
-- fails loudly here rather than quietly rewriting history.

create function moderation.admin_audit_immutable() returns trigger
language plpgsql
set search_path = ''
as $fn$
begin
  raise exception
    'admin_audit is append-only: % on entry seq=% is refused', tg_op, old.seq
    using errcode = 'restrict_violation',
          hint = 'Audit entries are never corrected. Record a new entry describing the correction.';
end
$fn$;

create trigger admin_audit_append_only
  before update or delete on admin_audit
  for each row execute function moderation.admin_audit_immutable();

-- ---------------------------------------------------------------------------
-- 5. The verifier
-- ---------------------------------------------------------------------------
--
-- What makes the chain worth having. Run it on a schedule and alert on a break;
-- run it after an incident to find out whether history was edited.
--
-- Two distinguishable breaks:
--
--   * `link_broken`   -- this row's prev_hash is not the previous row's
--                        row_hash. That is what a DELETED predecessor looks
--                        like, and it is reported at the first row that no
--                        longer links, which is the row after the gap.
--   * `row_altered`   -- this row's stored row_hash is not what its own
--                        contents hash to. That is an in-place edit.
--
-- Reports the FIRST break, with its seq, because after a break every later
-- position is meaningless and a list of thousands is not more useful than one.
--
-- One attack a self-contained chain cannot catch on its own: removing entries
-- from the END, where no later row is left to fail to link. Nothing inside the
-- table can distinguish "the log stops here" from "the log was cut here. The
-- answer is a checkpoint held OUTSIDE the table -- a row_hash the operator, the
-- alerting job, or an off-site copy recorded earlier. Pass it in and the
-- verifier asserts it is still present:
--
--   * `checkpoint_missing` -- an entry known to have existed is gone. Reported
--                             with no seq, because the row that would have
--                             carried it is what is missing.
--
-- Callers with no checkpoint get the walk alone, which is still the whole of
-- the alteration and mid-log deletion story.

create type moderation.audit_chain_result as (
  ok         boolean,
  broken_seq bigint,
  reason     text
);

create function moderation.verify_audit_chain(p_checkpoint bytea default null)
returns moderation.audit_chain_result
language plpgsql stable security definer
set search_path = ''
as $fn$
declare
  entry    public.admin_audit%rowtype;
  expected bytea;
  prev     bytea := moderation.audit_genesis_hash();
  result   moderation.audit_chain_result;
begin
  for entry in select * from public.admin_audit order by seq loop
    if entry.prev_hash is distinct from prev then
      result := (false, entry.seq, 'link_broken');
      return result;
    end if;

    expected := sha256(
      entry.prev_hash ||
      moderation.audit_payload(
        entry.prev_hash, entry.actor, entry.at, entry.action,
        entry.target_type, entry.target_id, entry.note, entry.details
      )
    );

    if entry.row_hash is distinct from expected then
      result := (false, entry.seq, 'row_altered');
      return result;
    end if;

    prev := entry.row_hash;
  end loop;

  if p_checkpoint is not null
     and not exists (select 1 from public.admin_audit a where a.row_hash = p_checkpoint) then
    result := (false, null, 'checkpoint_missing');
    return result;
  end if;

  result := (true, null, null);
  return result;
end
$fn$;

comment on function moderation.verify_audit_chain(bytea) is
  'Walks the chain and reports the first break. A deleted entry surfaces as link_broken at the following seq; an edited entry as row_altered at its own seq; a checkpoint that is no longer present as checkpoint_missing, which is the only way to catch entries cut from the end.';

-- ---------------------------------------------------------------------------
-- 6. Row-level security and grants
-- ---------------------------------------------------------------------------
--
-- Matrix (SECURITY.md, "Cross-cutting: the RLS policy matrix"):
--   admin_audit | anon SELECT: none | authenticated SELECT: admin only
--               | INSERT only, revoked UPDATE/DELETE, plus trigger and hash chain

alter table admin_audit enable row level security;
alter table admin_audit force  row level security;

create policy admin_audit_admin_read on admin_audit
  for select to authenticated
  using (accounts.auth_is_admin());

-- ARCHITECTURE.md, "Every table needs write policies, not just read policies":
-- a table with FORCE RLS and only SELECT policies permits no writes except by a
-- role that bypasses RLS, which makes correctness depend on a deployment
-- setting rather than on the schema. So the write side is stated explicitly
-- here, for each role that has one -- and the absence of the other two is
-- stated in words, since silence would read as an omission.
--
-- INSERT, service_role: the real path. Every audit entry is written by server
-- code inside the action's own transaction, and `withAdminAction` publishes the
-- acting admin into the session first. `auth.uid() is not null` is exactly the
-- rule the chain trigger enforces, restated as a policy so it holds even if the
-- connection role loses BYPASSRLS.
create policy admin_audit_server_insert on admin_audit
  for insert to service_role
  with check (auth.uid() is not null);

-- INSERT, authenticated: unreachable, and deliberately kept. There is no INSERT
-- grant behind it (see below), so nothing on the data API path can use it.
-- S1-14 item 1 asks for an insert policy, and it states the intent where a
-- reader will look for it: if a future migration restored the grant by mistake,
-- a non-admin still could not append.
create policy admin_audit_admin_insert on admin_audit
  for insert to authenticated
  with check (accounts.auth_is_admin());

-- UPDATE and DELETE: NO POLICY, FOR ANY ROLE, INTENTIONALLY.
--
-- This is the "if a table genuinely takes no writes from an application role,
-- say so" case, and it is the whole point of the table. Nothing in PACHKA
-- updates or deletes an audit entry -- not the application, not an admin, not a
-- migration. Not a restrictive policy, not a permissive one that always denies:
-- none at all, so there is no expression for a later change to "just widen".
-- The revoked grants and the append-only trigger below say the same thing twice
-- more, to the roles that RLS would not reach.
--
-- An entry recorded in error is corrected by recording a second entry that
-- describes the correction. That is what an append-only log is.

-- Supabase ships ALTER DEFAULT PRIVILEGES that grant table privileges to anon
-- and authenticated in `public`, so a new table can arrive already exposed.
-- `revoke all` is stated first and explicitly, and it takes TRUNCATE with it.
revoke all on admin_audit from public;
revoke all on admin_audit from anon, authenticated;

-- Read only, and only what the policy above allows through. No INSERT grant:
-- appending is a server-side operation, and the data API is not on that path.
grant select on admin_audit to authenticated;

-- The server path. SELECT for the queue and the chain verifier, INSERT for the
-- writer, and nothing else -- so a service-role connection that is somehow
-- turned against the log still cannot rewrite it.
grant select, insert on admin_audit to service_role;

-- anon gets nothing at all.

grant execute on function moderation.verify_audit_chain(bytea) to service_role;
revoke all on function moderation.verify_audit_chain(bytea) from public;
revoke all on function moderation.audit_payload(bytea, uuid, timestamptz, text, text, text, text, jsonb) from public;
revoke all on function moderation.audit_genesis_hash() from public;
