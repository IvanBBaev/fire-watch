-- Migration 024 — the lightning context remembers where it counted (TASKS F18;
-- DATA-SOURCES §F18).
--
-- 022 wrote one row per event and kept it until the params version changed. But an
-- event's centroid drifts as detections join it, and a merge can move its first detection
-- earlier; a count around a point or over a window the event no longer has is a statement
-- about another place or another storm. The row now records the centroid it was computed
-- for (`window_to` already records the first detection), and the worker recomputes it once
-- the event has moved beyond a small tolerance (`LIGHTNING_CONTEXT_DRIFT`, kept out of the
-- params version so changing it never invalidates every row).
--
-- Additive. Rows written before this migration take the event's current centroid: 022
-- never recorded the point it counted around, and the current one is the best surviving
-- statement of it (no deployed data at the time of writing, so nothing is misattributed).

-- migrate:up

ALTER TABLE event_lightning_context
  ADD COLUMN centroid_lat double precision,
  ADD COLUMN centroid_lon double precision;

UPDATE event_lightning_context c
   SET centroid_lat = ST_Y(e.centroid),
       centroid_lon = ST_X(e.centroid)
  FROM fire_events e
 WHERE e.id = c.fire_event_id;

ALTER TABLE event_lightning_context
  ALTER COLUMN centroid_lat SET NOT NULL,
  ALTER COLUMN centroid_lon SET NOT NULL,
  ADD CONSTRAINT event_lightning_context_centroid_range
    CHECK (centroid_lat BETWEEN -90 AND 90 AND centroid_lon BETWEEN -180 AND 180);

COMMENT ON COLUMN event_lightning_context.centroid_lat IS
  'Event centroid (WGS84) the flashes were counted around; the row is recomputed once the event moves beyond LIGHTNING_CONTEXT_DRIFT.';
COMMENT ON COLUMN event_lightning_context.centroid_lon IS
  'Event centroid (WGS84) the flashes were counted around.';

-- migrate:down

ALTER TABLE event_lightning_context
  DROP CONSTRAINT IF EXISTS event_lightning_context_centroid_range,
  DROP COLUMN IF EXISTS centroid_lat,
  DROP COLUMN IF EXISTS centroid_lon;
