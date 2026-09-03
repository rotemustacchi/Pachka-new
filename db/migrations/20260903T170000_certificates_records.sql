-- ---------------------------------------------------------------------------
-- certificates — the Certificate of Authenticity, and the counter that stops
-- its identifier space being walked.
--
-- Two tables: `certificates`, one row per artwork UNIT sold and delivered, and
-- `certificate_verification_events`, the per-IP attempt counter behind the
-- public verification endpoint.
--
-- WHAT THIS DOCUMENT ACTUALLY ASSERTS
-- -----------------------------------
-- PACHKA has never seen the object. The certificate records the ARTIST'S OWN
-- DECLARATION and says so on its face; `declaration_version` pins which wording
-- was in force when the row was written, so a later revision of that text
-- cannot retroactively change what an issued certificate claimed. The
-- `ai_assisted` snapshot is part of the same declaration, not a display flag.
--
-- C1. WHY EVERY ARTWORK FACT IS SNAPSHOTTED RATHER THAN JOINED
--
-- `authenticity-certificate`: "A generated certificate SHALL NOT be
-- modifiable." A certificate that joined `artworks` for its title would change
-- wording the moment the artist edited the listing — and would break outright
-- when the artwork was later removed. Immutability of a document means the
-- CONTENT is fixed, which means the content lives here. `order_items` makes the
-- same call for the same reason (`title_snapshot`: "a receipt that changes
-- wording after the fact is not a receipt").
--
-- C2. WHY THERE IS NO BUYER NAME COLUMN — READ THIS BEFORE ADDING ONE
--
-- SECURITY.md S0-6 and SPEC-B. The spec requires the buyer's name on the
-- certificate AND requires the certificate to resolve at a public URL; together
-- those publish a purchase record naming a private individual, which in Israel
-- is a reportable personal-data incident. The resolution is that the buyer's
-- name appears ONLY on the copy rendered to the authenticated buyer.
--
-- That could have been done with a redaction step on the way out. It is done
-- instead by never storing the name: the private document reads it through
-- `orders.buyerOrder()`, which is already scoped by `buyer_id` in its WHERE
-- clause. A redaction step is one forgotten `select *` away from failing; an
-- absent column cannot leak. `buyer_id` is here because the buyer's own read
-- policy needs a subject to name — an opaque uuid, not a person's name, and it
-- is not in the public projection either.
--
-- C3. WHY VALIDITY IS NOT A COLUMN
--
-- The same requirement demands both "SHALL NOT be modifiable" and "SHALL show
-- as void after a completed return". A stored `void` flag satisfies the second
-- by violating the first. So validity is DERIVED at read time from the
-- fulfilment's current state and the return case, and nothing ever updates a
-- row in this table. SECURITY.md S0-6 item 4 asks for exactly this.
--
-- C4. THE IDENTIFIER IS THE PRIMARY KEY, AND IT IS RANDOM
--
-- SECURITY.md S0-6 item 1: 128 bits of CSPRNG output, never sequential, never
-- derived from the order id. `gen_random_uuid()` is the database's backstop;
-- the application supplies the value from `node:crypto` `randomUUID()` so the
-- unguessability property is testable without a database. A sequential id here
-- would make authorization the only defence against harvesting the platform's
-- entire sales history, and there is no authorization on a public page.
-- ---------------------------------------------------------------------------

create table certificates (
  -- The public identifier. See C4.
  id                    uuid        primary key default gen_random_uuid(),

  -- ---- What this certificate is a certificate OF.
  --
  -- Foreign keys across module boundaries are permitted and expected
  -- (ARCHITECTURE.md); writes to those tables are not, and this module performs
  -- none.
  order_id              uuid        not null references orders (id),
  fulfilment_id         uuid        not null references fulfilments (id),
  artwork_id            uuid        not null references artworks (id),
  artist_id             uuid        not null references artist_profiles (user_id),

  -- The subject of the buyer's own read policy, and nothing more. See C2.
  buyer_id              uuid        not null references profiles (user_id),

  -- ---- One certificate per artwork UNIT.
  --
  -- `authenticity-certificate`: "One certificate SHALL be generated per artwork
  -- unit sold." An order line for two units of an edition is therefore two
  -- rows, distinguished by their ordinal within that line.
  unit_ordinal          integer     not null check (unit_ordinal >= 1),

  -- ---- Edition position (`authenticity-certificate`, "Edition artwork
  -- certificate": "it states the edition position and total").
  --
  -- Nothing in `artworks` numbers individual units — `stock` is the DECLARED
  -- edition size, not a live count — so the position is assigned here, at
  -- issue, as one more than the highest already issued for this artwork. The
  -- unique constraint below is what makes that assignment a guarantee rather
  -- than a hope; the issuing transaction takes the artwork row lock first, so
  -- two concurrent deliveries of the same edition serialise instead of racing.
  --
  -- Both null for a unique piece, which is "one of a kind" and has no position.
  inventory_type        text        not null
                                    check (inventory_type in ('unique', 'edition')),
  edition_position      integer     check (edition_position is null or edition_position >= 1),
  edition_size          integer     check (edition_size is null or edition_size >= 1),

  -- ---- The snapshot. See C1.
  title                 text        not null check (length(btrim(title)) between 1 and 200),
  artist_display_name   text        not null check (length(btrim(artist_display_name)) between 1 and 120),
  medium                text        not null,
  height_mm             integer     check (height_mm is null or height_mm > 0),
  width_mm              integer     check (width_mm  is null or width_mm  > 0),
  depth_mm              integer     check (depth_mm  is null or depth_mm  > 0),
  materials             text        check (materials is null or length(materials) <= 400),
  year_created          integer     check (year_created is null or year_created between 1900 and 2200),

  -- Part of the declaration, not a display flag: where the artist declared
  -- generative AI assistance the certificate must say so
  -- (`authenticity-certificate`, "AI-assisted work"). NOT NULL because an
  -- artwork cannot be published — and therefore cannot be sold — with the
  -- question unanswered, so a null here would mean the issuing code guessed.
  ai_assisted           boolean     not null,

  -- Storage object key of the primary image, snapshotted for the same reason as
  -- the title. Nullable: an artwork can in principle reach delivery with no
  -- image row, and a certificate with no picture beats no certificate at all.
  image_path            text        check (image_path is null or length(btrim(image_path)) between 1 and 500),

  -- ---- Dates.
  --
  -- The sale date is when the order was placed; the delivery date is what made
  -- the certificate issuable. Both are copied rather than joined, per C1.
  sold_at               timestamptz not null,
  delivered_at          timestamptz not null,
  issued_at             timestamptz not null default now(),

  -- Which revision of the disclaimer wording this document was issued under.
  -- See the header: the wording is a liability boundary, so "what did this
  -- certificate say" must remain answerable after the text is next edited.
  declaration_version   text        not null check (length(btrim(declaration_version)) between 1 and 40),

  -- An edition position is stated together with the total it is out of, or not
  -- at all. "3 of" is not a position.
  constraint certificates_edition_position_has_a_total
    check ((edition_position is null) = (edition_size is null)),

  -- A unique piece is one of a kind and carries no position; an edition
  -- carries one. Stated as a constraint because the rendered wording branches
  -- on it, and a row that satisfied neither branch would render a certificate
  -- that says nothing about which object it describes.
  constraint certificates_edition_position_matches_inventory_type
    check ((inventory_type = 'edition') = (edition_position is not null)),

  constraint certificates_edition_position_within_size
    check (edition_position is null or edition_position <= edition_size),

  -- Issuance is idempotent because of this: re-running delivery confirmation,
  -- or a retry after a timeout, cannot mint a second certificate for a unit
  -- that already has one.
  constraint certificates_one_per_unit
    unique (fulfilment_id, artwork_id, unit_ordinal),

  -- No two certificates claim the same position in the same edition. This is
  -- the guarantee referred to above, and it is why the position may be assigned
  -- by a read-then-write inside a locked transaction.
  constraint certificates_one_per_edition_position
    unique (artwork_id, edition_position)
);

comment on table certificates is
  'Certificates of Authenticity, one per artwork unit delivered. Immutable: no UPDATE and no DELETE policy exists for any role. Records the artist''s declaration; PACHKA verifies nothing (authenticity-certificate).';
comment on column certificates.id is
  'The PUBLIC identifier, resolvable at /verify. Random, never sequential (SECURITY.md S0-6 item 1).';
comment on column certificates.buyer_id is
  'Subject of the buyer''s read policy. The buyer''s NAME is deliberately not stored anywhere on this row (SECURITY.md S0-6 item 3, SPEC-B).';
comment on column certificates.edition_position is
  'Assigned at issue, since artworks numbers no individual unit. Null for a unique piece.';
comment on column certificates.declaration_version is
  'Which revision of the disclaimer wording this document was issued under.';

create index certificates_order_idx      on certificates (order_id);
create index certificates_fulfilment_idx on certificates (fulfilment_id);
create index certificates_buyer_idx      on certificates (buyer_id);

-- ---------------------------------------------------------------------------
-- Immutability, enforced by the database and not only by the absence of a grant
-- ---------------------------------------------------------------------------
--
-- The grants and policies below already permit no UPDATE and no DELETE to any
-- role. This trigger is the belt to that pair of braces, and it earns its place
-- for one specific reason: in production the service role BYPASSES row-level
-- security, so on a hosted Supabase project the policies are not what stops an
-- errant UPDATE — this is. It also converts a silent no-op into a loud error
-- for the migration owner, which is the role a future backfill script runs as.

-- Its own schema, for the reason every other module gives: PostgREST publishes
-- only the schemas named in `supabase/config.toml`, so a helper in `public`
-- would also become an RPC at /rest/v1/rpc/<name>. Nothing here should be
-- callable over HTTP.
create schema if not exists certificates;
comment on schema certificates is
  'Helpers for the certificates module. Deliberately not a PostgREST-exposed schema.';

grant usage on schema certificates to service_role;

create function certificates.refuse_modification() returns trigger
language plpgsql
as $$
begin
  raise exception
    'certificates rows are immutable: a certificate records what was declared at the time of sale (authenticity-certificate). Validity is derived at read time, never written.'
    using errcode = 'restrict_violation';
end;
$$;

revoke all on function certificates.refuse_modification() from public;

-- ---------------------------------------------------------------------------
-- The verification attempt counter
-- ---------------------------------------------------------------------------
--
-- SECURITY.md's cross-cutting rate-limit table: "Certificate verification |
-- IP | Enumeration (S0-6)". Counted in Postgres rather than in memory for the
-- reason `accounts.rate-limit` gives — the application runs as serverless
-- functions with no shared memory, so an in-process counter resets on almost
-- every request and limits nothing.
--
-- Subjects are SHA-256 hashed before they are stored, so this table does not
-- become a log of every IP that has ever looked at a certificate. SECURITY.md's
-- log-redaction rule puts raw client addresses on the never-stored list.

create table certificate_verification_events (
  id          bigint      generated always as identity primary key,
  subject     text        not null check (length(subject) = 64),
  occurred_at timestamptz not null default now()
);

comment on table certificate_verification_events is
  'Per-IP attempt counter for the public verification endpoint. Recorded whether or not the attempt is allowed, and before the lookup, so a refused attempt still counts (SECURITY.md S0-6 item 5).';

create index certificate_verification_events_lookup_idx
  on certificate_verification_events (subject, occurred_at desc);

-- ---------------------------------------------------------------------------
-- Row-level security, read and WRITE
-- ---------------------------------------------------------------------------
--
-- ARCHITECTURE.md, "Every table needs write policies, not just read policies":
-- a table with FORCE RLS and only `for select` policies permits no writes
-- except by a role that bypasses RLS, which makes correctness depend on a
-- deployment setting and fails in production while tests stay green. Every
-- role's write side is stated below, and where a role has none, that is said in
-- words rather than left as silence.

alter table certificates                    enable row level security;
alter table certificates                    force  row level security;
alter table certificate_verification_events enable row level security;
alter table certificate_verification_events force  row level security;

-- ---- Grants.
--
-- anon gets NOTHING on `certificates`, and this is the load-bearing line of the
-- whole migration. SECURITY.md S0-6 item 2: with an anon SELECT policy the
-- attacker skips the verification page entirely and reads the table over the
-- data API — `GET /rest/v1/certificates?select=*` returns the platform's sales
-- history in one request, using a key that ships in the browser bundle. The
-- public page is a SERVER route holding a redacted projection, not a client
-- reading this table.
--
-- The revoke is explicit rather than assumed: on a hosted Supabase project,
-- default privileges hand new tables in `public` to anon and authenticated.

revoke all on certificates                    from public;
revoke all on certificates                    from anon, authenticated;
revoke all on certificate_verification_events from public;
revoke all on certificate_verification_events from anon, authenticated;

-- `authenticated` reads its own certificates and writes nothing. Its copy still
-- carries no buyer name — there is no such column — so even this read cannot
-- disclose one buyer to another.
grant select on certificates to authenticated;

-- The server inserts, and only inserts.
--
-- No UPDATE and no DELETE grant on `certificates` for ANY role, intentionally
-- and permanently. That is what "a generated certificate SHALL NOT be
-- modifiable" means when written as a schema rather than as a code review
-- comment. A certificate whose sale was reversed shows as void because validity
-- is derived (C3); the row is not touched, and is not deleted either — the
-- record of what was issued survives the reversal.
grant select, insert on certificates to service_role;

-- The counter needs DELETE as well: pruning expired rows is the only way the
-- table stays bounded, and a prune is not a modification of anything anyone
-- relies on.
grant select, insert, delete on certificate_verification_events to service_role;

-- ---- Policies: `certificates`.

-- The buyer of the order, and nobody else's buyer. `orders.is_order_buyer` is
-- the SECURITY DEFINER helper the orders module already publishes for exactly
-- this cross-table shape; reaching into `orders` with a plain EXISTS here would
-- re-enter that table's own policies.
create policy certificates_buyer_read on certificates
  for select to authenticated
  using (orders.is_order_buyer(order_id));

create policy certificates_admin_read on certificates
  for select to authenticated
  using (accounts.auth_is_admin());

-- The ARTIST gets no policy, intentionally. An artist has a legitimate interest
-- in knowing their work was certified, but a certificate is addressed to the
-- buyer, and `buyer_id` on a row an artist could read is a link between a
-- person and a purchase — the very association SPEC-B exists to break. If the
-- artist's studio ever needs "how many certificates were issued for this
-- piece", that is an aggregate served by the server, not a row read.

-- authenticated INSERT/UPDATE/DELETE: NO POLICY, INTENTIONALLY. A buyer who
-- could insert here would mint a certificate for an artwork nobody delivered,
-- which is precisely the forgery this document exists to make hard.

create policy certificates_server_read on certificates
  for select to service_role
  using (true);

-- `using (true)` / `with check (true)` scoped to `service_role` only. The
-- cross-cutting rule in SECURITY.md forbids `using (true)` for anon and
-- authenticated, neither of which appears on this table's write side at all.
--
-- The `with check` is not `true` in the loose sense: it restates the invariants
-- that must hold at the moment of writing, so a server-side bug cannot insert a
-- certificate against a fulfilment that has not been delivered. The database
-- says the same thing the issuing code says, which is what keeps a future
-- caller — a backfill, an admin script — from bypassing the rule by not going
-- through `issue.ts`.
create policy certificates_server_insert on certificates
  for insert to service_role
  with check (
    exists (
      select 1 from public.fulfilments f
      where f.id = fulfilment_id
        and f.order_id = order_id
        and f.status = 'delivered'
    )
  );

-- certificates UPDATE and DELETE: NO POLICY, FOR ANY ROLE, INTENTIONALLY. See
-- the grants above and C3. The trigger below says the same thing again to the
-- one identity that can get past both.

create trigger certificates_immutable
  before update or delete on certificates
  for each row execute function certificates.refuse_modification();

-- ---- Policies: `certificate_verification_events`.
--
-- Server only, all three verbs. Nothing about a rate-limit counter is anyone
-- else's business, and a client that could read it would learn how close it was
-- to the limit.

create policy certificate_verification_events_server_read on certificate_verification_events
  for select to service_role
  using (true);

create policy certificate_verification_events_server_insert on certificate_verification_events
  for insert to service_role
  with check (true);

create policy certificate_verification_events_server_prune on certificate_verification_events
  for delete to service_role
  using (true);

-- certificate_verification_events UPDATE: NO POLICY, FOR ANY ROLE,
-- INTENTIONALLY. An attempt is a fact about a moment; there is nothing to
-- amend. anon and authenticated get no policy of any kind here, and no grant.
