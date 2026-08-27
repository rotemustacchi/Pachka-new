-- Artworks: listings, the closed taxonomy, inventory, declarations, lifecycle.
--
-- Owner: artworks
--
-- Two tables, `artworks` and `artwork_images` (ARCHITECTURE.md, "Database
-- schema -- table ownership"). Four things in here are load-bearing for other
-- modules and are written down rather than assumed.
--
-- A1. AVAILABILITY IS NOT A COLUMN. ARCHITECTURE.md: "Availability is derived,
-- never stored. stock - active_reservations - sold. Any counter column for
-- availability is a defect." So there is no `available`, no `remaining`, and no
-- `sold_count` below. `stock` is the artist's DECLARED edition size -- a stated
-- fact that changes only when the artist edits the listing -- and everything
-- else is derived at read time from data the `orders` module owns.
--
-- The artwork-listings spec says an edition is "decremented on each sale". That
-- is the observable, not the mechanism: with stock fixed at 10 and one sale,
-- the derived remaining quantity is 9, which is what the spec's scenario
-- asserts. Deriving satisfies both documents; a counter would satisfy only one.
--
-- A2. `status = 'sold'` IS A LIFECYCLE STATE, NOT A COUNTER. The spec requires
-- exactly five states and `sold` is one of them, so it is stored. It is
-- recomputed from derived availability by artworks.reconcileAvailability(),
-- never incremented. A cancelled order that returns a unit moves an edition
-- back out of `sold` on its own.
--
-- A3. THE ROW LOCK LIVES HERE. SECURITY.md S0-4 fixes the order of operations
-- for reservation: lock the artwork row first (`select ... from artworks where
-- id = $1 for update`), then derive availability, then insert. `orders` takes
-- that lock on this table. Nothing here may make the artwork row cheap to skip
-- locking -- which is the other reason there is no counter to update instead.
--
-- A4. anon SELECT IS PREDICATED ON `status = 'published'`. SECURITY.md S0-1
-- item 3: without that predicate, drafts, `unlisted` and -- worst -- `removed`
-- artworks are readable straight off the PostgREST data API at
-- /rest/v1/artworks with nothing but the anon key, which makes admin takedown
-- nominal. The predicate also tests that the artist is not suspended, because
-- SECURITY.md S1-13 item 3 requires suspension to withdraw artworks as a
-- DERIVED condition rather than by bulk-updating rows: lifting a suspension has
-- to restore the previous state "excluding any individually removed"
-- (moderation-admin), and a bulk update destroys the information needed to do
-- that.

-- ---------------------------------------------------------------------------
-- 0. A private schema for the policy helpers
-- ---------------------------------------------------------------------------
--
-- Same reasoning as the accounts migration: a policy expression is evaluated as
-- the querying role, so these must be EXECUTE-able by anon and authenticated;
-- putting them in `public` would also publish each one as a PostgREST RPC at
-- /rest/v1/rpc/<name>. PostgREST exposes only `public`, so their own schema
-- keeps them reachable from policies and off the data API.

create schema if not exists artworks;
comment on schema artworks is
  'Policy helpers for the artworks module. Deliberately not a PostgREST-exposed schema.';

grant usage on schema artworks to anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 1. The closed taxonomy
-- ---------------------------------------------------------------------------
--
-- artwork-listings, "Artwork taxonomy": "The taxonomy SHALL be a closed,
-- server-defined set; artists SHALL NOT introduce new values."
--
-- This matters beyond tidiness. The matchmaker's scoring function ranks on
-- taxonomy overlap, so a free-text axis would let one artist invent a value
-- nobody filters on -- or, per SECURITY.md S2-20, let a vision-model response
-- steered by text painted into the image introduce one. The set is stated three
-- times on purpose: here as a check constraint (the backstop no code path can
-- get around), in src/modules/artworks/taxonomy.ts (what the application
-- validates against and renders), and in a test that reads pg_constraint and
-- asserts the two agree exactly. Drift fails the suite rather than shipping.
--
-- Values are stable machine keys, never Hebrew display strings: the display
-- name is a translation and translations get edited.
--
-- Stored as text with a check rather than as an enum type deliberately. An
-- enum's `alter type ... add value` cannot run inside a transaction block on
-- every supported server, and the migration runner applies each file in one.

create table artworks (
  id                uuid        primary key default gen_random_uuid(),

  -- Random, not sequential. SECURITY.md S3-29: sequential identifiers make
  -- authorization the only defence against enumeration, and a draft's id
  -- leaking the size of the catalog is a free business-intelligence feed.
  --
  -- The reference is to artist_profiles rather than profiles: only an account
  -- that completed the artist upgrade can hold a listing, and that is a
  -- constraint worth having the database enforce rather than only the server.
  artist_id         uuid        not null references artist_profiles (user_id),

  -- artwork-listings, "Listing lifecycle": exactly one of five states.
  status            text        not null default 'draft'
                                check (status in ('draft', 'published', 'sold', 'unlisted', 'removed')),

  -- ---- Specification fields (artwork-listings, "Mandatory specification
  -- fields"). Nullable at rest because a draft is allowed to be incomplete;
  -- the publish-time check constraint at the bottom of this table is what makes
  -- them mandatory, and the application lists every missing one at once.
  title             text        check (title is null or length(btrim(title)) between 2 and 120),
  description       text        check (description is null or length(description) <= 4000),

  -- Money is an integer count of agorot in a bigint column (ARCHITECTURE.md).
  -- Never numeric, never a float, never a decimal string.
  price_agorot      bigint      check (price_agorot is null or price_agorot >= 0),

  -- Dimensions are stored as whole MILLIMETRES and presented in centimetres.
  -- The spec states the unit as centimetres, which is a presentation decision;
  -- storing an exact integer keeps a 28.5 cm vase from becoming a float, and
  -- gives `shipping` an exact size to band into a tier. See dimensions.ts.
  height_mm         integer     check (height_mm is null or height_mm between 1 and 100000),
  width_mm          integer     check (width_mm  is null or width_mm  between 1 and 100000),
  -- Depth is required only where the medium is three-dimensional; see the
  -- publish check and MEDIA_REQUIRING_DEPTH in taxonomy.ts.
  depth_mm          integer     check (depth_mm  is null or depth_mm  between 1 and 100000),

  weight_grams      integer     check (weight_grams is null or weight_grams between 1 and 500000),
  materials         text        check (materials is null or length(btrim(materials)) between 2 and 400),

  -- Tri-state on purpose. NULL means "not applicable" -- a ring is neither
  -- framed nor unframed -- and the publish check requires a real answer only
  -- for wall-mounted media. "Unanswered" for an applicable medium is caught in
  -- the application, which can say which field is missing.
  is_framed         boolean,

  -- artwork-listings: "dispatch lead time in business days".
  lead_time_days    integer     check (lead_time_days is null or lead_time_days between 0 and 365),

  -- Rendered on the detail page in the approved design (design/Artwork.dc.html,
  -- "שנת יצירה"). Not required to publish -- the spec's mandatory list does not
  -- include it.
  year_created      integer     check (year_created is null or year_created between 1900 and 2200),

  -- ---- Taxonomy. One medium; one or more styles; one or more moods; zero or
  -- more target spaces (artwork-listings, "Artwork taxonomy").
  medium            text        check (medium is null or medium in (
                                  'painting_illustration',
                                  'photography',
                                  'ceramics_objects',
                                  'jewelry',
                                  'textile_clothing'
                                )),

  styles            text[]      not null default '{}'
                                check (styles <@ array[
                                  'minimalist', 'abstract', 'boho_coastal',
                                  'modern_industrial', 'pop_art'
                                ]::text[]),

  target_spaces     text[]      not null default '{}'
                                check (target_spaces <@ array[
                                  'living_room', 'bedroom', 'office_clinic',
                                  'childrens_room', 'kitchen'
                                ]::text[]),

  moods             text[]      not null default '{}'
                                check (moods <@ array[
                                  'calm', 'bold', 'romantic', 'edgy'
                                ]::text[]),

  -- ---- Inventory (artwork-listings, "Unique pieces and editions").
  --
  -- `stock` is the DECLARED edition size, not a live count. See A1 in the
  -- header. A unique piece is pinned to exactly 1 by the check below, so
  -- "once sold, never purchasable again" cannot be undone by an edit.
  inventory_type    text        not null default 'unique'
                                check (inventory_type in ('unique', 'edition')),
  stock             integer     not null default 1 check (stock >= 1),

  made_to_order     boolean     not null default false,
  production_lead_time_days integer
                                check (production_lead_time_days is null
                                       or production_lead_time_days between 0 and 365),

  -- ---- Declarations (artwork-listings, "Originality declaration" and
  -- "AI-assistance disclosure").
  --
  -- The originality declaration records WHO affirmed it and WHEN, which the
  -- spec requires explicitly. It is deliberately three columns rather than a
  -- boolean: a boolean records that someone ticked a box, and the spec asks for
  -- an attributable, timestamped affirmation that survives the artist editing
  -- the listing afterwards.
  originality_declared_by uuid  references profiles (user_id),
  originality_declared_at timestamptz,

  -- Tri-state, and the third state is the point. NULL means the artist has not
  -- ANSWERED the AI question, which the spec makes a publication blocker in its
  -- own right -- distinct from answering "no". A boolean defaulting to false
  -- would silently answer it for them.
  ai_assisted       boolean,

  published_at      timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),

  -- A unique piece has a fixed quantity of exactly 1 (artwork-listings).
  constraint artworks_unique_has_stock_one
    check (inventory_type <> 'unique' or stock = 1),

  -- The two made-to-order rules -- that only an edition can be made to order,
  -- and that a made-to-order piece states its production lead time -- are NOT
  -- table-wide constraints. They live in the publish gate below instead.
  --
  -- The reason is that a draft is allowed to be incomplete and allowed to be
  -- momentarily incoherent. The upload form autosaves step by step, so an
  -- artist who ticks "made to order" before switching the inventory type to
  -- edition, or before typing the production lead time, would otherwise get a
  -- raw check-constraint violation mid-keystroke on a field they were about to
  -- fill in. Completeness and coherence are publish-time questions, asked once,
  -- with every unmet requirement named at the same time.

  -- The originality declaration is who-and-when together or neither. This one
  -- IS table-wide: it is not a completeness rule but an integrity rule -- an
  -- affirmation with a timestamp and no account, or an account and no
  -- timestamp, is not a partially-filled form, it is a corrupt record.

  constraint artworks_originality_is_attributed
    check ((originality_declared_by is null) = (originality_declared_at is null)),

  -- Sanity bounds on the multi-select axes. The per-axis maximum an artist may
  -- actually pick is configurable and enforced in the application
  -- (SECURITY.md S2-20 item 2, "cap the shape"); these are the absolute
  -- ceilings, equal to the size of each closed set, so a duplicate-stuffed
  -- array cannot get past the database either.
  constraint artworks_axis_cardinality
    check (cardinality(styles) <= 5
       and cardinality(target_spaces) <= 5
       and cardinality(moods) <= 4),

  -- ---- The publish gate, as a constraint.
  --
  -- This is the backstop, not the user-facing check. The application refuses a
  -- publish and names EVERY missing field in one response (artwork-listings:
  -- "blocks publication and lists every missing field"), which a check
  -- constraint cannot do. What this guarantees is the thing worth guaranteeing:
  -- no row anywhere in this table is in `published` or `sold` while incomplete,
  -- whatever code path put it there -- including a future admin script, a
  -- backfill, or a bug.
  --
  -- `sold` is included because a sold artwork is a published one that ran out;
  -- it still renders a full detail page to a buyer who owns it.
  constraint artworks_published_is_complete check (
    status not in ('published', 'sold')
    or (
          title             is not null
      and description       is not null
      and price_agorot      is not null
      and height_mm         is not null
      and width_mm          is not null
      and weight_grams      is not null
      and materials         is not null
      and lead_time_days    is not null
      and medium            is not null
      and cardinality(styles) >= 1
      and cardinality(moods)  >= 1
      -- Depth only where the medium is three-dimensional.
      and (medium not in ('ceramics_objects', 'jewelry') or depth_mm is not null)
      -- Framing answered for wall-mounted media.
      and (medium not in ('painting_illustration', 'photography') or is_framed is not null)
      -- Made to order: only an edition can be, and it states its lead time.
      and (not made_to_order or inventory_type = 'edition')
      and (not made_to_order or production_lead_time_days is not null)
      -- Both declarations made. NULL ai_assisted is "not answered".
      and originality_declared_by is not null
      and originality_declared_at is not null
      and ai_assisted             is not null
      and published_at            is not null
    )
  )
);

comment on table artworks is
  'Artwork listings. No availability counter by design -- availability is derived as stock - active_reservations - sold (ARCHITECTURE.md).';
comment on column artworks.stock is
  'DECLARED edition size, not a live count. Available units are derived; see src/modules/artworks/inventory.ts.';
comment on column artworks.price_agorot is
  'Integer agorot. Read through shared/money fromDbValue(); never Number() directly -- bigint arrives as a string.';
comment on column artworks.ai_assisted is
  'Tri-state: true, false, or NULL for "the artist has not answered", which blocks publication.';

create table artwork_images (
  id             uuid        primary key default gen_random_uuid(),
  artwork_id     uuid        not null references artworks (id) on delete cascade,

  -- Server-generated object keys of the form ${artworkId}/${uuid}.${ext}
  -- (SECURITY.md S2-24 item 2). This table records where the bytes are; the
  -- `uploads` module owns putting them there and proving they came from the
  -- pipeline. `original_path` is retained but never served.
  original_path  text        not null check (length(btrim(original_path)) between 1 and 500),
  display_path   text        check (display_path   is null or length(btrim(display_path))   between 1 and 500),
  thumbnail_path text        check (thumbnail_path is null or length(btrim(thumbnail_path)) between 1 and 500),

  -- Untrusted text: it is artist-supplied and rendered. Contact-scanned by the
  -- application before it lands (SECURITY.md S2-19), never interpolated as HTML.
  alt_text       text        check (alt_text is null or length(alt_text) <= 300),

  width_px       integer     check (width_px  is null or width_px  > 0),
  height_px      integer     check (height_px is null or height_px > 0),

  -- Position 0 is the primary image. `uploads` recomputes the embedding only
  -- when the primary image changes (upload-pipeline), so which row holds
  -- position 0 is a cross-module signal, not a display detail.
  position       integer     not null default 0 check (position between 0 and 49),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),

  constraint artwork_images_one_row_per_position unique (artwork_id, position)
);

comment on table artwork_images is
  'Images belonging to an artwork. Position 0 is primary. Owned by artworks; written only through the artworks module API (ARCHITECTURE.md: no module writes another module''s tables).';

create trigger artworks_set_updated_at
  before update on artworks
  for each row execute function public.set_updated_at();
create trigger artwork_images_set_updated_at
  before update on artwork_images
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- 2. Indexes
-- ---------------------------------------------------------------------------
--
-- The catalog and the matchmaker read published rows and nothing else, so the
-- partial index carries only those and stays small however many drafts pile up.

create index artworks_published_recent_idx
  on artworks (published_at desc)
  where status = 'published';

create index artworks_published_price_idx
  on artworks (price_agorot)
  where status = 'published';

create index artworks_published_medium_idx
  on artworks (medium)
  where status = 'published';

-- The artist dashboard lists everything the artist owns, in every state.
create index artworks_artist_idx on artworks (artist_id, created_at desc);

-- Filtering by style / space / mood is a containment test on an array.
create index artworks_styles_idx        on artworks using gin (styles);
create index artworks_target_spaces_idx on artworks using gin (target_spaces);
create index artworks_moods_idx         on artworks using gin (moods);

create index artwork_images_artwork_idx on artwork_images (artwork_id, position);

-- ---------------------------------------------------------------------------
-- 3. Policy helpers
-- ---------------------------------------------------------------------------
--
-- SECURITY DEFINER with a pinned empty search_path and fully-qualified names
-- (SECURITY.md S0-2 item 2). Owned by the migration role, which carries
-- BYPASSRLS -- that is what lets artwork_images' policy ask about an artwork
-- without re-entering the artworks policy for the calling role.

create function artworks.is_publicly_visible(artwork uuid) returns boolean
language sql stable security definer
set search_path = ''
as $fn$
  select exists (
    select 1 from public.artworks a
    where a.id = artwork
      and a.status = 'published'
      and not accounts.account_is_suspended(a.artist_id)
  )
$fn$;

comment on function artworks.is_publicly_visible(uuid) is
  'The public-visibility predicate: published AND the artist is not suspended. Suspension withdraws artworks as a derived condition, never by bulk update (SECURITY.md S1-13 item 3).';

create function artworks.is_owned_by(artwork uuid, account uuid) returns boolean
language sql stable security definer
set search_path = ''
as $fn$
  select exists (
    select 1 from public.artworks a where a.id = artwork and a.artist_id = account
  )
$fn$;

revoke all on function
  artworks.is_publicly_visible(uuid),
  artworks.is_owned_by(uuid, uuid)
from public;

grant execute on function
  artworks.is_publicly_visible(uuid),
  artworks.is_owned_by(uuid, uuid)
to anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 4. Row-level security
-- ---------------------------------------------------------------------------
--
-- ENABLE and FORCE on both tables. Without FORCE the table owner -- the role
-- migrations run as -- reads straight past its own policies, which quietly
-- makes integration tests pass that should fail (SECURITY.md S0-1 item 5).
--
-- There is deliberately NO INSERT, UPDATE or DELETE policy for `authenticated`
-- on either table, and this is a stronger statement here than it was for
-- accounts. Every rule the artwork-listings spec asks for -- the closed
-- taxonomy, the complete specification, both declarations, the lifecycle edges,
-- the reserved-artwork block -- is enforced on the server write path. A data-API
-- UPDATE would be a path to `status = 'published'` that runs none of them: an
-- artist could publish an untitled, undeclared artwork with one PATCH against
-- /rest/v1/artworks from the browser console. The check constraints above would
-- catch the incomplete row, but not the closed-set cap, not the lifecycle edge,
-- and not the reservation block. So the data API is read-only here, full stop.

alter table artworks       enable row level security;
alter table artworks       force  row level security;
alter table artwork_images enable row level security;
alter table artwork_images force  row level security;

-- The predicate SECURITY.md S0-1 item 3 requires. Drafts, unlisted and removed
-- artworks are not readable by anyone but their artist and an admin.
create policy artworks_public_read on artworks
  for select to anon, authenticated
  using (status = 'published' and not accounts.account_is_suspended(artist_id));

create policy artworks_artist_read on artworks
  for select to authenticated
  using (artist_id = auth.uid() or accounts.auth_is_admin());

create policy artwork_images_public_read on artwork_images
  for select to anon, authenticated
  using (artworks.is_publicly_visible(artwork_id));

create policy artwork_images_artist_read on artwork_images
  for select to authenticated
  using (artworks.is_owned_by(artwork_id, auth.uid()) or accounts.auth_is_admin());

-- ---------------------------------------------------------------------------
-- 5. Grants
-- ---------------------------------------------------------------------------
--
-- Supabase ships ALTER DEFAULT PRIVILEGES granting table privileges to anon and
-- authenticated in `public`, so a new table can arrive already exposed. State
-- every grant explicitly and revoke first (SECURITY.md S0-1 item 2).

revoke all on artworks       from anon, authenticated;
revoke all on artwork_images from anon, authenticated;

grant select on artworks       to anon, authenticated;
grant select on artwork_images to anon, authenticated;

-- No INSERT, UPDATE or DELETE to anon or authenticated on either table. Writes
-- go through the server connection, which is the only path that runs the
-- publish validation and the lifecycle state machine.
