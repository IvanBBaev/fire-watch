-- Migration 014 — the alert decision log (TASKS H7; 07 §5.5.6 / P17; ADR-004 D1, D4).
--
-- "Why no alert?" needs the reason a decision took, and until now only a `send` left a row
-- that names it (the outbox). A `defer` advanced `alert_states` without saying why, a
-- `suppress` wrote nothing, and neither table carried the `rule_version` that decided.
-- `core/alerts/explain.ts` could therefore rebuild a headline for a send and for a seed
-- (minus its rule version), and for nothing else.
--
-- `alert_decision_log` is one row per (zone, event, trigger seq, pass) decision: the
-- outcome, the reason, the explanation code the pair maps to (`EXPLANATION_BRANCHES`), the
-- alert type and ladder step, whether it fell in quiet hours, and the gating config's
-- version. It is written by the evaluation loop in the same transaction as the state rows,
-- the outbox rows and the cursor (D1), so a decision is logged exactly when it took effect.
-- A group the loop leaves unwritten (a `send` with no delivery target or copy) is not
-- logged, because nothing about it took effect.
--
-- **No facts, no copy.** The row carries codes and the rule version, never the score or a
-- rendered sentence: the raw score never leaves the server (ADR-003 D4), and the facts are
-- re-derivable from the decision's inputs under the named rule version. Whether a coarse
-- fact (the score bucket) should be persisted as well is a founder question.
--
-- **Erasure (migration 010).** The row is keyed by zone and carries no account id, so it
-- is personal data about the zone's owner and is reached the way `alerts_shadow` is: the
-- zone foreign key cascades, and the referential action runs as the table owner, so the
-- table stays append-only for the runtime role. Erasure locks the account's zones FOR
-- UPDATE before deleting them, so an evaluation racing an erasure either commits first
-- (and its rows go with the zone) or fails its foreign-key check.
--
-- Backup class `personal`, exactly like `alert_states` and `alerts_shadow`. The foreign
-- keys point personal → personal (zone) and personal → main (event) only.
--
-- Grants: SELECT and INSERT, no UPDATE, no DELETE — a decision record that could be
-- rewritten would not be evidence. Retention removal goes through
-- `purge_alert_decision_log`, a SECURITY DEFINER function that refuses a missing or future
-- cutoff; its retention is not armed (`core/erasure/purge-plan.ts`).

-- migrate:up

CREATE TABLE alert_decision_log (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  -- Cascades: erasure (and any zone delete) takes the zone's decision history with it.
  watch_zone_id    uuid NOT NULL REFERENCES watch_zones (id) ON DELETE CASCADE,
  fire_event_id    bigint NOT NULL REFERENCES fire_events (id),
  -- `fire_events.seq` the decision was taken at: D1's trigger_ref second half.
  trigger_ref_seq  bigint NOT NULL,
  -- Which pass decided: the evaluation loop, or A1.8's zone-creation seed.
  pass             text NOT NULL CHECK (pass IN ('evaluation', 'zone_creation')),
  outcome          text NOT NULL CHECK (outcome IN ('send', 'defer', 'seed', 'suppress')),
  -- `DECISION_REASONS` (core/alerts/alert-decision.ts).
  reason           text NOT NULL CHECK (reason IN (
                     'first_alert',
                     'ladder_step',
                     'pre_existing_event',
                     'quiet_hours',
                     'suppression_window',
                     'stale_trigger',
                     'quarantined_batch',
                     'invalidated',
                     'geo_only',
                     'insufficient_persistence',
                     'below_zone_threshold',
                     'no_new_ladder_step',
                     'digest_floor',
                     'cooldown',
                     'nearer_zone'
                   )),
  -- `EXPLANATION_CODES` (core/alerts/explain.ts): the renderer's catalog key.
  code             text NOT NULL CHECK (code IN (
                     'sent_first_alert',
                     'sent_ladder_step',
                     'deferred_digest_floor',
                     'deferred_suppression_window',
                     'deferred_stale_trigger',
                     'deferred_quiet_hours',
                     'seeded_pre_existing_event',
                     'suppressed_quarantined_batch',
                     'suppressed_invalidated',
                     'suppressed_geo_only',
                     'suppressed_insufficient_persistence',
                     'suppressed_below_zone_threshold',
                     'suppressed_cooldown',
                     'suppressed_pre_existing_event',
                     'suppressed_no_new_ladder_step',
                     'suppressed_nearer_zone'
                   )),
  -- Set for `send` and `defer` only; still no all-clear type (ADR-004 D4).
  alert_type       text CHECK (alert_type IN ('new_fire', 'escalation')),
  ladder_step      integer NOT NULL CHECK (ladder_step >= 0),
  in_quiet_hours   boolean NOT NULL,
  -- The gating config's `config_version`, e.g. `alert_gating_v1`.
  rule_version     text NOT NULL CHECK (rule_version ~ '^[a-z0-9_]+_v[0-9]+$'),
  decided_at       timestamptz NOT NULL,
  recorded_at      timestamptz NOT NULL DEFAULT now(),
  -- A re-run of the same pass at the same seq writes nothing new.
  CONSTRAINT alert_decision_log_once_per_trigger
    UNIQUE (watch_zone_id, fire_event_id, trigger_ref_seq, pass),
  CONSTRAINT alert_decision_log_type_only_when_typed
    CHECK ((alert_type IS NOT NULL) = (outcome IN ('send', 'defer')))
);

-- "Why no alert?" reads one pair's history, newest first.
CREATE INDEX alert_decision_log_by_pair
  ON alert_decision_log (watch_zone_id, fire_event_id, decided_at);
-- The retention purge walks the oldest rows first.
CREATE INDEX alert_decision_log_by_decided_at ON alert_decision_log (decided_at);

INSERT INTO table_backup_class (table_name, class, note) VALUES
  ('alert_decision_log', 'personal', 'keyed by zone');

CREATE FUNCTION purge_alert_decision_log(cutoff timestamptz, max_rows integer) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  purged integer;
BEGIN
  IF cutoff IS NULL OR cutoff > now() THEN
    RAISE EXCEPTION 'alert decision log purge needs a cutoff in the past'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF max_rows IS NULL OR max_rows < 1 THEN
    RAISE EXCEPTION 'max_rows must be positive' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  DELETE FROM public.alert_decision_log
  WHERE id IN (
    SELECT id FROM public.alert_decision_log
    WHERE decided_at < cutoff
    ORDER BY decided_at
    LIMIT max_rows
  );
  GET DIAGNOSTICS purged = ROW_COUNT;
  RETURN purged;
END
$$;

REVOKE ALL ON FUNCTION purge_alert_decision_log(timestamptz, integer) FROM PUBLIC;

-- ── grants ──────────────────────────────────────────────────────────────────────
-- No UPDATE, no DELETE: the decision log is evidence, like the outbox's decision record.
GRANT SELECT, INSERT ON alert_decision_log TO fire_watch_app;
GRANT USAGE ON SEQUENCE alert_decision_log_id_seq TO fire_watch_app;
GRANT EXECUTE ON FUNCTION purge_alert_decision_log(timestamptz, integer) TO fire_watch_app;

-- migrate:down

DROP FUNCTION IF EXISTS purge_alert_decision_log(timestamptz, integer);
DELETE FROM table_backup_class WHERE table_name = 'alert_decision_log';
DROP TABLE IF EXISTS alert_decision_log;
