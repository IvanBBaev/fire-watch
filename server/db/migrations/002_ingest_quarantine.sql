-- Migration 002 — ingest batch log, quarantine, and the detection quarantine flag.
--
-- Normative sources: TASKS C2, docs/reviews/01-architect.md §6.1.3, ADR-002 D1/A1.1
-- (append-only archive), ADR-002 D5 (versioned config on every recorded decision).
--
-- Migration 001 remains the schema owner for everything it created; this file adds the
-- ingest bookkeeping that C2 needs and touches exactly one column of `detections`.
--
-- Three things land here and they answer three different questions:
--
--   `ingest_batches`     — what arrived, and what the anomaly breaker made of it. Written
--                          for every successful poll, because the trailing baseline is
--                          built from these rows: a batch missing from the history is a
--                          batch that quietly lowers the bar for the next one.
--   `ingest_quarantine`  — the bytes of what could not be read or could not be believed.
--   `detections.quarantined` — the flag alerting reads, set at insert time.
--
-- Why a flag on the row rather than a status the breaker sets afterwards. Review 01's
-- sketch quarantines by UPDATE after the write; the runtime role holds SELECT and INSERT
-- on `detections` and nothing else, on purpose (001, ADR-002 A1.1), so the decision is
-- taken before the insert and travels with the row. A tripped batch still lands — the
-- 2026 season cannot be re-polled and raw capture is the value (IMPLEMENTATION-PLAN WP1)
-- — it lands marked, alerting skips it, and a human clears it through a path ingest does
-- not hold.

-- migrate:up

-- ── ingest batch log ────────────────────────────────────────────────────────────
-- Keyed by `(source, available_at)` and by nothing else. That pair identifies a
-- response — the instant a source's bytes were in our hands — so recording the same
-- response twice is recording the same response, and the adapter's ON CONFLICT DO
-- NOTHING makes a double poll as harmless here as A1.1 makes it in the archive.
--
-- It is also the join to `ingest_quarantine`, deliberately without a foreign key: the
-- two writes then have no ordering dependency on each other, entries may land before
-- the batch row or the batch row alone, and neither leaves a dangling reference.
CREATE TABLE ingest_batches (
  source        text NOT NULL REFERENCES sources (id),
  -- The batch's `available_at`, exactly as stamped on the detections it produced.
  available_at  timestamptz NOT NULL,
  recorded_at   timestamptz NOT NULL DEFAULT now(),

  -- Rows the response contained: the number the breaker judged. Not the inserted count
  -- — with day_range=2 every poll re-delivers the same two-day window, so `received` is
  -- the large, slowly-moving quantity a ratio test needs, while `inserted` is the
  -- handful of rows new since ten minutes ago.
  received      integer NOT NULL CHECK (received >= 0),
  -- Rows this poll actually added; the rest the archive already held.
  inserted      integer NOT NULL CHECK (inserted >= 0),
  already_present integer NOT NULL CHECK (already_present >= 0),
  -- Lines the parser could not read at all.
  rejected      integer NOT NULL CHECK (rejected >= 0),
  -- Rows that parsed and then failed E1 validation.
  quarantined   integer NOT NULL CHECK (quarantined >= 0),

  -- The breaker's verdict, kept verbatim: "not tripped" has three quite different
  -- meanings and an operator investigating a flood that got through needs to know which
  -- one applied (see core/ingest/anomaly-breaker.ts).
  anomaly_verdict text NOT NULL CHECK (anomaly_verdict IN (
    'not_enough_history', 'below_floor', 'within_baseline', 'above_baseline'
  )),
  anomaly_tripped boolean NOT NULL,
  -- The trailing median, and `received / baseline` rounded to two decimals. Both null
  -- when there was no baseline to take; `ratio` is additionally null when the baseline
  -- was zero, because a ratio of infinity is not a number the archive can keep.
  baseline      numeric(12, 1) CHECK (baseline >= 0),
  ratio         numeric(12, 2) CHECK (ratio >= 0),

  -- Which versioned parameters the decision ran under (ADR-002 D5). A quarantined
  -- September batch is re-judged against these, never against today's numbers.
  ingest_config_version   text NOT NULL,
  polling_bbox_version    text NOT NULL,
  source_registry_version text NOT NULL,

  PRIMARY KEY (source, available_at),
  -- A verdict of `not_enough_history` is the one state with no baseline; every other
  -- verdict was taken against one. Catches a wiring bug that would otherwise show up as
  -- a breaker that silently never armed.
  CONSTRAINT ingest_batches_baseline_matches_verdict CHECK (
    (anomaly_verdict = 'not_enough_history') = (baseline IS NULL)
  ),
  CONSTRAINT ingest_batches_ratio_needs_baseline CHECK (
    ratio IS NULL OR baseline > 0
  ),
  CONSTRAINT ingest_batches_tripped_matches_verdict CHECK (
    anomaly_tripped = (anomaly_verdict = 'above_baseline')
  )
);

COMMENT ON TABLE ingest_batches IS
  'Append-only. One row per successful poll; the trailing window the anomaly breaker '
  'measures against is read from here, newest first.';

-- The breaker's read path: the last N successful polls for one source. Also the query
-- the freshness page runs, which is why available_at is indexed descending.
CREATE INDEX ingest_batches_recent ON ingest_batches (source, available_at DESC);
CREATE INDEX ingest_batches_tripped ON ingest_batches (available_at DESC)
  WHERE anomaly_tripped;

-- ── quarantine ──────────────────────────────────────────────────────────────────
-- What was wrong, with the evidence attached. `raw` is the line as delivered, never a
-- re-serialization of our parse: a row can parse cleanly and still be unbelievable, and
-- at that point the bytes are the only honest record of what arrived.
CREATE TABLE ingest_quarantine (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source        text NOT NULL REFERENCES sources (id),
  available_at  timestamptz NOT NULL,
  recorded_at   timestamptz NOT NULL DEFAULT now(),

  -- 'row'   — one line that could not be read or could not be believed.
  -- 'batch' — the breaker's verdict on the whole response; the rows are individually
  --           fine, so there are no bytes to point at and the evidence is the counts on
  --           the matching ingest_batches row.
  scope         text NOT NULL CHECK (scope IN ('row', 'batch')),
  -- 1-based among data rows, so an entry and a CSV line address the same thing.
  row_index     integer CHECK (row_index >= 1),
  -- Set when the row got far enough to be identified. Not a foreign key: a quarantined
  -- row may never have landed in `detections` at all.
  detection_uid text CHECK (detection_uid ~ '^[0-9a-f]{64}$'),
  reason        text NOT NULL CHECK (reason <> ''),
  raw           text,

  CONSTRAINT ingest_quarantine_row_carries_bytes CHECK (
    scope <> 'row' OR (raw IS NOT NULL AND row_index IS NOT NULL)
  ),
  CONSTRAINT ingest_quarantine_batch_points_at_nothing CHECK (
    scope <> 'batch' OR (raw IS NULL AND row_index IS NULL AND detection_uid IS NULL)
  ),
  -- NULLS NOT DISTINCT so the single batch-scope entry, whose row_index is null,
  -- collides with itself on a re-record. Without it a replayed poll would append a
  -- second copy of the same verdict every time.
  UNIQUE NULLS NOT DISTINCT (source, available_at, scope, row_index)
);

COMMENT ON TABLE ingest_quarantine IS
  'Append-only. Rows are never un-quarantined by an UPDATE — a cleared batch is judged '
  'again from what was recorded here (ADR-002 D5).';

CREATE INDEX ingest_quarantine_batch ON ingest_quarantine (source, available_at DESC);

-- ── the flag alerting reads ─────────────────────────────────────────────────────
-- Set at insert time and never updated, which is what lets it exist on an append-only
-- table at all. The default is false so the 2020–2025 backfill partitions and every row
-- written before this migration keep the meaning they already had.
ALTER TABLE detections ADD COLUMN quarantined boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN detections.quarantined IS
  'The ingest anomaly breaker tripped on the batch this row arrived in (TASKS C2). Set '
  'at insert time, never updated. Alerting skips these rows; the map and the archive do '
  'not — a false trip must not become permanent data loss.';

-- Partial, because in a healthy season almost nothing is flagged and the index is then
-- a few pages rather than a copy of the archive.
CREATE INDEX detections_quarantined ON detections (acq_ts DESC) WHERE quarantined;

INSERT INTO table_backup_class (table_name, class, note) VALUES
  ('ingest_batches',    'main', 'poll counts and breaker verdicts'),
  ('ingest_quarantine', 'main', 'raw provider CSV lines; no personal data by construction');

-- ── grants ──────────────────────────────────────────────────────────────────────
-- Append-only by grant, like the archive itself. The runtime role writes quarantine
-- entries and reads its own trailing baseline; clearing a quarantine is a schema-owner
-- operation, because "the process that quarantines cannot un-quarantine itself" is the
-- same principle as "the process that alerts cannot delete its own evidence".
GRANT SELECT, INSERT ON ingest_batches, ingest_quarantine TO fire_watch_app;

-- migrate:down

DELETE FROM table_backup_class WHERE table_name IN ('ingest_batches', 'ingest_quarantine');

DROP INDEX IF EXISTS detections_quarantined;
ALTER TABLE detections DROP COLUMN IF EXISTS quarantined;

DROP TABLE IF EXISTS ingest_quarantine;
DROP TABLE IF EXISTS ingest_batches;
