-- Migration 021 — the static hot-source verdict behind an event, and the mask it was taken
-- against (TASKS F16; 11-data-science §3.6 and §6.2 item 2; ADR-002 D6/D7; GATES S4/S10).
--
-- F16 (2026-09-30) invalidated an event whose every detection sits on a mapped hot source,
-- but stored only the outcome: nothing on the row said which mask version decided it, so a
-- replay could not be made to load "the same mask" (D7), and a mask refresh left every
-- event judged against the old one with no way to find them. Three columns, all
-- bookkeeping:
--
--   - `static_source_verdict`: the latest verdict of `static-source-policy.ts` —
--     `static_source` (the §3.6 override: score 0, invalidated),
--     `suspected_static_source` (the §6.2 day-only repeat quarantine: invalidated, score
--     kept), `annotated` (on a source, no effect), `clear`. Both invalidations are owned by
--     the verdict — the rescore that breaks the rule, or the mask refresh that drops the
--     source, releases them; only curation's invalidations are sticky. NULL = never evaluated (tombstone, absorbed seed, or not touched
--     since this migration).
--   - `static_source_mask_version`: the mask asset's `version` the verdict was taken
--     against; NULL with a non-NULL verdict means "no mask loaded" (the quarantine still ran).
--   - `static_source_policy_version`: `static_source_policy_vN`.
--
-- The worker's tick re-evaluates every live event whose two versions differ from the
-- loaded ones (`IS DISTINCT FROM`, so NULL rows are picked up too) — that is the backfill;
-- SQL cannot compute a verdict. None of the three is in 004's trigger list: a verdict
-- change a client can see moves `invalidated` or `score`, which bump `seq` themselves.
--
-- The invalidation reason is renamed from F16's `static_source_mask` to GLOSSARY's
-- `static_source`, the one name the curation queue and the spec use. The table-level
-- grant on `fire_events` (001) covers the new columns; nothing to grant.

-- migrate:up

ALTER TABLE fire_events
  ADD COLUMN static_source_verdict text
    CONSTRAINT fire_events_static_source_verdict_check CHECK (
      static_source_verdict IN ('static_source', 'suspected_static_source', 'annotated', 'clear')
    ),
  ADD COLUMN static_source_mask_version text,
  ADD COLUMN static_source_policy_version text;

COMMENT ON COLUMN fire_events.static_source_verdict IS
  'Latest static hot-source verdict (TASKS F16, static-source-policy.ts); NULL = never evaluated. Bookkeeping: never bumps seq.';
COMMENT ON COLUMN fire_events.static_source_mask_version IS
  'Static-source mask asset version the verdict was taken against (D7); NULL with a verdict = no mask loaded.';
COMMENT ON COLUMN fire_events.static_source_policy_version IS
  'static_source_policy version the verdict was taken under (D7).';

UPDATE fire_events
   SET invalidated_reason = 'static_source'
 WHERE invalidated_reason = 'static_source_mask';

-- migrate:down

UPDATE fire_events
   SET invalidated_reason = 'static_source_mask'
 WHERE invalidated_reason = 'static_source';

ALTER TABLE fire_events
  DROP COLUMN IF EXISTS static_source_policy_version,
  DROP COLUMN IF EXISTS static_source_mask_version,
  DROP COLUMN IF EXISTS static_source_verdict;
