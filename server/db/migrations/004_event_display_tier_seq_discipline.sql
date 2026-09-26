-- Migration 004 — the read-path projection columns and the seq discipline (ADR-003 E1).
--
-- Normative source: ADR-003 D1/D3 as amended by A1.4 (R1 "membership changes only by a
-- status transition that bumps seq") and A1.5, with the display tiers of ADR-002 D6
-- (`displayTierFor` in `core/lifecycle/lifecycle-state.ts`). Migration 001 carried the
-- lifecycle *state* and the global `seq` but not the two values the snapshot builder is
-- forbidden to derive at read time:
--
--   `display_tier`   — which read surface the event belongs to: `map` (the active set
--                      that `/snapshot.json` serves), `feed` (recently inactive, list
--                      only), `archive`. R1 forbids the snapshot builder from being a
--                      wall-clock filter, so "has this event been inactive for more than
--                      N hours" must be a *persisted* answer written by a scheduled
--                      transition — not a `WHERE last_detection_at > now() - interval`
--                      that two replicas evaluate differently and no ETag can see.
--   `inactive_since` — the anchor the time rules count from (A2.2 "the clock starts at
--                      the transition out of active, not at the last detection"). NULL
--                      while the event is active or weakening; set in the same write
--                      that writes the transition out and bumps `seq`.
--
-- The seq discipline itself is a BEFORE UPDATE trigger. 001 says every transition "must
-- assign nextval explicitly", and the status store does; the trigger is the backstop for
-- every *other* writer — the clustering adapter's merge tombstone, a curation UPDATE run
-- by hand, a future job nobody has written yet. A1.4's acceptance is "every removal path
-- changes the ETag", and a rule that holds for the paths we remembered is not a rule.
-- The trigger bumps `seq` when a column the snapshot projects (membership, lifecycle,
-- geometry, aggregates, links) changes and the writer left `seq` alone; it never bumps on
-- an update that touches only bookkeeping (`miss_evidence`, `updated_at`,
-- `config_version`), because a seq bump is a cache miss for every client and the E
-- accumulator is written every tick. It also refuses a `seq` that moves backwards —
-- "never recycled or reordered" was a comment in 001 and is a constraint here.
--
-- The active-set predicate the snapshot uses is `display_tier = 'map' AND merged_into IS
-- NULL AND NOT invalidated` — tombstones and invalidated events keep their id and history
-- (I1) but are not fires anyone should be shown — and the partial index below is that
-- predicate, ordered by `seq`, so both the full read and the `?updated_after_seq` cursor
-- are one range scan.

-- migrate:up

ALTER TABLE fire_events
  -- Nullable first, backfilled from `status`, then tightened (the 003 pattern).
  ADD COLUMN display_tier text,
  ADD COLUMN inactive_since timestamptz;

UPDATE fire_events
   SET display_tier = CASE WHEN status = 'archived' THEN 'archive' ELSE 'map' END,
       inactive_since = CASE WHEN status IN ('active', 'signal_weakening')
                             THEN NULL ELSE status_changed_at END;

ALTER TABLE fire_events
  ALTER COLUMN display_tier SET NOT NULL,
  ALTER COLUMN display_tier SET DEFAULT 'map',
  ADD CONSTRAINT fire_events_display_tier_check
    CHECK (display_tier IN ('map', 'feed', 'archive')),
  -- An active or weakening event is on the map, an archived one is in the archive; the
  -- tiers in between are the scheduled transitions' to write. Enforced here so that a
  -- projection can trust the column instead of re-deriving it from `status`.
  ADD CONSTRAINT fire_events_display_tier_matches_status
    CHECK (
      (status NOT IN ('active', 'signal_weakening') OR display_tier = 'map')
      AND (status <> 'archived' OR display_tier = 'archive')
    ),
  -- The anchor exists exactly while the event is out of the active states.
  ADD CONSTRAINT fire_events_inactive_since_matches_status
    CHECK ((status IN ('active', 'signal_weakening')) = (inactive_since IS NULL));

COMMENT ON COLUMN fire_events.display_tier IS
  'Read surface (ADR-002 D6 display tiers): map = active set served by /snapshot.json, feed = list only, archive. Written by lifecycle transitions, never derived at read time (ADR-003 A1.4 R1).';
COMMENT ON COLUMN fire_events.inactive_since IS
  'Instant of the transition out of active/signal_weakening that the time rules count from (A2.2). NULL while active or weakening.';

CREATE INDEX fire_events_active_set ON fire_events (seq)
  WHERE display_tier = 'map' AND merged_into IS NULL AND NOT invalidated;

CREATE FUNCTION fire_events_seq_discipline() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.seq < OLD.seq THEN
    RAISE EXCEPTION 'fire_events.seq must not move backwards (% -> %) on %',
      OLD.seq, NEW.seq, OLD.public_id
      USING ERRCODE = 'check_violation';
  END IF;

  -- The writer bumped it itself (the explicit nextval 001 asks for): nothing to do.
  IF NEW.seq <> OLD.seq THEN
    RETURN NEW;
  END IF;

  -- Every column the snapshot projects or filters on. Exact geometry equality needs
  -- PostGIS >= 2.4, which 001 already assumes for geometry(Point, 4326).
  IF ROW(OLD.status, OLD.status_reason, OLD.status_changed_at, OLD.display_tier,
         OLD.inactive_since, OLD.merged_into, OLD.invalidated, OLD.needs_review,
         OLD.centroid, OLD.hull, OLD.hull_diameter_km, OLD.detection_count,
         OLD.max_frp_mw, OLD.score, OLD.source_mix, OLD.nearest_place,
         OLD.related_event_id, OLD.relation_kind, OLD.started_at, OLD.last_detection_at)
     IS DISTINCT FROM
     ROW(NEW.status, NEW.status_reason, NEW.status_changed_at, NEW.display_tier,
         NEW.inactive_since, NEW.merged_into, NEW.invalidated, NEW.needs_review,
         NEW.centroid, NEW.hull, NEW.hull_diameter_km, NEW.detection_count,
         NEW.max_frp_mw, NEW.score, NEW.source_mix, NEW.nearest_place,
         NEW.related_event_id, NEW.relation_kind, NEW.started_at, NEW.last_detection_at)
  THEN
    NEW.seq := nextval('fire_events_seq_seq');
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER fire_events_seq_discipline
  BEFORE UPDATE ON fire_events
  FOR EACH ROW EXECUTE FUNCTION fire_events_seq_discipline();

-- migrate:down

DROP TRIGGER IF EXISTS fire_events_seq_discipline ON fire_events;
DROP FUNCTION IF EXISTS fire_events_seq_discipline();
DROP INDEX IF EXISTS fire_events_active_set;

ALTER TABLE fire_events
  DROP CONSTRAINT IF EXISTS fire_events_inactive_since_matches_status,
  DROP CONSTRAINT IF EXISTS fire_events_display_tier_matches_status,
  DROP CONSTRAINT IF EXISTS fire_events_display_tier_check,
  DROP COLUMN IF EXISTS inactive_since,
  DROP COLUMN IF EXISTS display_tier;
