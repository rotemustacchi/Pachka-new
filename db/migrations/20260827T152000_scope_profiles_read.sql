-- Scope the public read on `profiles` to accounts that are actually public.
--
-- Owner: accounts
--
-- 20260827T140000 gave `profiles` a `using (true)` select policy for anon and
-- authenticated, on the reasoning that every column on the table is public by
-- construction -- display name, avatar, city, and nothing else. That reasoning
-- is sound about the columns and wrong about the rows.
--
-- `GET /rest/v1/profiles?select=*` with the anon key then returns a directory of
-- every registered account on PACHKA: display name and city for buyers who have
-- never listed anything, never bought anything and never left a review, and who
-- have no public presence on the platform at all. It also makes the size of the
-- user base, and its growth rate, a single request away. SECURITY.md permits
-- `using (true)` only "on rows that are genuinely public to the internet", and
-- a buyer's row is not one of them.
--
-- Two categories of account genuinely are public, and they are the only two:
--
--   1. An artist with something published who is not suspended -- their profile
--      page exists and is meant to be found.
--   2. The author of a published review, because that review is displayed with
--      their display name next to it. Hiding the row would render the review as
--      an anonymous one, which is not what the spec asks for
--      ("Reviews SHALL be attributed to the buyer's display name").
--
-- Everyone else reads their own row and nothing more.

create function accounts.profile_is_publicly_visible(account uuid) returns boolean
language sql stable security definer
set search_path = ''
as $fn$
  select accounts.artist_is_publicly_visible(account)
      or exists (
        select 1
          from public.reviews r
         where r.buyer_id = account
           and r.published
           and accounts.artist_is_publicly_visible(r.artist_id)
      )
$fn$;

comment on function accounts.profile_is_publicly_visible(uuid) is
  'An account is public if it is a visible artist, or authored a review displayed on one. Nothing else exposes a display name to a stranger.';

revoke all on function accounts.profile_is_publicly_visible(uuid) from public;
grant execute on function accounts.profile_is_publicly_visible(uuid)
  to anon, authenticated, service_role;

-- Replacing a permissive policy with a narrower one. Not the destructive schema
-- change the forward-only convention guards against: no column and no table is
-- removed, and the replacement is installed in the same transaction.
drop policy if exists profiles_public_read on profiles;

create policy profiles_public_read on profiles
  for select to anon, authenticated
  using (accounts.profile_is_publicly_visible(user_id));

-- Self and admin, separately, so that a buyer with no public presence can still
-- read their own row -- which the narrowed policy above would otherwise refuse.
create policy profiles_self_read on profiles
  for select to authenticated
  using (user_id = auth.uid() or accounts.auth_is_admin());
