-- Migration 008 — persisted NRT-lag histograms (TASKS C9; A23; 13 §3.3(14); 06 §5.2.2).
--
-- A23 asks for "`available_at` capture + NRT-lag histograms"; migration 001 captured
-- `available_at`, and this table keeps the histograms. One row per UTC day of arrival,
-- source and histogram version, recomputed from `detections` by
-- `core/ingest/lag-recorder.ts`. The rows are the input D5's `availability.json` is
-- exported from, and they outlive the detections they summarize only in the sense that
-- they are cheap to keep: every row can be recomputed from the archive.
--
-- The bucket edges are stored on the row, not only named by the version. A row written
-- under a retired `nrt_lag_histogram_v0` then stays readable — and mergeable only with
-- rows under the same edges — after the code that defined v0 is gone.
--
-- Backup class `main`: aggregate counts per source, no personal data by construction.
--
-- Grants: the runtime role writes and replaces rows and deletes none. UPDATE, unlike the
-- append-only evidence tables, because the current day is recomputed until it closes and
-- the row is derived data, not a record of a decision. No identity column, so no sequence
-- grant — the key is natural.

-- migrate:up

CREATE TABLE nrt_lag_histograms (
  -- The UTC calendar day of `available_at` the counts cover.
  day                date NOT NULL,
  source             text NOT NULL REFERENCES sources (id),
  -- The histogram config's `config_version` (ADR-002 D5), e.g. `nrt_lag_histogram_v0`.
  histogram_version  text NOT NULL CHECK (histogram_version ~ '^[a-z0-9_]+_v[0-9]+$'),
  -- The digest of the edges that produced the row, so edges edited in place under an
  -- unchanged version are visible in the data rather than hidden behind a version string.
  histogram_digest   text NOT NULL,
  -- Bucket lower bounds in whole minutes; bucket i is [edges[i], edges[i+1]).
  edges_minutes      integer[] NOT NULL
                     CHECK (cardinality(edges_minutes) >= 2 AND edges_minutes[1] = 0),
  counts             integer[] NOT NULL,
  -- Lags below 0 (a wrong clock) and at or past the last edge.
  below              integer NOT NULL CHECK (below >= 0),
  overflow           integer NOT NULL CHECK (overflow >= 0),
  total              integer NOT NULL CHECK (total >= 0),
  -- Null exactly when `total` is 0.
  min_lag_ms         bigint,
  max_lag_ms         bigint,
  computed_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (day, source, histogram_version),
  CONSTRAINT nrt_lag_histograms_counts_fit_edges
    CHECK (cardinality(counts) = cardinality(edges_minutes) - 1),
  CONSTRAINT nrt_lag_histograms_counts_non_negative
    CHECK (0 <= ALL (counts)),
  -- The full `total = below + overflow + Σ counts` needs a subquery, which a CHECK cannot
  -- hold; the writer computes all four together, and this catches the tails alone.
  CONSTRAINT nrt_lag_histograms_total_covers_tails CHECK (total >= below + overflow),
  CONSTRAINT nrt_lag_histograms_extrema CHECK (
    (total = 0 AND min_lag_ms IS NULL AND max_lag_ms IS NULL)
    OR (total > 0 AND min_lag_ms IS NOT NULL AND max_lag_ms IS NOT NULL
        AND min_lag_ms <= max_lag_ms)
  )
);

-- The export reads a day range of one version.
CREATE INDEX nrt_lag_histograms_by_version ON nrt_lag_histograms (histogram_version, day);

INSERT INTO table_backup_class (table_name, class, note) VALUES
  ('nrt_lag_histograms', 'main', 'aggregate lag counts per source; no personal data by construction');

-- ── grants ──────────────────────────────────────────────────────────────────────
GRANT SELECT, INSERT, UPDATE ON nrt_lag_histograms TO fire_watch_app;

-- migrate:down

DELETE FROM table_backup_class WHERE table_name = 'nrt_lag_histograms';

DROP TABLE IF EXISTS nrt_lag_histograms;
