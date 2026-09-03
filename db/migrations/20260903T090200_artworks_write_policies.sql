-- artworks: the server's write path, and `removed` made terminal in the schema.
--
-- Owner: artworks
--
-- Forward-only and additive: see db/README.md. No down migration exists.
--
-- 20260827T151500 gave `artworks` and `artwork_images` four `for select`
-- policies and no write policy of any kind, on tables carrying FORCE ROW LEVEL
-- SECURITY. Creating a listing, editing one, publishing one and reordering its
-- images all worked only because the connection role bypassed RLS -- an
-- assumption nothing tested, because the harness connected as a superuser.
-- ARCHITECTURE.md, "Every table needs write policies, not just read policies".

-- ---------------------------------------------------------------------------
-- 1. Grants
-- ---------------------------------------------------------------------------
--
-- The existing SELECT grants to anon and authenticated stand. Nothing here
-- widens them.

grant select, insert, update on artworks       to service_role;
grant select, insert, update on artwork_images to service_role;

-- ---------------------------------------------------------------------------
-- 2. artworks
-- ---------------------------------------------------------------------------
--
-- SELECT: the server sees every artwork in every state. The public policies
-- from 20260827T151500 show `published` rows to anon and an artist their own;
-- neither covers the server, which has to read drafts to edit them and removed
-- rows to tell an artist why.
create policy artworks_server_read on artworks
  for select to service_role
  using (true);

create policy artworks_server_insert on artworks
  for insert to service_role
  with check (status <> 'removed');

-- UPDATE, and this is the one predicate in the migration that is load-bearing.
--
-- ARCHITECTURE.md: "`removed` is terminal for every role, admins included." The
-- reason is not tidiness. `moderation`'s suspension-lift restores an artist's
-- previously published artworks "excluding any individually removed", and that
-- sentence only has a stable meaning if removal is one-way. If a removed
-- artwork could return to `published`, the lift rule would have to remember
-- which artworks it had changed and why, and would get it wrong the first time
-- an artist unpublished something mid-suspension.
--
-- Until now that rule lived only in `listings.ts`, which declines to edit a
-- removed row. That is a coding style, not a control -- the same objection
-- SECURITY.md S1-14 makes about append-only audit logs. Putting `removed` out
-- of reach in the USING clause makes it a property of the schema: no UPDATE
-- through any application role can select a removed row to modify, so no code
-- path, present or future, can reinstate one. An admin who wants a removed
-- artwork back asks the artist to relist it as a new record.
--
-- The WITH CHECK is unrestricted: a takedown moves a live row TO `removed`, and
-- that transition must stay available. It is the row's prior state, not its
-- next one, that this policy constrains.
create policy artworks_server_update on artworks
  for update to service_role
  using (status <> 'removed')
  with check (true);

-- artworks DELETE: NO POLICY, FOR ANY ROLE, INTENTIONALLY.
--
-- Withdrawal is a status, not a deletion. A row must survive its own takedown:
-- `admin_audit` references the artwork a moderator acted on, orders reference
-- what was bought, and the artist is told why their listing went. Deleting the
-- row would strand all three, and would also be a way around the terminality
-- above -- remove, delete, re-create with the same details.

-- anon and authenticated: NO WRITE POLICY OF ANY KIND, INTENTIONALLY.
--
-- Publishing runs a completeness survey and, on the images, a quality and
-- safety gate. A `for update to authenticated` policy would let an artist PATCH
-- /rest/v1/artworks?id=eq.<id> with `status=published` and skip both. The
-- checks live in the module, so the write does too.

-- ---------------------------------------------------------------------------
-- 3. artwork_images
-- ---------------------------------------------------------------------------

create policy artwork_images_server_read on artwork_images
  for select to service_role
  using (true);

create policy artwork_images_server_insert on artwork_images
  for insert to service_role
  with check (true);

-- UPDATE covers reordering: making an image the cover swaps two `position`
-- values, so both rows are updated inside one transaction.
create policy artwork_images_server_update on artwork_images
  for update to service_role
  using (true)
  with check (true);

-- artwork_images DELETE: NO POLICY, FOR ANY ROLE, INTENTIONALLY, AND THIS ONE
-- IS A GAP RATHER THAN A DECISION I AM COMFORTABLE WITH.
--
-- The module has no image-removal path today -- nothing in `images.ts` deletes
-- a row -- so there is no write to authorise and a policy would be granting for
-- a caller that does not exist. But an artist who uploads the wrong photograph
-- will want it gone, and when that path is built it needs more than a DELETE
-- policy: the stored objects behind `original_path`, `display_path` and
-- `thumbnail_path` have to go with the row, and `position` has to stay dense
-- afterwards. That is a change with a design in it, not a line in this file.
-- Recorded here so the next person finds the reason rather than the silence.
