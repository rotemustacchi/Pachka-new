-- Uploads: the pipeline's event log and the artwork embedding.
--
-- Owner: uploads
--
-- Forward-only and additive: see db/README.md. No down migration exists.
--
-- ARCHITECTURE.md, "Database schema -- table ownership", gives this module
-- exactly two tables: `upload_events` and `artwork_embeddings`. It gets no
-- third, and in particular it gets no `artwork_screening_state` table, which is
-- the shape this wanted to be at first. That constraint turned out to be the
-- right one -- see U2 below.
--
-- U1. THE EXTENSION LANDS HERE. db/README.md, "Not yet provisioned": pgvector
-- "is not enabled by any foundation migration because no foundation table needs
-- it. Whoever adds the first vector column also adds `create extension if not
-- exists vector` in that migration, and must confirm the extension is available
-- in the test cluster." This is that migration. A stock PostgreSQL does not
-- ship pgvector; it has to be installed alongside the server the harness
-- starts, and alongside whatever PostgreSQL CI runs. See the report that
-- accompanied this change.
--
-- U2. PUBLICATION IS GATED ON AN EVENT, NOT ON A STATUS COLUMN.
-- upload-pipeline, "Safety screening": "No image SHALL reach a public surface
-- without a successful screening verdict: a screening failure blocks
-- publication, never merely warns." A `screened boolean` column would answer
-- that question with a value some code path has to remember to write, and
-- SECURITY.md S0-7 is precisely about an attacker who induces the path that
-- forgets. Deriving it instead -- publication is permitted only when a
-- `screening_passed` or `screening_cleared_by_admin` event exists FOR THE ROW
-- THAT IS CURRENTLY THE PRIMARY IMAGE -- means the default answer to "may this
-- publish" is no, and stays no for an image nobody has screened. Swapping in a
-- fresh primary image re-arms the gate without any code being told to.
--
-- U3. THE LOG IS APPEND-ONLY. There is no UPDATE and no DELETE policy on
-- `upload_events` for any role, deliberately: an admin clearing a blocked
-- upload appends `screening_cleared_by_admin`, it does not edit the
-- `screening_blocked` row away. SECURITY.md S1-14 makes the same argument for
-- `admin_audit`, and it applies with more force here because this log is what
-- the publication gate reads.
--
-- U4. THE EMBEDDING TABLE IS SERVER-ONLY, INCLUDING FROM THE ARTIST.
-- SECURITY.md's RLS matrix: `artwork_embeddings` is "none / none / server only"
-- with the note "Contains the AI description". The description is the model's
-- own prose about an attacker-controlled image (S2-20) and is not shown to
-- anyone until an artist has confirmed it, so anon and authenticated get no
-- grant at all -- not a policy that happens to match no rows, no grant.

-- ---------------------------------------------------------------------------
-- 1. pgvector
-- ---------------------------------------------------------------------------

create extension if not exists vector;

-- ---------------------------------------------------------------------------
-- 2. A private schema for the policy helpers
-- ---------------------------------------------------------------------------
--
-- Same reasoning as accounts and artworks: a policy expression is evaluated as
-- the querying role, so a helper must be EXECUTE-able by that role; putting it
-- in `public` would also publish it as a PostgREST RPC at /rest/v1/rpc/<name>.

create schema if not exists uploads;
comment on schema uploads is
  'Policy helpers for the uploads module. Deliberately not a PostgREST-exposed schema.';

grant usage on schema uploads to anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3. upload_events
-- ---------------------------------------------------------------------------
--
-- One row per thing the pipeline decided, in order. The closed `event` set is
-- stated here as a check constraint and again in src/modules/uploads/events.ts,
-- with an integration test asserting the two agree -- the same arrangement the
-- artworks migration uses for the taxonomy, and for the same reason: the
-- constraint is the backstop no code path can get around.

create table upload_events (
  id           uuid        primary key default gen_random_uuid(),

  -- The artwork the upload belongs to. Cascade, because an artwork row is
  -- never deleted (artworks' write-policy migration says why) and the cascade
  -- is here only so that a hypothetical hard delete cannot strand these.
  artwork_id   uuid        not null references artworks (id) on delete cascade,

  -- Denormalised from the artwork so that the artist-facing SELECT policy and
  -- the per-artist rate accounting do not have to join through a table whose
  -- own policy would then apply. A foreign key across a module boundary is
  -- permitted and expected (ARCHITECTURE.md); a write across one is not.
  artist_id    uuid        not null references artist_profiles (user_id),

  -- Null for events that precede any stored image: a rejection by the local
  -- technical gate happens before anything is written anywhere.
  image_id     uuid        references artwork_images (id) on delete cascade,

  event        text        not null check (event in (
                             'quality_rejected',
                             'derivatives_stored',
                             'screening_passed',
                             'screening_blocked',
                             'screening_unavailable',
                             'screening_cleared_by_admin',
                             'suggestions_recorded',
                             'suggestions_rejected',
                             'analysis_failed',
                             'classification_recorded',
                             'embedding_stored',
                             'embedding_failed'
                           )),

  -- Structured detail, safe to show an admin. Never rendered as HTML: it can
  -- contain the model's own words about an attacker-controlled image (S2-20).
  detail       jsonb       not null default '{}'::jsonb,

  created_at   timestamptz not null default now()
);

comment on table upload_events is
  'Append-only record of every pipeline decision. The publication gate is derived from it (see the uploads.primary_image_is_screened helper); it is not a status column.';
comment on column upload_events.image_id is
  'Null before any object exists -- a local-gate rejection happens before a byte is written, which is the point of the local gate.';

create table artwork_embeddings (
  -- One embedding per artwork, so the artwork is the key. upload-pipeline:
  -- "The system SHALL compute and store a vector embedding for each published
  -- artwork's primary image at upload time. The embedding SHALL be recomputed
  -- only when the primary image changes."
  artwork_id   uuid        primary key references artworks (id) on delete cascade,

  -- WHICH image it was computed from. This column is what makes "recomputed
  -- only when the primary image changes" checkable rather than remembered: the
  -- recompute decision compares this against the row currently at position 0,
  -- so a caller cannot get it wrong by forgetting to call something.
  image_id     uuid        not null references artwork_images (id) on delete cascade,

  -- 1024 dimensions. Not an app_config value: changing it is a schema change
  -- (the column type carries the width) and an operator editing a row must not
  -- be able to desynchronise the stored vectors from the column. The constant
  -- is stated once more in src/modules/uploads/embeddings.ts, with a test.
  embedding    vector(1024) not null,

  -- The description the vector was computed from, kept so that a model change
  -- can be re-run without a second vision call, and so an admin reviewing a
  -- flagged upload can read what the model said. Server-only: see U4.
  description  text        not null check (length(description) <= 8000),

  -- Which model produced it. A mixed-model table would rank incomparable
  -- vectors against each other.
  model        text        not null check (length(btrim(model)) between 1 and 120),

  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

comment on table artwork_embeddings is
  'The matchmaker''s ranking input, computed once per primary image at upload. ARCHITECTURE.md: no outbound AI call at query time. Server-only -- it holds the AI description (SECURITY.md RLS matrix).';

create trigger artwork_embeddings_set_updated_at
  before update on artwork_embeddings
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- 4. Indexes
-- ---------------------------------------------------------------------------

-- The publication gate reads the newest event of a given kind for one image,
-- and the admin queue reads the newest flagged events across all artworks.
create index upload_events_artwork_idx on upload_events (artwork_id, created_at desc);
create index upload_events_image_event_idx on upload_events (image_id, event);
create index upload_events_flagged_idx
  on upload_events (created_at desc)
  where event in ('screening_blocked', 'screening_unavailable', 'analysis_failed');

-- Cosine, because the ranking function is a cosine similarity (design.md) and
-- an index built for a different operator is not used by that query at all.
-- HNSW rather than IVFFlat: IVFFlat needs representative data present at build
-- time to pick its lists, and this table is empty when the migration runs.
create index artwork_embeddings_cosine_idx
  on artwork_embeddings using hnsw (embedding vector_cosine_ops);

-- ---------------------------------------------------------------------------
-- 5. Policy helpers
-- ---------------------------------------------------------------------------
--
-- SECURITY DEFINER with a pinned empty search_path and fully-qualified names
-- (SECURITY.md S0-2 item 2).

create function uploads.primary_image_is_screened(artwork uuid) returns boolean
language sql stable security definer
set search_path = ''
as $fn$
  select exists (
    select 1
      from public.artwork_images i
      join public.upload_events e on e.image_id = i.id
     where i.artwork_id = artwork
       and i.position = 0
       and e.event in ('screening_passed', 'screening_cleared_by_admin')
  )
$fn$;

comment on function uploads.primary_image_is_screened(uuid) is
  'The publication gate. False when no image exists, when the primary image has never been screened, and when screening failed and no admin has cleared it -- the default is no (upload-pipeline, "Safety screening").';

revoke all on function uploads.primary_image_is_screened(uuid) from public;
grant execute on function uploads.primary_image_is_screened(uuid)
  to anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 6. Row-level security
-- ---------------------------------------------------------------------------

alter table upload_events       enable row level security;
alter table upload_events       force  row level security;
alter table artwork_embeddings  enable row level security;
alter table artwork_embeddings  force  row level security;

-- SECURITY.md's RLS matrix: upload_events is "anon: none, authenticated: own
-- artworks only, service: server only". An artist sees the verdicts on their
-- own work -- they are told when an image is rejected and why -- and nobody
-- else does.
create policy upload_events_artist_read on upload_events
  for select to authenticated
  using (artworks.is_owned_by(artwork_id, auth.uid()) or accounts.auth_is_admin());

create policy upload_events_server_read on upload_events
  for select to service_role
  using (true);

create policy upload_events_server_insert on upload_events
  for insert to service_role
  with check (true);

-- upload_events UPDATE and DELETE: NO POLICY, FOR ANY ROLE, INTENTIONALLY.
-- The log is append-only (U3). Clearing a blocked upload appends a
-- `screening_cleared_by_admin` row; it does not edit history. An append-only
-- log whose rows can be edited by the role that writes them is a log with a
-- comment on it, which is the objection SECURITY.md S1-14 makes.

-- artwork_embeddings: server only, in every direction. No policy names anon or
-- authenticated because neither has a grant to exercise one.
create policy artwork_embeddings_server_read on artwork_embeddings
  for select to service_role
  using (true);

create policy artwork_embeddings_server_insert on artwork_embeddings
  for insert to service_role
  with check (true);

-- UPDATE exists because "recomputed when the primary image changes" replaces a
-- row in place: the artwork keeps one embedding, and the new one supersedes the
-- old rather than accumulating beside it.
create policy artwork_embeddings_server_update on artwork_embeddings
  for update to service_role
  using (true)
  with check (true);

-- artwork_embeddings DELETE: NO POLICY, FOR ANY ROLE, INTENTIONALLY.
-- Nothing removes an embedding. An artwork whose image is replaced gets its
-- vector superseded by the UPDATE above; an artwork that is taken down keeps
-- its row and is excluded from the matchmaker by the visibility predicate,
-- which is derived. A delete path would be a second way to make an artwork
-- unrankable, and the module would then have two answers to "why is this not
-- being matched" instead of one.

-- ---------------------------------------------------------------------------
-- 7. Grants
-- ---------------------------------------------------------------------------
--
-- Supabase ships ALTER DEFAULT PRIVILEGES granting table privileges to anon and
-- authenticated in `public`, so a new table can arrive already exposed. State
-- every grant explicitly and revoke first (SECURITY.md S0-1 item 2).

revoke all on upload_events      from anon, authenticated;
revoke all on artwork_embeddings from anon, authenticated;

grant select on upload_events to authenticated;
grant select, insert on upload_events to service_role;

-- Nothing for anon or authenticated on artwork_embeddings. Not a narrow grant:
-- none.
grant select, insert, update on artwork_embeddings to service_role;

-- ---------------------------------------------------------------------------
-- 8. Storage, when there is a storage schema to talk to
-- ---------------------------------------------------------------------------
--
-- SECURITY.md S1-15 item 1: "The browser never writes to the artwork bucket.
-- Bytes go to a server route or Server Action. The anon and authenticated roles
-- have no INSERT policy on storage.objects for the artwork buckets."
-- S1-9 item 2: originals live in a separate, private bucket.
--
-- The integration harness runs a plain PostgreSQL with no `storage` schema (see
-- db/README.md, "Supabase compatibility in tests"), so this block is guarded
-- the same way the bootstrap migration guards its role creation: it does the
-- work on a real Supabase project and nothing at all on the harness. The
-- application-level half of the same control -- that only bytes the pipeline
-- itself produced can be attached to an artwork -- is enforced in
-- src/modules/uploads/provenance.ts and IS tested, because it does not depend
-- on which PostgreSQL this is.

do $storage$
begin
  if to_regclass('storage.buckets') is not null then
    -- Public: display derivatives and thumbnails only. Stripped of metadata and
    -- re-encoded from decoded pixels before they get here.
    insert into storage.buckets (id, name, public)
    values ('artwork-images', 'artwork-images', true)
    on conflict (id) do nothing;

    -- Private: the retained originals, which still carry whatever EXIF the
    -- artist's camera wrote. `public = false` is the control; the naming
    -- convention is not (S1-9).
    insert into storage.buckets (id, name, public)
    values ('artwork-originals', 'artwork-originals', false)
    on conflict (id) do nothing;
  end if;

  if to_regclass('storage.objects') is not null then
    -- Read: the display bucket is world-readable, which is what a public
    -- catalog means. The originals bucket has no read policy for anyone but
    -- the server -- an admin reviewing a flagged upload gets a short-lived
    -- signed URL minted server-side, never a bucket grant.
    if not exists (
      select 1 from pg_policies
       where schemaname = 'storage' and tablename = 'objects'
         and policyname = 'artwork_images_public_read'
    ) then
      execute $p$
        create policy artwork_images_public_read on storage.objects
          for select to anon, authenticated
          using (bucket_id = 'artwork-images')
      $p$;
    end if;

    -- Write: nothing. No INSERT, UPDATE or DELETE policy is created here for
    -- anon or authenticated on either bucket, which is what makes
    -- "uploads SHALL be written only through the pipeline; direct client writes
    -- to the image store SHALL be refused" (upload-pipeline, "Image storage and
    -- delivery") a property of the deployment rather than of the client code.
    -- The server reaches storage with the service-role key, which is not
    -- subject to these policies and is server-only (ARCHITECTURE.md).
    null;
  end if;
end
$storage$;
