-- Migration 019 — the lifecycle transition log (TASKS D8; GLOSSARY §8 FER, FLR;
-- ADR-002 D6 as amended by A2.3; 2026-09-26).
--
-- `fire_events` keeps only an event's *current* status and `status_changed_at`. FER counts
-- events that entered `no_longer_detected` in a week and re-attached within 72 h; FLR
-- counts direction reversals within 48 h. Both need the history, and the history is lost
-- exactly for the events they grade: an event that re-activated overwrote its
-- `no_longer_detected` entry — the premature declarations FER's numerator counts — so a
-- reconstruction from the current row would be biased toward passing. The weekly report
-- has shipped both as `unavailable` for that reason.
--
-- **Recorded by a trigger, not by the writers.** Every status change, by any writer — the
-- lifecycle tick (`pg-event-status-store.ts`) today, a curated-statement tool tomorrow —
-- and every event's creation land here in the same transaction as the change. A writer
-- cannot forget to log, which is the point of a log that grades the rule set.
--
-- **What a row carries.** The event, the two states (`from_status` NULL for the creation
-- row), `status_reason` as the writer set it (`unobservable` marks A2.3(3)'s fallback
-- closure, which FER reports as its own class), the transition instant
-- (`status_changed_at`, the pipeline's clock — never `now()`), and the `seq` it was drawn
-- under. Plus two facts as of the transition, `max_frp_mw` and the hull area in hectares:
-- FER's large-event class (hull ≥ 100 ha OR max FRP ≥ 100 MW OR peat/landfill fuel) is
-- judged as the event stood when it was declared, not as it grew after re-attaching. The
-- rule itself stays in one place, `isLargeEvent` in `core/lifecycle/lifecycle-state.ts`.
--
-- **The log's origin.** History starts with this migration; no earlier transition can be
-- recovered. `lifecycle_log_origin` records when the log began, so a report for a week the
-- log does not fully cover (FLR also needs 48 h of lead-in) says `unavailable` instead of
-- reading an empty history as a perfect score.
--
-- Not personal data: event facts only, no zone, account or coordinate. Backup class
-- `main`, like `fire_events`. Append-only for the runtime role: a rewritten transition
-- would rewrite the evidence FER grades the E weights with.

-- migrate:up

CREATE TABLE lifecycle_log_origin (
  id         smallint PRIMARY KEY CHECK (id = 1),
  started_at timestamptz NOT NULL
);

INSERT INTO lifecycle_log_origin (id, started_at) VALUES (1, now());

CREATE TABLE fire_event_transitions (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  fire_event_id   bigint NOT NULL REFERENCES fire_events (id),
  -- NULL on the row that records the event's creation.
  from_status     text CHECK (from_status IN (
                    'active', 'signal_weakening', 'no_longer_detected', 'archived',
                    'officially_contained', 'officially_extinguished'
                  )),
  to_status       text NOT NULL CHECK (to_status IN (
                    'active', 'signal_weakening', 'no_longer_detected', 'archived',
                    'officially_contained', 'officially_extinguished'
                  )),
  status_reason   text,
  transitioned_at timestamptz NOT NULL,
  seq             bigint NOT NULL,
  max_frp_mw      real,
  hull_area_ha    real CHECK (hull_area_ha IS NULL OR hull_area_ha >= 0),
  recorded_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fire_event_transitions_moves
    CHECK (from_status IS DISTINCT FROM to_status)
);

-- The weekly report reads a window of transitions; FLR reads one event's history in order.
CREATE INDEX fire_event_transitions_by_time ON fire_event_transitions (transitioned_at);
CREATE INDEX fire_event_transitions_by_event
  ON fire_event_transitions (fire_event_id, transitioned_at);

CREATE FUNCTION fw_record_lifecycle_transition()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.status IS NOT DISTINCT FROM OLD.status THEN
    RETURN NULL;
  END IF;
  INSERT INTO fire_event_transitions (
    fire_event_id, from_status, to_status, status_reason, transitioned_at, seq,
    max_frp_mw, hull_area_ha
  ) VALUES (
    NEW.id,
    CASE WHEN TG_OP = 'UPDATE' THEN OLD.status END,
    NEW.status,
    NEW.status_reason,
    NEW.status_changed_at,
    NEW.seq,
    NEW.max_frp_mw,
    CASE WHEN NEW.hull IS NULL THEN NULL ELSE ST_Area(NEW.hull::geography) / 10000.0 END
  );
  RETURN NULL;
END
$$;

CREATE TRIGGER fire_events_record_lifecycle_transition
  AFTER INSERT OR UPDATE OF status ON fire_events
  FOR EACH ROW EXECUTE FUNCTION fw_record_lifecycle_transition();

INSERT INTO table_backup_class (table_name, class, note) VALUES
  ('fire_event_transitions', 'main', 'lifecycle history; FER/FLR evidence'),
  ('lifecycle_log_origin', 'main', 'when the transition log began');

-- ── grants ──────────────────────────────────────────────────────────────────────
-- The trigger runs as the writer, so the runtime role inserts; nothing updates or deletes.
GRANT SELECT, INSERT ON fire_event_transitions TO fire_watch_app;
GRANT USAGE ON SEQUENCE fire_event_transitions_id_seq TO fire_watch_app;
GRANT SELECT ON lifecycle_log_origin TO fire_watch_app;

-- migrate:down

DROP TRIGGER IF EXISTS fire_events_record_lifecycle_transition ON fire_events;
DROP FUNCTION IF EXISTS fw_record_lifecycle_transition();
DELETE FROM table_backup_class
  WHERE table_name IN ('fire_event_transitions', 'lifecycle_log_origin');
DROP TABLE IF EXISTS fire_event_transitions;
DROP TABLE IF EXISTS lifecycle_log_origin;
