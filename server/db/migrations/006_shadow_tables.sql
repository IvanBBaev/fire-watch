-- Migration 006 — the shadow tables (TASKS H8; IP WP6; 06 §5.7; GATES L-1).
--
-- A candidate rule set — a new clustering, scoring or gating config — "runs in parallel on
-- the same detection stream and writes to the shadow tables; it never dispatches" (06
-- §5.7). The nightly diff (`app/shadow-diff-cli.ts`) reads these beside the live tables
-- and reports every difference; L-1 promotes the candidate only when every one of them is
-- explained.
--
--   `events_shadow` — what the candidate concluded about each fire. Keyed by the
--                     candidate's own event key, not a `fire_events.id`: a candidate mints
--                     its own identities, and pairing them with live ones is the diff's
--                     job (ADR-002 D7 step 5, detection-set Jaccard). The member detection
--                     uids are an array on the row rather than rows in `event_detections`,
--                     because that table's foreign key to `fire_events` is exactly what a
--                     shadow event is not, and the diff reads the set whole.
--   `alerts_shadow` — the outbox rows the candidate *would* have written: the A1.11
--                     idempotency key and the provenance D1 makes mandatory, and nothing
--                     about channels, queueing or approval, because nothing here is ever
--                     queued. This is also the zone's "what you would have received" log
--                     for the beta UI (07 §5.5.2).
--
-- Every row carries `candidate_version`, so two candidates can shadow side by side and a
-- finished shadow's rows stay attributable after the next one starts.
--
-- Backup class: `events_shadow` is `main` (no personal data — the same facts as
-- `fire_events`); `alerts_shadow` is keyed by zone, so it is `personal`, exactly like
-- `alert_states`. The foreign keys point personal → main and personal → personal only.
--
-- Grants: the runtime role writes both and deletes neither. The candidate re-derives an
-- event on every tick, so `events_shadow` takes UPDATE; `alerts_shadow` is the evidence the
-- diff is reviewed against and is append-only, like the outbox's decision record. Erasure
-- still reaches it: the zone foreign key cascades, and a referential action runs as the
-- table owner, not as the role that deleted the zone. No identity column, so no sequence
-- grant — both tables are keyed by natural identities.

-- migrate:up

CREATE TABLE events_shadow (
  -- The candidate's `config_version` (ADR-002 D5), e.g. `clustering_params_v2`.
  candidate_version        text NOT NULL CHECK (candidate_version ~ '^[a-z0-9_]+_v[0-9]+$'),
  -- The candidate's own event key. Never a public id: nothing outside the diff ever sees it.
  shadow_key               text NOT NULL CHECK (shadow_key <> ''),
  -- The digest of the parameters that produced the row, so a candidate edited in place
  -- during its shadow is visible in the data rather than hidden behind a version string.
  candidate_config_digest  text NOT NULL,
  -- The same vocabulary as `fire_events.status` (migration 001).
  status                   text NOT NULL CHECK (status IN (
                             'active',
                             'signal_weakening',
                             'no_longer_detected',
                             'archived',
                             'officially_contained',
                             'officially_extinguished'
                           )),
  started_at               timestamptz NOT NULL,
  last_detection_at        timestamptz NOT NULL,
  score                    real NOT NULL CHECK (score BETWEEN 0 AND 1),
  invalidated              boolean NOT NULL DEFAULT false,
  -- The survivor, when this event is a merge tombstone in the candidate's own history.
  merged_into_key          text,
  -- Sorted, distinct `detection_uid`s. Sorted by the writer so equal sets are equal arrays.
  detection_uids           text[] NOT NULL CHECK (cardinality(detection_uids) >= 1),
  recorded_at              timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (candidate_version, shadow_key),
  CONSTRAINT events_shadow_detection_order CHECK (last_detection_at >= started_at),
  CONSTRAINT events_shadow_merged_into_not_self CHECK (merged_into_key IS DISTINCT FROM shadow_key),
  FOREIGN KEY (candidate_version, merged_into_key)
    REFERENCES events_shadow (candidate_version, shadow_key)
    DEFERRABLE INITIALLY DEFERRED
);

-- The diff's window predicate: `last_detection_at >= from AND started_at < to`.
CREATE INDEX events_shadow_window ON events_shadow (candidate_version, last_detection_at);

CREATE TABLE alerts_shadow (
  candidate_version  text NOT NULL,
  -- Cascades: a deleted zone takes its would-have-been alerts with it (see the header).
  watch_zone_id      uuid NOT NULL REFERENCES watch_zones (id) ON DELETE CASCADE,
  shadow_event_key   text NOT NULL,
  -- The alert_outbox vocabulary; still no all-clear type (ADR-004 D4).
  alert_type         text NOT NULL CHECK (alert_type IN ('new_fire', 'escalation', 'digest')),
  alert_subkey       text NOT NULL,
  -- A1.1 provenance minus `manual`: a human-initiated alert is not something a candidate
  -- rule set decides, so a shadow row can only ever be an automatic one.
  trigger_type       text NOT NULL CHECK (trigger_type IN ('new_fire', 'escalation', 'digest')),
  rule_version       text NOT NULL,
  template_id        text NOT NULL,
  -- Bound parameters, never a rendered body — the outbox's rule, for the outbox's reason.
  template_params    jsonb NOT NULL DEFAULT '{}'::jsonb,
  decided_at         timestamptz NOT NULL,
  recorded_at        timestamptz NOT NULL DEFAULT now(),
  -- A1.11's key, scoped to the candidate. Replaying a tick writes nothing new.
  PRIMARY KEY (candidate_version, watch_zone_id, shadow_event_key, alert_type, alert_subkey),
  CONSTRAINT alerts_shadow_trigger_matches_alert CHECK (trigger_type = alert_type),
  FOREIGN KEY (candidate_version, shadow_event_key)
    REFERENCES events_shadow (candidate_version, shadow_key)
);

-- The diff reads a window per candidate; the beta hook reads one zone's window.
CREATE INDEX alerts_shadow_window ON alerts_shadow (candidate_version, decided_at);
CREATE INDEX alerts_shadow_by_zone ON alerts_shadow (watch_zone_id, decided_at);

INSERT INTO table_backup_class (table_name, class, note) VALUES
  ('events_shadow', 'main',     'candidate events; no personal data by construction'),
  ('alerts_shadow', 'personal', 'keyed by zone');

-- ── grants ──────────────────────────────────────────────────────────────────────
GRANT SELECT, INSERT, UPDATE ON events_shadow TO fire_watch_app;
-- No UPDATE, no DELETE: the shadow alert log is the evidence L-1 is reviewed against.
GRANT SELECT, INSERT ON alerts_shadow TO fire_watch_app;

-- migrate:down

DELETE FROM table_backup_class WHERE table_name IN ('events_shadow', 'alerts_shadow');

DROP TABLE IF EXISTS alerts_shadow;
DROP TABLE IF EXISTS events_shadow;
