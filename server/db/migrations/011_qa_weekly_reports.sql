-- Migration 011 — the weekly QA reports (TASKS D8; GLOSSARY §8; A2).
--
-- One row per closed ISO week, metrics config version and report config version, written
-- by `core/qa/weekly-report-job.ts`. The row holds the report twice: the canonical JSON,
-- byte for byte as rendered (`text`, not `jsonb` — jsonb reorders keys and normalises
-- numbers, and the record is the bytes), and the Markdown a person reads.
--
-- The key carries the report version as well as the metrics version. `qa_metrics_v1`
-- defines what the metrics mean; `qa_weekly_report_v1` defines how their populations are
-- read from these tables (the week, the PLB proxy, the DAR instant). A ruling on either is
-- a version bump that re-grades the week in a new row beside the old one, never over it.
--
-- A digest that changed under an unchanged version is refused by the writer
-- (`ON CONFLICT … WHERE` both digests match), as for `nrt_lag_histograms`.
--
-- Only closed ISO weeks are stored — an ad-hoc range or a still-open week is written to
-- a file by the CLI and never here — so the CHECKs pin the window to a Monday 00:00 UTC
-- and to exactly seven days, and the label to the window.
--
-- Backup class `main`: aggregate rates and quantiles; DAR duplicates name outbox row ids
-- only, never a zone, account or recipient.
--
-- Grants: the runtime role writes and replaces rows and deletes none. No identity column,
-- so no sequence grant — the key is natural.

-- migrate:up

CREATE TABLE qa_weekly_reports (
  -- `YYYY-Www`, ISO-8601 week-numbering year.
  iso_week         text NOT NULL CHECK (iso_week ~ '^[0-9]{4}-W[0-9]{2}$'),
  window_start     timestamptz NOT NULL,
  window_end       timestamptz NOT NULL,
  metrics_version  text NOT NULL CHECK (metrics_version ~ '^[a-z0-9_]+_v[0-9]+$'),
  metrics_digest   text NOT NULL,
  report_version   text NOT NULL CHECK (report_version ~ '^[a-z0-9_]+_v[0-9]+$'),
  report_digest    text NOT NULL,
  -- When the report was built; on or after the window's end, since only closed weeks land.
  generated_at     timestamptz NOT NULL,
  report_json      text NOT NULL,
  report_markdown  text NOT NULL,
  written_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (iso_week, metrics_version, report_version),
  CONSTRAINT qa_weekly_reports_monday_utc CHECK (
    window_start = date_trunc('week', window_start AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
  ),
  CONSTRAINT qa_weekly_reports_seven_days CHECK (window_end = window_start + interval '7 days'),
  CONSTRAINT qa_weekly_reports_label_matches_window CHECK (
    iso_week = to_char(window_start AT TIME ZONE 'UTC', 'IYYY-"W"IW')
  ),
  CONSTRAINT qa_weekly_reports_closed_week CHECK (generated_at >= window_end),
  CONSTRAINT qa_weekly_reports_json_kind CHECK (
    (report_json::jsonb) ->> 'kind' = 'fire_watch_qa_weekly_report'
  )
);

-- The reader lists a version's weeks in order.
CREATE INDEX qa_weekly_reports_by_version
  ON qa_weekly_reports (metrics_version, report_version, window_start);

INSERT INTO table_backup_class (table_name, class, note) VALUES
  ('qa_weekly_reports', 'main', 'aggregate weekly QA metrics; no personal data by construction');

-- ── grants ──────────────────────────────────────────────────────────────────────
GRANT SELECT, INSERT, UPDATE ON qa_weekly_reports TO fire_watch_app;

-- migrate:down

DELETE FROM table_backup_class WHERE table_name = 'qa_weekly_reports';

DROP TABLE IF EXISTS qa_weekly_reports;
