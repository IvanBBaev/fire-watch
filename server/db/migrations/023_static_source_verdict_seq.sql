-- Migration 023 — the static hot-source verdict joins the seq discipline (TASKS F16;
-- ADR-003 A1.3 additive snapshot fields, A1.4 "every change a client can see changes the
-- ETag"; UX 07 §5.3 "known industrial source").
--
-- 021 kept `static_source_verdict` out of 004's trigger list because the only verdict
-- changes a client could see moved `invalidated` or `score`, which bump `seq` themselves.
-- The snapshot and the stream now project the verdict (`static_source_verdict`, additive
-- in schema_version 2), so the `annotated` <-> `clear` flip — no effect on score or
-- membership, and exactly what a mask hot reload produces — is a visible change and must
-- move the ETag. Without it a client holding `"v2-<max_seq>"` would get a 304 for bytes
-- that no longer match the server's verdict.
--
-- Only the verdict joins the list. `static_source_mask_version` and
-- `static_source_policy_version` stay bookkeeping: a mask refresh that re-stamps every
-- event with the same verdict must not turn into a cache miss for every client.
--
-- One-time cost: the first sweep after 021 writes a verdict over NULL on every live event,
-- and each of those writes now bumps `seq` once. That is one extra snapshot rebuild per
-- live event, on the tick the sweep reaches it (500 per tick), never repeated.
--
-- The function is replaced in place; the trigger (004) keeps pointing at it. Down
-- restores 004's body verbatim.

-- migrate:up

CREATE OR REPLACE FUNCTION fire_events_seq_discipline() RETURNS trigger
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
         OLD.related_event_id, OLD.relation_kind, OLD.started_at, OLD.last_detection_at,
         OLD.static_source_verdict)
     IS DISTINCT FROM
     ROW(NEW.status, NEW.status_reason, NEW.status_changed_at, NEW.display_tier,
         NEW.inactive_since, NEW.merged_into, NEW.invalidated, NEW.needs_review,
         NEW.centroid, NEW.hull, NEW.hull_diameter_km, NEW.detection_count,
         NEW.max_frp_mw, NEW.score, NEW.source_mix, NEW.nearest_place,
         NEW.related_event_id, NEW.relation_kind, NEW.started_at, NEW.last_detection_at,
         NEW.static_source_verdict)
  THEN
    NEW.seq := nextval('fire_events_seq_seq');
  END IF;

  RETURN NEW;
END;
$$;

COMMENT ON COLUMN fire_events.static_source_verdict IS
  'Latest static hot-source verdict (TASKS F16, static-source-policy.ts); NULL = never evaluated. Projected on the snapshot (additive, A1.3): a change bumps seq (023).';

-- migrate:down

CREATE OR REPLACE FUNCTION fire_events_seq_discipline() RETURNS trigger
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

COMMENT ON COLUMN fire_events.static_source_verdict IS
  'Latest static hot-source verdict (TASKS F16, static-source-policy.ts); NULL = never evaluated. Bookkeeping: never bumps seq.';
