-- Migration 036 — the meta-alert hysteresis state, kept across restarts (TASKS J1).
--
-- The monitors loop pages after N consecutive breaching readings and clears after N
-- healthy ones (`core/monitoring/meta-alert-evaluator.ts`). Until now the streaks lived in
-- the worker's memory, and because the pager reports a level every cycle, the first cycle
-- after a restart (or a standby worker's takeover) reported "nothing paging" and cleared a
-- live page in healthchecks.io before the next cycle raised it again.
--
-- **`meta_alert_states`** holds one row per meta-alert key: whether it is paging, since
-- when, its two streaks, and when a cycle last advanced it (`evaluated_at`). Every cycle
-- reads all rows and writes them back in one transaction under
-- `pg_advisory_xact_lock(7036, 0)` — not a row lock, because a key that has never been
-- evaluated has no row to lock yet. The core decides whether a cycle advances or only
-- reports the stored level (`core/monitoring/meta-alert-memory.ts`).
--
--   * `key` is not pinned to a list: a reading that is added starts with no row, and the
--     row of a reading that is removed is ignored by the code and left in place (eight
--     rows at most today; nothing to purge);
--   * `paging` and `paging_since` agree and the streaks are never negative — the CHECKs
--     refuse a row the evaluator could never produce.
--
-- Not personal: operational state of the alert path, no account, zone or address.
-- Backup class `main`; a restore that brings back a stale row is harmless, because a row
-- older than three intervals has its streaks reset and a stale page clears after two
-- healthy readings.

-- migrate:up

CREATE TABLE meta_alert_states (
  key           text PRIMARY KEY CHECK (key ~ '^[a-z][a-z0-9_]{0,62}$'),
  paging        boolean NOT NULL,
  paging_since  timestamptz,
  breach_streak integer NOT NULL CHECK (breach_streak >= 0),
  clear_streak  integer NOT NULL CHECK (clear_streak >= 0),
  evaluated_at  timestamptz NOT NULL,
  CONSTRAINT meta_alert_states_paging_since CHECK (paging = (paging_since IS NOT NULL))
);

INSERT INTO table_backup_class (table_name, class, note) VALUES
  ('meta_alert_states', 'main', 'meta-alert hysteresis per key; operational, no personal data');

-- ── grants ──────────────────────────────────────────────────────────────────────
GRANT SELECT, INSERT, UPDATE ON meta_alert_states TO fire_watch_app;

-- migrate:down

DELETE FROM table_backup_class WHERE table_name = 'meta_alert_states';
DROP TABLE IF EXISTS meta_alert_states;
