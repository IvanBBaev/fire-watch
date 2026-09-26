-- Migration 017 — the parameter version behind a live event's score (ADR-002 D5/D6;
-- TASKS D12 wiring, 2026-09-26 wave G).
--
-- Until now the live identity pipeline never wrote `fire_events.score`: every live event
-- sat at 001's default 0, so every one was `below_threshold` for alert evaluation. The
-- clustering store now scores each event whose member set a batch changed (`scoreEvent`,
-- `score_params_v0`) in the same UPDATE as its aggregates. D5 says the version is recorded
-- on every event row for coefficients too — a score is a claim only together with the
-- weights that produced it — and 001 has a column for the clustering version only.
--
-- NULL means the row was never scored: a merge tombstone, an absorbed seed, or an event
-- last touched before this migration (its `score` is still 001's default 0 and becomes
-- real on its next attach). No backfill: the score needs the scorer, and SQL is not it.
--
-- Bookkeeping, not projection: it is not in 004's trigger list. A version change without
-- a score change is not something a client can see; one with a score change bumps `seq`
-- through `score`. The table-level grant on `fire_events` (001) already covers a new
-- column for the runtime role; nothing to grant.

-- migrate:up

ALTER TABLE fire_events
  ADD COLUMN score_params_version text;

COMMENT ON COLUMN fire_events.score_params_version IS
  'score_params version that produced score (ADR-002 D5/D6); NULL = never scored (tombstone, absorbed seed, or not touched since 017). Bookkeeping: never bumps seq.';

-- migrate:down

ALTER TABLE fire_events
  DROP COLUMN IF EXISTS score_params_version;
