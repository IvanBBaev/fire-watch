-- Migration 022 — lightning context before an event's first detection (TASKS F18;
-- DATA-SOURCES §F18).
--
-- The event page says how many MTG Lightning Imager flashes fell within a radius of the
-- event in the hours before it was first detected. Context only — never a claim about
-- cause (GLOSSARY §5.2). The flashes themselves live in the worker's rolling document
-- (nine hours); this table keeps the one number per event that outlives it.
--
-- One row per event, written once the answer is known:
--
--   - `complete`: the whole window [started_at - window_hours, started_at] was covered by
--     merged LI products, so `flash_count` (possibly 0) is a statement about the data.
--   - `unavailable`: the window has left the document's retention before it was covered
--     (no credentials yet, an outage, an event first seen long after its start). The page
--     says "no lightning data", never "no lightning".
--
-- `params_version` (`lightning_context_vN`) and `filter_version` (`lightning_filter_vN`)
-- record what the number was computed under (ADR-002 D7). A row under another params
-- version is re-evaluated; once the flashes have aged out that re-evaluation can only say
-- `unavailable`, which is the honest answer under the new parameters.
--
-- Its own table, not columns on `fire_events`: the context is not part of the event's
-- projected state and must never bump `seq` (004's trigger), and the row is written by
-- the lightning loop, which owns nothing else on the event. Deleted with the event.

-- migrate:up

CREATE TABLE event_lightning_context (
  fire_event_id   bigint PRIMARY KEY REFERENCES fire_events (id) ON DELETE CASCADE,
  status          text NOT NULL CHECK (status IN ('complete', 'unavailable')),
  window_from     timestamptz NOT NULL,
  window_to       timestamptz NOT NULL,
  radius_km       real NOT NULL CHECK (radius_km > 0),
  flash_count     integer CHECK (flash_count >= 0),
  nearest_km      real CHECK (nearest_km >= 0),
  params_version  text NOT NULL,
  filter_version  text NOT NULL,
  computed_at     timestamptz NOT NULL,
  CONSTRAINT event_lightning_context_window CHECK (window_from < window_to),
  CONSTRAINT event_lightning_context_count_iff_complete
    CHECK ((status = 'complete') = (flash_count IS NOT NULL)),
  CONSTRAINT event_lightning_context_nearest_needs_flashes
    CHECK (nearest_km IS NULL OR flash_count > 0)
);

COMMENT ON TABLE event_lightning_context IS
  'MTG-LI flashes near an event before its first detection (TASKS F18). Context only, never cause; never bumps seq.';
COMMENT ON COLUMN event_lightning_context.status IS
  'complete = window fully covered by LI products (flash_count is data); unavailable = no lightning data for the window.';

INSERT INTO table_backup_class (table_name, class, note) VALUES
  ('event_lightning_context', 'main', 'F18 context; flashes are gone once the document ages out');

-- No DELETE: a row is replaced (params version change) by UPDATE, never removed.
GRANT SELECT, INSERT, UPDATE ON event_lightning_context TO fire_watch_app;

-- migrate:down

DELETE FROM table_backup_class WHERE table_name = 'event_lightning_context';
DROP TABLE IF EXISTS event_lightning_context;
