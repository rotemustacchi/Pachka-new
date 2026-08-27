-- Bootstrap: make a plain PostgreSQL behave enough like Supabase that the same
-- migrations, and the same row-level security policies, run in both places.
--
-- Owner: shared
--
-- Why this exists. ARCHITECTURE.md makes RLS mandatory on every table, and the
-- test policy makes integration tests run on real PostgreSQL. Those two rules
-- only hold together if the roles and helper functions the policies reference
-- exist in the test database too. Everything below is created only when absent,
-- so on a real Supabase project this migration is a no-op and never shadows
-- Supabase's own definitions.

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin noinherit bypassrls;
  end if;
end
$$;

create schema if not exists auth;

-- auth.uid() / auth.role(): Supabase reads the verified JWT claims that
-- PostgREST puts into the session. The shim reads the same GUCs, so a policy
-- written against it behaves identically under test, where a test sets the GUC
-- itself to act as a given user.
do $$
begin
  if not exists (
    select 1 from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'auth' and p.proname = 'uid'
  ) then
    execute $fn$
      create function auth.uid() returns uuid
      language sql stable
      as $body$
        select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
      $body$;
    $fn$;
  end if;

  if not exists (
    select 1 from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'auth' and p.proname = 'role'
  ) then
    execute $fn$
      create function auth.role() returns text
      language sql stable
      as $body$
        select coalesce(nullif(current_setting('request.jwt.claim.role', true), ''), 'anon')
      $body$;
    $fn$;
  end if;
end
$$;

grant usage on schema auth to anon, authenticated, service_role;
grant usage on schema public to anon, authenticated, service_role;

-- Shared trigger function: keeps an `updated_at` column honest without every
-- module reimplementing it. Modules attach it; nobody edits it.
create or replace function public.set_updated_at() returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end
$$;
