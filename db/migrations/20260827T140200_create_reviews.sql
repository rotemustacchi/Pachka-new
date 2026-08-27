-- Reviews: one per completed order, public on the artist's profile.
--
-- Owner: accounts
--
-- accounts-and-profiles, "Buyers may review artists only after a completed
-- purchase": one review per completed order, a 1-5 star rating and optional
-- text, attributed to the buyer's display name and publicly visible.
--
-- Three decisions worth explaining.
--
-- 1. UNIQUE (order_id, artist_id), not UNIQUE (order_id).
--    The spec says "one review per completed order" and separately requires
--    that an order spanning several artists splits into a fulfilment per artist
--    (checkout-orders). Keyed on the order alone, a buyer who ordered from two
--    artists could review only one of them. Keyed on the pair, they review each
--    artist once. For the single-artist order -- the ordinary case -- the two
--    readings are identical, which is presumably why the spec did not
--    distinguish them. Raised in the accounts README.
--
-- 2. `published`, maintained server-side, rather than a join to returns.
--    SECURITY.md S2-24 item 4 requires that a review whose order later completes
--    a return is hidden from the public profile and RETAINED for admin review.
--    The `returns` table belongs to the shipping module, and no module reads
--    another module's tables from inside an RLS policy that anonymous visitors
--    hit on every profile page. So shipping calls the accounts public API when a
--    return completes, and this column is what that call sets. Hidden, not
--    deleted: the row stays for an operator to look at.
--
-- 3. No INSERT or UPDATE policy for `authenticated`.
--    Eligibility -- "a delivered order from that artist, and only one review for
--    it" -- spans the orders module's tables. Expressing that in a policy would
--    put orders' schema inside accounts' RLS; expressing it server-side keeps it
--    in one typed, testable place. `authenticated` therefore gets no write path
--    at all, which is stricter than SECURITY.md's policy matrix rather than
--    looser: the matrix permits a self-INSERT under a predicate, and this
--    permits none.

create table reviews (
  id              uuid        primary key default gen_random_uuid(),
  -- The order this review is attached to. Owned by the orders module, which
  -- does not exist yet, so there is no foreign key to it. Adding one later is
  -- an additive migration and belongs to whoever ships that table.
  order_id        uuid        not null,
  artist_id       uuid        not null references profiles (user_id),
  buyer_id        uuid        not null references profiles (user_id),
  rating          smallint    not null check (rating between 1 and 5),
  body            text        not null default '' check (length(body) <= 2000),
  -- False once the order completes a return. The row survives (SECURITY.md
  -- S2-24 item 4).
  published       boolean     not null default true,
  scanner_version integer     not null default 1,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),

  constraint reviews_one_per_order_and_artist unique (order_id, artist_id),
  -- An artist reviewing themselves is the cheapest possible five-star review.
  -- The real defence is that orders refuses a checkout on your own artwork
  -- (SECURITY.md S2-24 item 1); this is the backstop for when that is bypassed.
  constraint reviews_not_self check (artist_id <> buyer_id)
);

comment on table reviews is
  'One review per completed order per artist. Hidden but retained when the order is returned (SECURITY.md S2-24).';

create index reviews_artist_published on reviews (artist_id) where published;
create index reviews_buyer on reviews (buyer_id);

create trigger reviews_set_updated_at
  before update on reviews
  for each row execute function public.set_updated_at();

alter table reviews enable row level security;
alter table reviews force  row level security;

-- Public, like the profile they appear on. A review of an artist who is
-- suspended or has nothing published is not shown, for the same reason that
-- artist's profile page returns not-found.
create policy reviews_public_read on reviews
  for select to anon, authenticated
  using (published and accounts.artist_is_publicly_visible(artist_id));

-- A buyer always sees their own review, including one hidden by a return --
-- otherwise it silently vanishes and they write it again.
create policy reviews_own_read on reviews
  for select to authenticated
  using (buyer_id = auth.uid() or accounts.auth_is_admin());

revoke all on reviews from anon, authenticated;
grant select on reviews to anon, authenticated;
