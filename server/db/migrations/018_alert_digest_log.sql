-- Migration 018 — the digest decision log and watermark (TASKS H3/D9/H7; ADR-004 D3, D4,
-- A1.7, A1.8, A1.11, A1.12; 07 §5.5.3; 2026-09-26 wave G).
--
-- `produceDigest` (core/alerts/digest.ts) is pure: it takes the account's last *given*
-- window as a parameter and returns whether the caller may move it. Until now nothing
-- persisted that watermark, so a `defer` advanced `alert_states` and was never delivered.
-- The live digest pass (core/alerts/digest-pass.ts) keeps its state here.
--
-- `alert_digest_log` is one row per (zone, digest window, outcome): the account-level
-- decision the pass took for that window, written against every live zone of the account
-- in the same transaction as the digest's outbox rows (D1). The decision is per account —
-- quiet hours and the time zone are account settings (A1.7) — but the row is keyed by zone
-- for the same reason `alert_decision_log` (014) is: the account's personal alert data is
-- reached through its zones, and the erasure cascade then needs no second path.
--
--   - `send` / `daily_summary`  — a digest was written to the outbox; the window is spent.
--   - `suppress` / `nothing_active` — the window opened over a quiet map; spent (07 §5.5.3).
--   - `hold` / `quiet_hours` — the window opened inside quiet hours; **not** spent (A1.7):
--     the same window fires under the same subkey once the quiet hours end. Logged once per
--     zone and window, so a pass that ticks through the night writes one row, not dozens.
--
-- **The watermark is derived, never stored twice.** An account's last given window is
-- `max(window_start)` over its zones' `send` and `suppress` rows — soft-deleted zones
-- included, so deleting one zone never re-opens a window another zone already consumed.
-- Because the watermark and the outbox rows are written by the same INSERTs in the same
-- transaction, a pass that crashes before COMMIT has spent nothing and sent nothing.
--
-- **Never re-delivered.** `UNIQUE (watch_zone_id, window_start, outcome)` is the first
-- line: the pass inserts its `send` rows *before* the outbox rows and writes no outbox
-- row when the insert conflicts (a concurrent or replayed pass lost the race). A1.11's
-- outbox key `(zone, event, 'digest', window start)` is the second.
--
-- **No facts, no copy.** The row carries the outcome, the reason, how many lines the
-- digest had and the digest config's version — never an event id, a distance or a
-- rendered sentence. Which fires a digest listed is in the outbox row it wrote.
--
-- **Erasure (migration 010).** Keyed by zone, no account id: personal data about the
-- zone's owner, removed by the zone foreign key's ON DELETE CASCADE (which runs as the
-- table owner, so the table stays append-only for the runtime role). The pass holds the
-- account row FOR SHARE for its whole transaction and erasure takes it FOR UPDATE first,
-- so a pass racing an erasure either commits first (and its rows go with the zones) or
-- finds the account tombstoned and writes nothing.
--
-- Backup class `personal`, like `alert_decision_log`. The only foreign key points
-- personal → personal (zone).
--
-- Grants: SELECT and INSERT, no UPDATE, no DELETE — a decision record that could be
-- rewritten would not be evidence, and a watermark that could be rewritten would re-send.
-- **No retention purge yet:** a purge must keep each account's newest spent row or the
-- watermark resets and yesterday's window is owed again; that function and its retention
-- are an open item (`core/erasure/purge-plan.ts` does not name this table).

-- migrate:up

CREATE TABLE alert_digest_log (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  -- Cascades: erasure (and any zone delete) takes the zone's digest history with it.
  watch_zone_id    uuid NOT NULL REFERENCES watch_zones (id) ON DELETE CASCADE,
  -- The window's opening instant (09:00 local, `digest_params`): the A1.11 digest subkey.
  window_start     timestamptz NOT NULL,
  outcome          text NOT NULL CHECK (outcome IN ('send', 'hold', 'suppress')),
  -- `DIGEST_REASONS` (core/alerts/digest.ts); each outcome has exactly one.
  reason           text NOT NULL CHECK (reason IN ('daily_summary', 'quiet_hours', 'nothing_active')),
  -- Lines in the digest (events, after A1.12's nearest-zone fold). 0 unless `send`.
  entry_count      integer NOT NULL CHECK (entry_count >= 0),
  -- The digest config's `config_version`, e.g. `digest_params_v1`.
  rule_version     text NOT NULL CHECK (rule_version ~ '^[a-z0-9_]+_v[0-9]+$'),
  decided_at       timestamptz NOT NULL,
  recorded_at      timestamptz NOT NULL DEFAULT now(),
  -- One decision of each kind per zone and window: a replayed or concurrent pass inserts
  -- nothing, and the pass writes no outbox row for a `send` that conflicted.
  CONSTRAINT alert_digest_log_once_per_window
    UNIQUE (watch_zone_id, window_start, outcome),
  CONSTRAINT alert_digest_log_reason_matches_outcome
    CHECK (
      (outcome = 'send' AND reason = 'daily_summary' AND entry_count > 0)
      OR (outcome = 'hold' AND reason = 'quiet_hours' AND entry_count = 0)
      OR (outcome = 'suppress' AND reason = 'nothing_active' AND entry_count = 0)
    ),
  -- `decided_at` is the pass's instant; a window cannot be decided before it opened.
  CONSTRAINT alert_digest_log_decided_after_window
    CHECK (decided_at >= window_start)
);

-- The watermark read: newest spent window per zone. The unique constraint's index leads
-- with the zone and the window, which already serves it; the retention purge (not built)
-- would walk `decided_at`.
CREATE INDEX alert_digest_log_by_decided_at ON alert_digest_log (decided_at);

INSERT INTO table_backup_class (table_name, class, note) VALUES
  ('alert_digest_log', 'personal', 'keyed by zone');

-- ── grants ──────────────────────────────────────────────────────────────────────
-- No UPDATE, no DELETE: the digest log is evidence and the watermark.
GRANT SELECT, INSERT ON alert_digest_log TO fire_watch_app;
GRANT USAGE ON SEQUENCE alert_digest_log_id_seq TO fire_watch_app;

-- migrate:down

DELETE FROM table_backup_class WHERE table_name = 'alert_digest_log';
DROP TABLE IF EXISTS alert_digest_log;
