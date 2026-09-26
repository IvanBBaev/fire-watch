-- Migration 009 — the live alert evaluation loop's durable progress (TASKS H3; ADR-004 D1,
-- A1.6; ADR-003 A1.4).
--
-- `core/alerts/evaluation-cycle.ts` reads the `fire_events` rows whose `seq` moved past a
-- cursor, decides them against the watch zones that contain them, and writes the
-- resulting `alert_states` and `alert_outbox` rows. Two things must survive a restart for
-- that loop to be correct, and this migration holds them:
--
--   * `alert_evaluation_cursor` — the last `seq` a committed batch consumed. It is written
--     in the same transaction as the state and outbox rows of that batch (D1), so a crash
--     between them re-reads the batch from the old cursor and the outbox's A1.11 key turns
--     the re-decided sends into no-ops. A single row (`id = 1`); the adapter creates it on
--     first advance.
--
--   * `alert_evaluated_events` — the lifecycle status the loop last evaluated each event
--     in. That status is the gate's `statusBefore`: ladder rung 3 ("re-detected after
--     weakening") fires on the transition from `signal_weakening` / `no_longer_detected`
--     back to `active`, and by the time the loop reads the row, `fire_events.status` is
--     already the new one. Keeping it here rather than in memory is what lets the
--     transition be seen across a worker restart.
--
-- Why a `seq` cursor never skips a row: the adapter's transaction takes `FOR SHARE` on
-- `clustering_runs` before it reads, and every `fire_events` writer holds `FOR UPDATE` on
-- its run row for the whole of its transaction — so no `seq` below one this batch reads
-- can still be uncommitted when it reads.
--
-- Backup class `main`: an event id, a status and a sequence number. Nothing here names a
-- zone or an account.
--
-- Grants: the runtime role reads, creates and advances rows and deletes none. No identity
-- column, so no sequence grant.

-- migrate:up

CREATE TABLE alert_evaluation_cursor (
  -- One loop, one row. The CHECK is the whole of the "singleton" guarantee.
  id          smallint PRIMARY KEY CHECK (id = 1),
  -- The last `fire_events.seq` a committed batch consumed; 0 before the first batch.
  last_seq    bigint NOT NULL CHECK (last_seq >= 0),
  updated_at  timestamptz NOT NULL
);

CREATE TABLE alert_evaluated_events (
  fire_event_id  bigint PRIMARY KEY REFERENCES fire_events (id),
  -- The status the loop last evaluated the event in: the next evaluation's `statusBefore`.
  last_status    text NOT NULL CHECK (last_status IN (
                   'active',
                   'signal_weakening',
                   'no_longer_detected',
                   'archived',
                   'officially_contained',
                   'officially_extinguished'
                 )),
  -- The `fire_events.seq` that evaluation read.
  last_seq       bigint NOT NULL CHECK (last_seq > 0),
  evaluated_at   timestamptz NOT NULL
);

INSERT INTO table_backup_class (table_name, class, note) VALUES
  ('alert_evaluation_cursor', 'main', 'the live alert loop''s last consumed fire_events.seq'),
  ('alert_evaluated_events',  'main', 'per-event status last evaluated by the alert loop; no zone or account');

-- ── grants ──────────────────────────────────────────────────────────────────────
GRANT SELECT, INSERT, UPDATE ON alert_evaluation_cursor TO fire_watch_app;
GRANT SELECT, INSERT, UPDATE ON alert_evaluated_events TO fire_watch_app;

-- migrate:down

DELETE FROM table_backup_class
 WHERE table_name IN ('alert_evaluation_cursor', 'alert_evaluated_events');

DROP TABLE IF EXISTS alert_evaluated_events;
DROP TABLE IF EXISTS alert_evaluation_cursor;
