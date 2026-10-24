-- Migration 032 — estimated fire outlines from our own VIIRS/MODIS detections (V2-A4).
--
-- The outline is the union of the pixel footprints the satellites flagged for an event,
-- closed across narrow gaps (`core/outlines/fire-outline.ts`, `fire_outline_params_vN`).
-- It is shown as an "estimated outline from satellite detections": never an official
-- perimeter, never a spread prediction. The area carries a band (`area_low_ha` ..
-- `area_high_ha`) because every edge can sit anywhere inside the pixel that put it there.
--
-- One row per event, recomputed when the event gains detections. `detection_count` and
-- `last_detection_at` record the event state the row was drawn for; a row whose values no
-- longer match `fire_events`, or whose `params_version` is not the running one, is drawn
-- again. A row with a NULL outline is an answer too: none of the event's detections came
-- from a source that draws outlines (SLSTR and geostationary are left out), and storing it
-- keeps the pass from asking again until the event changes.
--
-- Its own table, not columns on `fire_events`: the outline is not part of the event's
-- projected state and must never bump `seq` (004's trigger). Deleted with the event.
--
-- `fire_outline_pass` is the loop's heartbeat: the overlay route answers 503 when the
-- last completed pass is older than its staleness budget, so a stopped worker shows as
-- "unavailable" rather than as outlines frozen in time.

-- migrate:up

CREATE TABLE event_fire_outline (
  fire_event_id        bigint PRIMARY KEY REFERENCES fire_events (id) ON DELETE CASCADE,
  params_version       text NOT NULL,
  detection_count      integer NOT NULL CHECK (detection_count >= 0),
  last_detection_at    timestamptz NOT NULL,
  footprints           integer NOT NULL CHECK (footprints >= 0),
  outline              geometry(MultiPolygon, 4326),
  area_ha              double precision CHECK (area_ha > 0),
  area_low_ha          double precision CHECK (area_low_ha >= 0),
  area_high_ha         double precision,
  edge_uncertainty_km  double precision CHECK (edge_uncertainty_km > 0),
  computed_at          timestamptz NOT NULL,
  CONSTRAINT event_fire_outline_area_iff_outline
    CHECK ((outline IS NULL) = (area_ha IS NULL)
       AND (outline IS NULL) = (area_low_ha IS NULL)
       AND (outline IS NULL) = (area_high_ha IS NULL)
       AND (outline IS NULL) = (edge_uncertainty_km IS NULL)),
  CONSTRAINT event_fire_outline_band
    CHECK (area_ha IS NULL OR (area_low_ha <= area_ha AND area_ha <= area_high_ha))
);

COMMENT ON TABLE event_fire_outline IS
  'Estimated outline of an event from its own VIIRS/MODIS pixel footprints (V2-A4). Not an official perimeter; never bumps seq.';
COMMENT ON COLUMN event_fire_outline.outline IS
  'Union of flagged pixel footprints, closed across narrow gaps; NULL when no detection came from an outline-drawing source.';
COMMENT ON COLUMN event_fire_outline.edge_uncertainty_km IS
  'Largest footprint half-extent used: how far any drawn edge may sit from the true edge.';

CREATE TABLE fire_outline_pass (
  -- One loop, one row. The CHECK is the whole of the "singleton" guarantee.
  id                 smallint PRIMARY KEY CHECK (id = 1),
  params_version     text NOT NULL,
  last_completed_at  timestamptz NOT NULL
);

COMMENT ON TABLE fire_outline_pass IS
  'When the outline loop last finished a pass (V2-A4); the overlay route is unavailable once it is stale.';

INSERT INTO table_backup_class (table_name, class, note) VALUES
  ('event_fire_outline', 'main', 'V2-A4 outlines; recomputable from event_detections'),
  ('fire_outline_pass', 'main', 'V2-A4 loop heartbeat');

-- No DELETE: a row is replaced by UPDATE, and goes with its event.
GRANT SELECT, INSERT, UPDATE ON event_fire_outline TO fire_watch_app;
GRANT SELECT, INSERT, UPDATE ON fire_outline_pass TO fire_watch_app;

-- migrate:down

DELETE FROM table_backup_class WHERE table_name IN ('event_fire_outline', 'fire_outline_pass');
DROP TABLE IF EXISTS fire_outline_pass;
DROP TABLE IF EXISTS event_fire_outline;
