-- app_config: every number that an operator may need to change without a
-- deployment. Owner: shared (ARCHITECTURE.md, "Database schema — table ownership").
--
-- ARCHITECTURE.md: "Every configurable number lives in app_config, read through
-- shared/config. No magic numbers in module code." A module that hard-codes a
-- commission rate, a threshold, or a weight is a defect, not a shortcut.
--
-- Values are stored as jsonb with an explicit declared type so that
-- shared/config can fail loudly on a bad value rather than silently coercing
-- one. `is_public` marks the rows the browser is allowed to read.

create table app_config (
  key         text        primary key,
  value       jsonb       not null,
  value_type  text        not null
                check (value_type in ('integer', 'number', 'string', 'boolean', 'json')),
  description text        not null default '',
  is_public   boolean     not null default false,
  updated_at  timestamptz not null default now(),
  -- The admin account that last changed this. Not a foreign key: `profiles`
  -- belongs to the accounts module and does not exist yet, and shared must not
  -- depend on a module. moderation.admin_audit is the authoritative record of
  -- who changed what.
  updated_by  uuid
);

comment on table app_config is
  'Operator-tunable settings. Read through shared/config, never queried directly by modules.';

create trigger app_config_set_updated_at
  before update on app_config
  for each row execute function public.set_updated_at();

alter table app_config enable row level security;

-- Read-only, and only the rows explicitly marked public. There is deliberately
-- no insert/update/delete policy: writes happen server-side through the
-- privileged connection, which is the only path that also writes an audit row.
create policy app_config_public_read on app_config
  for select
  to anon, authenticated
  using (is_public);

grant select on app_config to anon, authenticated;

-- ---------------------------------------------------------------------------
-- Defaults.
--
-- Sources: design.md ("Open Questions" — commission 15%), the upload-pipeline
-- spec (1200px shorter edge, 100 KB minimum), design.md ("Images and storage" —
-- 1600px display cap, ~300 KB) and artist-payouts (delivery + 14 days).
--
-- Values marked UNDECIDED below are placeholders standing in for entries in
-- OPEN-QUESTIONS.md. They are deliberately conservative and must be reviewed
-- before launch; none of them blocks implementation, which is the whole point
-- of holding them here rather than in code.
-- ---------------------------------------------------------------------------

insert into app_config (key, value, value_type, description, is_public) values
  ('platform.currency',                    '"ILS"',   'string',  'Trading currency. Israel-only in the MVP.', true),
  ('platform.commission_rate',             '0.15',    'number',  'Platform commission on the item subtotal, excluding shipping. Rate in force at order time is copied onto the order.', false),

  ('checkout.reservation_ttl_minutes',     '30',      'integer', 'How long a checkout holds inventory before the reservation is swept.', false),

  ('matchmaker.result_count',              '5',       'integer', 'Maximum matches returned for a questionnaire. UNDECIDED — OPEN-QUESTIONS #13.', false),
  ('matchmaker.sparse_catalog_threshold',  '20',      'integer', 'Below this many published artworks the buyer is told the community is still growing. UNDECIDED — OPEN-QUESTIONS #12.', false),
  ('matchmaker.over_budget_tolerance',     '0.15',    'number',  'Fraction above the stated budget still eligible to be shown. UNDECIDED — OPEN-QUESTIONS #14.', false),
  ('matchmaker.minimum_score',             '0.35',    'number',  'Below this score an artwork is not shown at all, even if it would fill the result count.', false),
  ('matchmaker.tie_tolerance',             '0.02',    'number',  'Score band within which artworks are considered tied and rotated by lifetime impressions.', false),
  ('matchmaker.weight_embedding',          '0.45',    'number',  'Scoring weight w_embed. UNDECIDED — tune on real data, OPEN-QUESTIONS #15.', false),
  ('matchmaker.weight_taxonomy',           '0.25',    'number',  'Scoring weight w_tax.', false),
  ('matchmaker.weight_budget',             '0.15',    'number',  'Scoring weight w_budget.', false),
  ('matchmaker.weight_size',               '0.10',    'number',  'Scoring weight w_size.', false),
  ('matchmaker.weight_freshness',          '0.05',    'number',  'Scoring weight w_fresh.', false),

  ('upload.min_shorter_edge_px',           '1200',    'integer', 'Minimum shorter edge of an uploaded image. upload-pipeline spec.', true),
  ('upload.min_file_size_bytes',           '102400',  'integer', 'Minimum accepted file size (100 KB). upload-pipeline spec.', true),
  ('upload.blur_threshold',                '100',     'number',  'Minimum Laplacian variance. UNDECIDED — calibrate against real photographs, OPEN-QUESTIONS #17.', false),
  ('upload.safety_confidence_threshold',   '0.70',    'number',  'Confidence at or above which safety screening blocks an image.', false),
  ('upload.max_display_dimension_px',      '1600',    'integer', 'Long edge of the public display derivative. design.md.', false),
  ('upload.display_target_bytes',          '307200',  'integer', 'Target size of the display derivative (~300 KB). design.md.', false),

  ('shipping.unshipped_grace_days',        '3',       'integer', 'Business days past the stated lead time before a fulfilment is chased.', false),

  ('returns.window_days',                  '14',      'integer', 'Days a buyer has to request a return.', true),
  ('returns.receipt_window_days',          '14',      'integer', 'Days a requested return may go unreceived before it is escalated.', false),
  ('returns.cancellation_fee_rate',        '0',       'number',  'Cancellation fee as a fraction of the item subtotal. Israeli law permits up to 5% or ILS 100, whichever is lower. UNDECIDED — OPEN-QUESTIONS #5; 0 until an answer exists.', true),

  ('payouts.eligibility_delay_days',       '14',      'integer', 'Days after delivery before a payout becomes eligible. design.md.', false),

  ('moderation.operator_email',            '""',      'string',  'Address that receives new-report notifications. Must be set before launch.', false)
on conflict (key) do nothing;
