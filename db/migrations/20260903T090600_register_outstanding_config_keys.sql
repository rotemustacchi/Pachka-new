-- The eleven configurable numbers that were still literals in module code.
--
-- Owner: shared
--
-- Forward-only and additive: see db/README.md. No down migration exists.
--
-- ARCHITECTURE.md: "Every configurable number lives in `app_config`, read
-- through `shared/config`... No magic numbers in module code." Three modules
-- were carrying values that belong here, each marked `TODO(config)` with a
-- note that `shared/config/registry.ts` is another team's file. They were right
-- not to edit it unilaterally, and right to keep each value stated exactly once
-- so that registering it would be a change in one place: `artworks/limits.ts`,
-- `shipping/config.ts` and `moderation/rate-limit.ts`.
--
-- This migration and the matching registry entries land together, because
-- `registry.test.ts` asserts the registry has exactly one entry per key seeded
-- here -- neither more nor fewer. Either half alone fails that test, which is
-- the point of it.

insert into app_config (key, value, value_type, description, is_public) values
  -- Artworks: how much of the taxonomy one listing may claim.
  --
  -- SECURITY.md S2-20 item 2, "cap the shape". Claiming every style and every
  -- target space maximises taxonomy overlap in the matchmaker's scoring
  -- function, which ranks the artwork into every result set. The cap defuses
  -- that whether the values came from an artist gaming the form or from a
  -- vision model steered by text painted into the image.
  --
  -- Distinct from the cardinality check constraints in the artworks migration:
  -- those are absolute ceilings equal to the size of each closed set, and these
  -- are how many an artist MAY pick. Public, because the form has to tell the
  -- artist the limit before they hit it rather than after.
  ('artworks.max_styles', '3', 'integer',
   'Most styles one artwork may claim. SECURITY.md S2-20 item 2.', true),
  ('artworks.max_target_spaces', '3', 'integer',
   'Most target spaces one artwork may claim. SECURITY.md S2-20 item 2.', true),
  ('artworks.max_moods', '2', 'integer',
   'Most moods one artwork may claim. SECURITY.md S2-20 item 2.', true),

  ('artworks.max_description_length', '4000', 'integer',
   'Longest stored description. Matches the check constraint on the column; lowering this value tightens the form without a deployment, raising it above the constraint does not.', true),
  ('artworks.max_images_per_artwork', '8', 'integer',
   'Most images one artwork may carry. Position is 0-based, so the last is this minus one.', true),
  ('artworks.max_edition_size', '250', 'integer',
   'Largest edition an artist may declare. Not an aesthetic judgement: stock is the number of units one row can put on hold, and an unbounded edition is an unbounded reservation fan-out for orders to sweep.', true),

  -- Shipping: the PACHKA-operated return address.
  --
  -- Every return is sent here and every outbound parcel carries it as its
  -- return address, because a return address printed on the label would
  -- otherwise disclose the artist on the first sale (shipping-and-returns,
  -- "Returns route through a PACHKA return address"; SECURITY.md SPEC-A).
  --
  -- PLACEHOLDER. The PO box below is not a real address and must be replaced
  -- before launch. It is here rather than in code precisely so that replacing
  -- it is an operator action when the box moves, not a deployment. Not public:
  -- it reaches a buyer on return instructions, through the module, and does not
  -- need to be readable by every visitor holding the anon key.
  ('shipping.pachka_return_address',
   '{"recipient": "PACHKA", "line1": "PLACEHOLDER PO BOX", "city": "Tel Aviv-Yafo", "postalCode": "6100000", "countryCode": "IL"}',
   'json',
   'The PACHKA-operated return address. PLACEHOLDER — replace before launch. Every return routes through it so that no artist address is printed on a shipping label.', false),

  -- Returns: the artist's response window.
  --
  -- SECURITY.md SPEC-E: artist silence must not hold a buyer money. In this
  -- module design the refund has already been released by the operator intact
  -- receipt before forwarding happens, so this window governs the artist damage
  -- claim against PACHKA rather than the buyer refund. It still needs a
  -- deadline, or a claim stays open forever.
  ('returns.artist_response_window_days', '7', 'integer',
   'Days an artist has to confirm or dispute a forwarded return before the case escalates to an admin.', false),

  -- Whether a refund gives back the outbound shipping the buyer paid.
  --
  -- UNDECIDED. This is a question about Israeli distance-selling law, not an
  -- engineering preference, and false is the conservative reading (the buyer
  -- bears return shipping and the outbound leg was performed). It sits here so
  -- that the answer, when there is one, is an operator change rather than a
  -- release. Public: a buyer is entitled to know what a refund covers before
  -- they request one.
  ('returns.refund_includes_outbound_shipping', 'false', 'boolean',
   'Whether a refund returns the outbound shipping the buyer paid. UNDECIDED — a question about Israeli distance-selling law, not an engineering preference.', true),

  -- Moderation: the anonymous reporting surface.
  --
  -- moderation-admin requires that reports beyond the configured rate limit are
  -- refused. SPEC-J records that no spec mentions rate limiting at all; these
  -- are deliberately generous, since they exist to stop scripted abuse rather
  -- than to inconvenience someone reporting two things in an evening.
  ('moderation.report_window_minutes', '60', 'integer',
   'Window over which report attempts are counted, per hashed client fingerprint.', false),
  ('moderation.report_max_per_window', '10', 'integer',
   'Report attempts permitted per window. Counted whether or not the attempt is allowed, so a refusal still consumes its slot.', false)
on conflict (key) do nothing;

-- ---------------------------------------------------------------------------
-- Bounds
-- ---------------------------------------------------------------------------
--
-- A new named constraint rather than an edit to an existing one: applied
-- migrations are immutable, and each of the three constraints on this table now
-- covers the keys its own migration introduced.
--
-- What these are for is narrower than it looks. They do not stop a wrong value;
-- they stop a value that could hurt someone. A taxonomy cap of zero means no
-- artist can classify anything and the matchmaker has nothing to score on; a
-- cap equal to the size of the closed set is the abuse S2-20 describes, with
-- the cap switched off. An edition size in the millions is an unbounded
-- reservation fan-out. A report limit of zero silently closes the reporting
-- surface, which is the one an abuse victim reaches for.
--
-- `shipping.pachka_return_address` is unbounded here: it is a json document,
-- and its shape is validated where it is read, by the code that has to know
-- what a postal address is.

alter table app_config add constraint app_config_module_limits_bounds check (
  case key
    -- Taxonomy caps. At least one, and never the whole closed set.
    when 'artworks.max_styles'                     then value::numeric between 1 and 10
    when 'artworks.max_target_spaces'              then value::numeric between 1 and 10
    when 'artworks.max_moods'                      then value::numeric between 1 and 10

    -- A description shorter than a sentence is not a listing; longer than the
    -- column's own check constraint would be a limit that never takes effect.
    when 'artworks.max_description_length'         then value::numeric between 200 and 4000
    when 'artworks.max_images_per_artwork'         then value::numeric between 1 and 20
    when 'artworks.max_edition_size'               then value::numeric between 1 and 10000

    -- Returns. Zero days is no window at all; ninety is well past any
    -- reasonable reading of a response deadline.
    when 'returns.artist_response_window_days'     then value::numeric between 1 and 90

    -- Reporting. Zero permitted reports closes the surface entirely.
    when 'moderation.report_window_minutes'        then value::numeric between 1 and 1440
    when 'moderation.report_max_per_window'        then value::numeric between 1 and 1000

    else true
  end
);
