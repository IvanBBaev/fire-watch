-- Migration 001 — initial schema.
--
-- This file is the ONE schema owner (review 13 §3.2(11), C7). The DDL blocks in
-- docs/reviews/02-backend.md §5.8 and docs/reviews/03-geodata.md are non-normative
-- sketches that predate ADR-002; where they disagree with this file, this file wins.
-- TypeScript types are generated from the migrated database by kysely-codegen and are
-- the only import path — no hand-written row interfaces anywhere.
--
-- Normative sources: ADR-002 (identity, three-layer model, lifecycle, replay),
-- ADR-004 (outbox, alert state, retention), GLOSSARY §1a/§1b/§3.
--
-- Conventions fixed here and not repeated per table:
--   * Everything geometric is stored in SRID 4326 and cast to `geography` for metric
--     predicates (ST_DWithin in metres is correct at Balkan latitudes). 3857 exists
--     only in tile and URL space, never in the database.
--   * Timestamps are `timestamptz`. The wall clock is injected as a port in the
--     application (ADR-002 D7 determinism), so `now()` defaults appear only on
--     bookkeeping columns that replay never reads.
--   * ODbL containment (ADR-002 A1.2): no OSM element identifier — node, way or
--     relation id — may exist on any table here or on anything derived from them. A
--     column named `osm_*` or `*_osm_id` is a review defect, not a style preference.

-- migrate:up

CREATE EXTENSION IF NOT EXISTS postgis;

-- ── roles ───────────────────────────────────────────────────────────────────────
-- `fire_watch_app` is the runtime role: it may append to the archive but never
-- rewrite it. Migrations, retention and erasure jobs run as the schema owner, which
-- is a different login. Roles are cluster-scoped, so creation is guarded rather than
-- IF NOT EXISTS (which CREATE ROLE does not support).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'fire_watch_app') THEN
    CREATE ROLE fire_watch_app NOLOGIN;
  END IF;
END
$$;

-- ── backup classification ───────────────────────────────────────────────────────
-- OPERATIONS §6.2 rules 5-6: the nightly job writes two artifacts from one exported
-- snapshot, and generates its `--exclude-table-data` arguments from this registry
-- rather than from a hand-maintained deny list. A table with no row here is treated
-- as `personal` and fails CI — fail-closed, because the failure mode of a forgotten
-- classification is a personal table riding silently into the 56-day main artifact,
-- where it breaches the ADR-004 A1.3 30-day cap and looks perfectly healthy doing it.
CREATE TABLE table_backup_class (
  table_name text PRIMARY KEY,
  -- 'main'     — cannot identify a recipient; 14 daily + 8 weekly.
  -- 'personal' — alert-path personal data; 28 daily, no weeklies, lifecycle-expired.
  class      text NOT NULL CHECK (class IN ('main', 'personal')),
  note       text
);

-- ── source registry projection ──────────────────────────────────────────────────
-- The frozen registry (GLOSSARY §1a) lives in packages/contracts/src/sources.ts and
-- is its own owner: these strings are permanent hash inputs, so they can never be
-- renamed or re-cased. This table is a projection of it, seeded below, existing only
-- so `detections.source` can carry a foreign key. Parity between the two is asserted
-- by an integration test — drift is a test failure, never a silent divergence.
CREATE TABLE sources (
  id            text PRIMARY KEY,
  queried_product text NOT NULL,
  product_tier  text CHECK (product_tier IN ('NRT', 'GEO')),
  status        text NOT NULL CHECK (status IN ('active', 'retired')),
  -- Replay reconstructs the constellation as it was, not as it is (ADR-002 A2.3).
  status_effective_from date NOT NULL,
  -- GEO sources attach to existing clusters; they never create or merge events.
  attach_only   boolean NOT NULL
);

INSERT INTO sources (id, queried_product, product_tier, status, status_effective_from, attach_only) VALUES
  ('firms:viirs:snpp',        'VIIRS_SNPP_NRT',   'NRT', 'active',  '2026-08-02', false),
  ('firms:viirs:noaa20',      'VIIRS_NOAA20_NRT', 'NRT', 'active',  '2026-08-02', false),
  ('firms:viirs:noaa21',      'VIIRS_NOAA21_NRT', 'NRT', 'active',  '2026-08-02', false),
  ('firms:modis',             'MODIS_NRT',        NULL,  'retired', '2026-08-02', false),
  ('eumetsat:slstr:frp',      'SL_2_FRP___',      'NRT', 'active',  '2026-08-02', false),
  ('lsasaf:seviri:frp-pixel', 'LSA-502',          'GEO', 'active',  '2026-08-02', true),
  ('lsasaf:fci:frp-pixel',    'LSA-509',          'GEO', 'active',  '2026-08-02', true);

-- Per-source polling health. This is the freshness surface (OPERATIONS §2.1) and the
-- input to the per-source outage freeze of the miss-evidence accumulator (A2.3) —
-- the freeze is per source and never global, so the state has to be per source too.
CREATE TABLE source_status (
  source               text PRIMARY KEY REFERENCES sources (id),
  last_attempt_at      timestamptz,
  last_success_at      timestamptz,
  -- Distinct from last_success_at on purpose: a poll that succeeds and returns zero
  -- rows is healthy, and conflating the two makes an empty season look like an outage.
  last_data_at         timestamptz,
  consecutive_failures integer NOT NULL DEFAULT 0,
  last_error           text,
  -- While true the source contributes no expected overpasses to the E-accumulator.
  outage_frozen        boolean NOT NULL DEFAULT false,
  updated_at           timestamptz NOT NULL DEFAULT now()
);

-- ── detections: append-only archive, monthly partitions ─────────────────────────
-- Layer 1 of ADR-002 D1. Rows are never updated in place: the upsert is DO NOTHING
-- (A1.1), so a re-polled row carrying a refined confidence class, processing version,
-- brightness or FRP is deliberately discarded. A mutable detection row would make
-- replay non-deterministic and would silently rewrite the evidence behind alerts that
-- were already sent.
--
-- Partitioning is not a scale decision — it is what makes the NRT→SP promotion of
-- ADR-002 D7/A1.4 possible at all. SP reprocessing shifts coordinates, and lat/lon are
-- hash inputs, so NRT and SP uids for "the same" observation differ by construction and
-- can never be aligned row by row. Whole months are staged and swapped instead.
CREATE TABLE detections (
  -- lowercase-hex sha256 over `source | acq_ts_iso | lat_5dp | lon_5dp` (GLOSSARY §1b).
  detection_uid   text NOT NULL CHECK (detection_uid ~ '^[0-9a-f]{64}$'),
  source          text NOT NULL REFERENCES sources (id),
  -- 'SP' appears only on rows loaded by a D7 promotion; live polling writes NRT or GEO.
  product_tier    text NOT NULL CHECK (product_tier IN ('NRT', 'SP', 'GEO')),
  -- Acquisition instant, truncated to the minute — this is a hash input, so it is
  -- stored exactly as it was hashed. Canonicalization is enforced in the ingest path
  -- by packages/contracts, which is the only writer.
  acq_ts          timestamptz NOT NULL,
  -- When the row became visible to us. Fixes batch ordering (ADR-002 D7) and is the
  -- honest basis for latency measurement; it is not derivable from acq_ts.
  available_at    timestamptz NOT NULL,
  ingested_at     timestamptz NOT NULL DEFAULT now(),

  -- Coordinates exactly as hashed: 5 fraction digits, rounded half away from zero.
  -- numeric round-trips those decimals exactly, which double precision does not.
  lat             numeric(8, 5) NOT NULL CHECK (lat BETWEEN -90 AND 90),
  lon             numeric(8, 5) NOT NULL CHECK (lon BETWEEN -180 AND 180),
  -- Generated, never supplied: the geometry cannot drift from the hashed coordinates.
  geom            geometry(Point, 4326)
                  GENERATED ALWAYS AS (
                    ST_SetSRID(ST_MakePoint(lon::double precision, lat::double precision), 4326)
                  ) STORED,

  -- Pixel footprint. MVP logic uses points only, but these are unrecoverable if not
  -- captured at ingest and are required for GEO/FCI fusion later (ADR-002 D1).
  scan_km         real,
  track_km        real,
  footprint       geometry(Polygon, 4326),

  frp_mw          real,
  brightness_k    real,
  brightness_bg_k real,
  -- The provider's own string, kept verbatim for audit; `confidence` is our mapping.
  confidence_raw  text NOT NULL,
  confidence      text NOT NULL CHECK (confidence IN ('low', 'nominal', 'high')),
  day_night       char(1) CHECK (day_night IN ('D', 'N')),
  -- Provider collection/processing version, e.g. FIRMS `version`. Informational only:
  -- a later version of the same observation is discarded by A1.1, not merged in.
  collection_version text,

  -- Which frozen registry and which polling-bbox config produced this row. Replay
  -- reads these instead of assuming today's configuration (ADR-002 D5).
  source_registry_version text NOT NULL,
  ingest_config_version   text NOT NULL,

  -- The partition key must be part of every unique constraint, so the conflict target
  -- of the ingest upsert is this pair rather than `detection_uid` alone as ADR-002
  -- A1.1 phrases it. The two are equivalent in practice: acq_ts is itself a hash
  -- input, so a given uid can only ever arrive with one acq_ts.
  PRIMARY KEY (acq_ts, detection_uid)
) PARTITION BY RANGE (acq_ts);

COMMENT ON TABLE detections IS
  'Append-only. INSERT ... ON CONFLICT (acq_ts, detection_uid) DO NOTHING is the only '
  'write; UPDATE and DELETE are not granted to the runtime role (ADR-002 D1/A1.1).';

-- One partition per UTC month. Kept as a function because the maintenance job creates
-- future months and the SP promotion of D7 stages a replacement for a single month.
CREATE FUNCTION fw_ensure_detections_partition(p_month date)
RETURNS text
LANGUAGE plpgsql
AS $$
DECLARE
  v_start date := date_trunc('month', p_month)::date;
  v_end   date := (date_trunc('month', p_month) + interval '1 month')::date;
  v_name  text := format('detections_%s', to_char(v_start, 'YYYY_MM'));
BEGIN
  IF to_regclass(format('public.%I', v_name)) IS NULL THEN
    EXECUTE format(
      'CREATE TABLE %I PARTITION OF detections FOR VALUES FROM (%L) TO (%L)',
      v_name, v_start, v_end
    );
  END IF;
  RETURN v_name;
END
$$;

-- No DEFAULT partition on purpose. A default partition would silently swallow rows
-- with an out-of-range acq_ts — exactly the corrupt-timestamp case we want to fail on
-- — and it forces a full scan of the default on every future ATTACH, which is the one
-- operation the D7 month swap depends on being fast.
--
-- The range covers the 2020–2025 FIRMS backfill (task B8) through the end of 2027.
DO $$
DECLARE
  m date := date '2020-01-01';
BEGIN
  WHILE m < date '2028-01-01' LOOP
    PERFORM fw_ensure_detections_partition(m);
    m := (m + interval '1 month')::date;
  END LOOP;
END
$$;

CREATE INDEX detections_geom_gist ON detections USING gist (geom);
CREATE INDEX detections_source_acq_ts ON detections (source, acq_ts DESC);
-- Batch ordering for deterministic replay: (available_at, source, lat, lon) with
-- detection_uid as the tiebreak (ADR-002 D7).
CREATE INDEX detections_batch_order ON detections (available_at, source, lat, lon, detection_uid);

-- ── clustering runs ─────────────────────────────────────────────────────────────
-- Every assignment of detections to events belongs to a run. The live pipeline has
-- one long-lived run; offline re-clustering (a D7 promotion, a parameter refit) opens
-- its own and never overwrites the live assignment until it is promoted.
CREATE TABLE clustering_runs (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  kind         text NOT NULL CHECK (kind IN ('live', 'offline')),
  -- The exact versioned parameter set this run used (ADR-002 D5), plus its digest so
  -- a replay can prove it read the same configuration rather than today's.
  config_version text NOT NULL,
  config_digest  text NOT NULL,
  params       jsonb NOT NULL DEFAULT '{}'::jsonb,
  window_start timestamptz,
  window_end   timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  promoted_at  timestamptz,
  -- Offline runs emit zero alerts (ADR-002 I4); reviving an archived event needs an
  -- explicit --allow-revive. Recorded so an audit can tell a revive from a bug.
  allow_revive boolean NOT NULL DEFAULT false
);

-- ── fire_events: the public registry ────────────────────────────────────────────
-- Layer 3 of ADR-002 D1. The primary key is an internal bigint; `public_id` is an
-- API-layer identity that must resolve forever (I1), including after a merge.

-- Global monotonic sequence shared by every event transition. One sequence, not one
-- per event, because the read path compares seq across events and derives a single
-- ETag from the global maximum.
CREATE SEQUENCE fire_events_seq_seq AS bigint START 1;

CREATE TABLE fire_events (
  id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  -- Shape only. The base32 alphabet is chosen and frozen in packages/contracts, which
  -- mints the id; putting the alphabet in a CHECK would give the constraint a second
  -- owner. The `<year>` segment is the mint year and is cosmetic: no query, route,
  -- partition or sort may parse it, and it is never corrected (A2.1).
  public_id         text NOT NULL UNIQUE CHECK (public_id ~ '^fw-[0-9]{4}-[0-9a-z]{5}$'),

  -- The lifecycle states of ADR-002 D6 and GLOSSARY §3, and no others. The word
  -- "out" does not appear in this schema, the API, or the UI. The two officially_*
  -- states are curated-only and, since A2.2, not terminal: a re-detection within
  -- T_LINK returns the event to `active` as an escalation, never as a new fire.
  status            text NOT NULL CHECK (status IN (
                      'active',
                      'signal_weakening',
                      'no_longer_detected',
                      'archived',
                      'officially_contained',
                      'officially_extinguished'
                    )),
  -- Why the current status was entered, where the reason is not self-evident:
  -- 'unobservable' (A2.3 cloud-blind close), 'superseded_by_sp' (D7 promotion).
  status_reason     text,
  status_changed_at timestamptz NOT NULL,

  -- Every set-membership change is a status transition that bumps `seq` (ADR-003
  -- A1.4). Snapshot and delta consumers upsert iff the incoming seq is newer, and the
  -- ETag derives from the global maximum — so `seq` may never be recycled or reordered.
  -- The default covers the insert; every subsequent transition must assign nextval
  -- explicitly, because an UPDATE that changes the set without bumping seq is
  -- invisible to every delta consumer.
  seq               bigint NOT NULL DEFAULT nextval('fire_events_seq_seq'),

  started_at        timestamptz NOT NULL,
  last_detection_at timestamptz NOT NULL,

  centroid          geometry(Point, 4326) NOT NULL,
  hull              geometry(Polygon, 4326),
  hull_diameter_km  real,
  -- Set when the hull diameter exceeds 20 km: a plausible over-merge that a human
  -- looks at. Splits are curated only (ADR-002 D4) — nothing splits automatically.
  needs_review      boolean NOT NULL DEFAULT false,

  detection_count   integer NOT NULL DEFAULT 0,
  max_frp_mw        real,
  sum_frp_mw        real,
  -- Bounded logistic P(real fire | evidence). Buckets: Confirmed >= 0.75,
  -- Likely 0.45-0.75, Unverified < 0.45 (ADR-002 D6).
  score             real NOT NULL DEFAULT 0 CHECK (score BETWEEN 0 AND 1),
  source_mix        jsonb NOT NULL DEFAULT '{}'::jsonb,

  -- A hard override (static-source mask, water/glint guard) zeroes the score and
  -- marks the event invalid. This is a flag, not a lifecycle state, because D6 fixes
  -- the state list exhaustively; an invalidated event keeps its id and its history.
  invalidated       boolean NOT NULL DEFAULT false,
  invalidated_reason text,

  -- Name and coordinates only. Storing the settlement's OSM element id here is what
  -- A1.2 forbids: it is the database key reference that would stop our registry and
  -- OSM being a mere collective database.
  nearest_place     jsonb,

  -- Merge tombstone. The survivor is min by (started_at, -detection_count, id); losers
  -- keep resolving and the API answers 200 with `mergedInto`, never 404 (I1/D3).
  merged_into       bigint REFERENCES fire_events (id),
  -- Curated split provenance (D4) and the non-causal reignition link (D2). The copy
  -- says "possible reignition of <event>" and never asserts causality.
  split_from        bigint REFERENCES fire_events (id),
  related_event_id  bigint REFERENCES fire_events (id),
  relation_kind     text CHECK (relation_kind IN ('possible_reignition', 'continuation')),

  -- Miss-evidence accumulator E: weighted clear-sky missed overpasses driving the
  -- transition to no_longer_detected. Frozen per source during that source's outage.
  miss_evidence     real NOT NULL DEFAULT 0,

  -- The configuration that produced this event's current state, recorded on the row
  -- so a replay is checkable and an alert can name the rules that fired (D5).
  config_version    text NOT NULL,
  source_registry_version text NOT NULL,

  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),

  -- A tombstone points at a different event, and a chain is resolved with path
  -- compression; a self-reference would make that resolution non-terminating.
  CONSTRAINT fire_events_merged_into_not_self CHECK (merged_into IS DISTINCT FROM id),
  CONSTRAINT fire_events_split_from_not_self CHECK (split_from IS DISTINCT FROM id),
  CONSTRAINT fire_events_related_not_self CHECK (related_event_id IS DISTINCT FROM id),
  CONSTRAINT fire_events_relation_kind_needs_target
    CHECK ((relation_kind IS NULL) = (related_event_id IS NULL))
);

CREATE UNIQUE INDEX fire_events_seq_uniq ON fire_events (seq);
CREATE INDEX fire_events_hull_gist ON fire_events USING gist (hull);
CREATE INDEX fire_events_centroid_gist ON fire_events USING gist (centroid);
CREATE INDEX fire_events_status_last_detection ON fire_events (status, last_detection_at DESC);
-- The active feed excludes tombstones; they stay resolvable by permalink.
CREATE INDEX fire_events_live ON fire_events (last_detection_at DESC) WHERE merged_into IS NULL;
CREATE INDEX fire_events_merged_into ON fire_events (merged_into) WHERE merged_into IS NOT NULL;
CREATE INDEX fire_events_needs_review ON fire_events (updated_at DESC) WHERE needs_review;

-- ── clusters: the working set ───────────────────────────────────────────────────
-- Layer 2 of ADR-002 D1: the spatio-temporal working set the incremental algorithm
-- maintains over the trailing window. Clusters have no public identity, may be
-- rebuilt from detections at any time, and are NEVER exposed in the API. Persisted
-- only so the incremental state survives a restart of the single writer.
CREATE TABLE clusters (
  id                 bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  clustering_run_id  bigint NOT NULL REFERENCES clustering_runs (id) ON DELETE CASCADE,
  -- NULL until the cluster is promoted to a registry row.
  fire_event_id      bigint REFERENCES fire_events (id),
  centroid           geometry(Point, 4326) NOT NULL,
  hull               geometry(Polygon, 4326),
  first_detection_at timestamptz NOT NULL,
  last_detection_at  timestamptz NOT NULL,
  detection_count    integer NOT NULL DEFAULT 0,
  updated_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX clusters_run ON clusters (clustering_run_id, last_detection_at DESC);
CREATE INDEX clusters_centroid_gist ON clusters USING gist (centroid);

-- ── event ↔ detection assignment ────────────────────────────────────────────────
-- Append-only, and scoped to a run so an offline re-clustering can be computed and
-- diffed before it is promoted (ADR-002 D7 step 4). Promotion writes the new run's
-- rows; it never rewrites an old run's.
CREATE TABLE event_detections (
  clustering_run_id bigint NOT NULL REFERENCES clustering_runs (id),
  fire_event_id     bigint NOT NULL REFERENCES fire_events (id),
  detection_uid     text NOT NULL,
  -- Carried so the row can find its detection without scanning every partition.
  acq_ts            timestamptz NOT NULL,
  attached_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (clustering_run_id, fire_event_id, detection_uid),
  FOREIGN KEY (acq_ts, detection_uid) REFERENCES detections (acq_ts, detection_uid)
);

CREATE INDEX event_detections_by_detection ON event_detections (clustering_run_id, detection_uid);
CREATE INDEX event_detections_by_event ON event_detections (fire_event_id, acq_ts DESC);

-- ── accounts, zones and channels ────────────────────────────────────────────────
-- Frozen contract, nothing writes to these before WP6. They hold the only personal
-- data in the system, which is why erasure and retention rules attach here.
CREATE TABLE accounts (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Quiet hours are classified from the decision instant through the tz database,
  -- never from a naive local string (ADR-004 A1.7).
  timezone     text NOT NULL DEFAULT 'Europe/Sofia',
  quiet_hours_start time NOT NULL DEFAULT '22:00',
  quiet_hours_end   time NOT NULL DEFAULT '07:00',
  -- User-changeable; new_fire overrides quiet hours by default.
  new_fire_overrides_quiet_hours boolean NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now(),
  deleted_at   timestamptz
);

CREATE TABLE channel_subscriptions (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  channel    text NOT NULL CHECK (channel IN ('push', 'telegram', 'email')),
  -- Provider endpoint reference. Personal data: nulled at pseudonymization (A1.3),
  -- and pruned on a permanent provider error or a 410 (ADR-004 D2).
  endpoint   text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz
);

CREATE INDEX channel_subscriptions_live ON channel_subscriptions (account_id) WHERE revoked_at IS NULL;

CREATE TABLE watch_zones (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id     uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  name           text NOT NULL,
  -- Point-with-radius or polygon. Stored as geography because every predicate on it
  -- is metric. Point centres are coarsened to ~1 km before they are stored.
  area           geography(Geometry, 4326) NOT NULL,
  -- Minimum 2 km, unconditional (ADR-004 A1.10): the centre is stored approximately,
  -- so a smaller radius would alert on the wrong ground and state a distance the
  -- coarsening already destroyed. NULL for polygon zones.
  radius_m       integer CHECK (radius_m IS NULL OR radius_m BETWEEN 2000 AND 30000),
  -- Per-zone alert floor: default gate is score >= 0.45, opt-in down to 0.30 (D4).
  min_score      real NOT NULL DEFAULT 0.45 CHECK (min_score BETWEEN 0 AND 1),
  created_at     timestamptz NOT NULL DEFAULT now(),
  deleted_at     timestamptz
);

CREATE INDEX watch_zones_area_gist ON watch_zones USING gist (area);
CREATE INDEX watch_zones_live ON watch_zones (account_id) WHERE deleted_at IS NULL;

-- ── alert state and outbox ──────────────────────────────────────────────────────
-- One state row per (zone, event) — ADR-004 D3. A merge survivor inherits the
-- most-advanced state of all its parents per zone inside the merge transaction, so a
-- merge can never produce a second "new fire" for a zone already notified.
CREATE TABLE alert_states (
  watch_zone_id  uuid NOT NULL REFERENCES watch_zones (id) ON DELETE CASCADE,
  fire_event_id  bigint NOT NULL REFERENCES fire_events (id),
  state          text NOT NULL CHECK (state IN (
                   'none', 'notified_new', 'notified_escalation', 'cooldown'
                 )),
  -- Highest escalation ladder step ever notified. An escalation is decided only when
  -- the current step is strictly greater, and the watermark never decreases — that is
  -- what stops score oscillation from re-alerting (ADR-004 A1.11).
  escalation_watermark integer NOT NULL DEFAULT 0,
  -- Set when the state was seeded at zone creation for a fire that already existed:
  -- state advances to notified_new with no outbox row and zero sends (A1.8).
  seeded_at      timestamptz,
  last_notified_at timestamptz,
  updated_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (watch_zone_id, fire_event_id)
);

CREATE INDEX alert_states_by_event ON alert_states (fire_event_id);

-- The transactional outbox (ADR-004 D1). An alert decision is written in the same
-- transaction as the state change that triggered it; nothing sends synchronously, and
-- one module — the notification gateway — is the only consumer.
CREATE TABLE alert_outbox (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  watch_zone_id uuid NOT NULL REFERENCES watch_zones (id),
  fire_event_id bigint NOT NULL REFERENCES fire_events (id),
  -- There is no 'resolved' or 'safe' type and there never will be: a false all-clear
  -- is the single most harmful thing this system could send (ADR-004 D4).
  alert_type    text NOT NULL CHECK (alert_type IN ('new_fire', 'escalation', 'digest')),
  -- The idempotency subkey: constant for new_fire (at most once, ever), the ladder
  -- step for escalation, the window start for a digest (A1.11).
  alert_subkey  text NOT NULL,

  -- Provenance, all four mandatory — the gateway refuses a row missing any of them.
  trigger_ref_seq bigint NOT NULL,
  rule_version  text NOT NULL,
  template_id   text NOT NULL,
  -- Bound parameters, never a rendered body: pseudonymization has to be able to drop
  -- the zone-derived ones and keep the rest (A1.3).
  template_params jsonb NOT NULL DEFAULT '{}'::jsonb,

  channel       text NOT NULL CHECK (channel IN ('push', 'telegram', 'email')),
  channel_subscription_id uuid REFERENCES channel_subscriptions (id),
  -- Queue class; lower sorts first. Priority reorders the queue and never raises a
  -- ceiling — B, G, the token buckets and the breakers all apply after ordering.
  priority      integer NOT NULL DEFAULT 100,
  -- Rank in decision order, computed once inside the decision transaction. Ranks
  -- <= B release automatically; the rest wait for approval. Storing it is what makes
  -- the cutoff reproducible from the rows alone in replay and audit (A1.12).
  budget_seq    integer,

  status        text NOT NULL CHECK (status IN (
                  'pending',
                  'awaiting_approval',
                  'claimed',
                  'sent',
                  'failed',
                  -- Set in the same transaction as account or zone deletion, and by
                  -- the gateway's liveness re-check immediately before a provider
                  -- call. Retained pseudonymized as evidence the send was stopped.
                  'cancelled_erasure',
                  'expired_unapproved',
                  'ttl_expired'
                )),
  -- Operator accountability trail. approval_mode 'solo_cooloff' additionally requires
  -- approved_at - decided_at >= 900 s (A1.4). Kept verbatim at pseudonymization:
  -- this is an employment record, not user data.
  approval_mode text CHECK (approval_mode IN ('two_person', 'solo_cooloff')),
  approver_id   text,
  approved_at   timestamptz,

  decided_at    timestamptz NOT NULL DEFAULT now(),
  dispatched_at timestamptz,
  provider_ack_at timestamptz,
  last_error    text,

  -- Full fidelity for 24 months from decided_at, then rewritten in place — never
  -- deleted — and kept until 5 years (A1.3). Erasure runs it immediately instead.
  pseudonymized_at timestamptz,

  -- THE anti-spam invariant. The same alert type can be decided at most once per zone
  -- per event, ever; the subkey generalizes it to the escalation ladder (D3, A1.11).
  UNIQUE (watch_zone_id, fire_event_id, alert_type, alert_subkey)
);

CREATE INDEX alert_outbox_dispatch_queue ON alert_outbox (priority, decided_at, id)
  WHERE status = 'pending';
CREATE INDEX alert_outbox_awaiting ON alert_outbox (decided_at)
  WHERE status = 'awaiting_approval';
CREATE INDEX alert_outbox_by_event ON alert_outbox (fire_event_id, decided_at DESC);
CREATE INDEX alert_outbox_retention ON alert_outbox (decided_at) WHERE pseudonymized_at IS NULL;

-- Classification of every table created above. The four `personal` tables are the
-- ones that can identify a recipient; `alert_outbox` is personal in full fidelity and
-- travels in the main artifact only as the pseudonymized projection of §6.2 rule 7.
INSERT INTO table_backup_class (table_name, class, note) VALUES
  ('table_backup_class',     'main',     'the registry itself'),
  ('sources',                'main',     null),
  ('source_status',          'main',     null),
  ('detections',             'main',     'append-only archive; no personal data by construction'),
  ('clustering_runs',        'main',     null),
  ('fire_events',            'main',     'public registry'),
  ('clusters',               'main',     'ephemeral working set'),
  ('event_detections',       'main',     null),
  ('accounts',               'personal', null),
  ('channel_subscriptions',  'personal', 'provider endpoints'),
  ('watch_zones',            'personal', 'coarsened centre is still personal data'),
  ('alert_states',           'personal', 'keyed by zone'),
  ('alert_outbox',           'personal', 'main set carries the pseudonymized projection instead');

-- ── grants ──────────────────────────────────────────────────────────────────────
-- The append-only guarantee is a grant, not a convention. `detections` and
-- `event_detections` are the archive: the runtime role may add to them and may never
-- rewrite or remove anything. Retention and erasure jobs are a different login,
-- because "the process that sends alerts cannot delete its own evidence" is the point.
GRANT USAGE ON SCHEMA public TO fire_watch_app;

GRANT SELECT, INSERT ON detections, event_detections TO fire_watch_app;
GRANT SELECT ON sources, table_backup_class TO fire_watch_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON
  source_status, clustering_runs, fire_events, clusters,
  accounts, channel_subscriptions, watch_zones, alert_states
  TO fire_watch_app;
-- No DELETE: an outbox row is the audit trail of a decision, and A1.3 rewrites it in
-- place rather than removing it.
GRANT SELECT, INSERT, UPDATE ON alert_outbox TO fire_watch_app;

GRANT USAGE ON SEQUENCE fire_events_seq_seq TO fire_watch_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO fire_watch_app;
GRANT EXECUTE ON FUNCTION fw_ensure_detections_partition(date) TO fire_watch_app;

-- migrate:down

DROP TABLE IF EXISTS alert_outbox;
DROP TABLE IF EXISTS alert_states;
DROP TABLE IF EXISTS watch_zones;
DROP TABLE IF EXISTS channel_subscriptions;
DROP TABLE IF EXISTS accounts;
DROP TABLE IF EXISTS event_detections;
DROP TABLE IF EXISTS clusters;
DROP TABLE IF EXISTS fire_events CASCADE;
DROP SEQUENCE IF EXISTS fire_events_seq_seq;
DROP TABLE IF EXISTS clustering_runs;
-- CASCADE takes the monthly partitions with it.
DROP TABLE IF EXISTS detections CASCADE;
DROP FUNCTION IF EXISTS fw_ensure_detections_partition(date);
DROP TABLE IF EXISTS source_status;
DROP TABLE IF EXISTS table_backup_class;
DROP TABLE IF EXISTS sources;

-- Revoke what this migration granted, but leave the role in place. Roles are
-- cluster-scoped, not database-scoped: dropping one is not the inverse of creating it
-- when another database in the same cluster may be using it. The guarded CREATE ROLE
-- above is idempotent, so up/down/up is clean without the drop. Revoking is still
-- required — a lingering grant on schema public would otherwise survive a down.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'fire_watch_app') THEN
    REVOKE ALL ON SCHEMA public FROM fire_watch_app;
  END IF;
END
$$;

-- postgis is deliberately not dropped, for the same reason. `CREATE EXTENSION IF NOT
-- EXISTS` above is a no-op when the extension is already installed, so dropping it
-- here would not be the inverse of anything this migration did — it would remove
-- infrastructure the database may share with something else.
