-- Migration 005 — what the live identity pipeline needs to persist between polls
-- (ADR-002 D1 layers 2 and 3, D4; TASKS D1/D4 wiring).
--
-- Until this migration the identity engine only ever ran inside the golden replay, where
-- its state lives in memory for the length of one fixture. Running it against the real
-- archive, poll after poll, across restarts of the single writer, needs four facts that
-- 001 had no column for. Each one is here because losing it changes an answer rather than
-- merely costing a recomputation:
--
--   `clustering_batches` — the ledger of which ingest batches (`ingest_batches` is keyed
--                   by `(source, available_at)`, one poll response each) have been
--                   clustered into which run. Without it the pipeline cannot tell "this
--                   batch was clustered and committed" from "this batch arrived after the
--                   last cycle", and the only other candidate for a cursor — the newest
--                   `event_detections.attached_at` — says nothing about a batch that
--                   produced no assignment at all (every row a coarse GEO pixel with no
--                   candidate, or an empty response). Keyed by run so that an offline
--                   re-cluster (D7, SP promotion) keeps its own progress. Append-only for
--                   the runtime role: a ledger row that could be rewritten is not a record
--                   of what happened.
--   `clusters.seed_detection_uid` and `clusters.minted_at` — the two facts a `Cluster`
--                   carries that nothing else in the schema records. Both are frozen at
--                   creation and both are inputs to the public-id minting rule, and the
--                   engine refuses to reconstruct a cluster with a guessed seed. A backfill
--                   is possible for any row that exists (below) and a row it cannot fill
--                   is deleted — `clusters` is the ephemeral working set, rebuildable from
--                   `event_detections`, and no writer produced a row before this migration.
--   The lifecycle carry on `fire_events` — `geo_weight_day`/`geo_weight_spent` (the GEO
--                   miss-weight daily cap, which a tick that only sees its own window
--                   cannot enforce without a carried balance) and
--                   `lifecycle_seen_detection_at` (the newest acquisition the previous tick
--                   knew about; the whole of the redetection test). Without these the live
--                   tick either re-spends a day's GEO budget every poll or reads every poll
--                   as a fresh redetection and never accumulates miss evidence at all.
--                   `miss_evidence` (001) is the third carried value and is widened below.
--   `clustering_runs.lifecycle_ticked_at` — the previous tick's instant, which is the
--                   start of the next evidence window `[since, at)`. Kept on the run
--                   rather than derived from `now() - poll interval` because a missed poll
--                   must widen the next window, not silently drop the passes in the gap.
--
-- `miss_evidence` becomes `double precision`. 001 declared it `real`, which is 24 bits of
-- mantissa: an accumulator around 3.0 is then only representable to about 2.4e-7, and the
-- lifecycle quantises E to 1e-6 (`eQuantum`) before comparing it with the threshold. A
-- value written as 2.9999995 and read back as 3.0000002 crosses a boundary the tick never
-- crossed. The widening is lossless for every value already stored.
--
-- None of the new `fire_events` columns is projected by the snapshot, so the 004 seq
-- trigger deliberately does not list them: a carry is written every tick, and a seq bump
-- there would be a cache miss for every client every tick for nothing the map shows.

-- migrate:up

-- ── the batch ledger ────────────────────────────────────────────────────────────
CREATE TABLE clustering_batches (
  clustering_run_id bigint NOT NULL REFERENCES clustering_runs (id) ON DELETE CASCADE,
  -- The ingest batch, exactly as `ingest_batches` keys it. Not a foreign key to that
  -- table: a batch replayed from the archive by an offline run need not have a verdict
  -- row, and the pair is already the key the detections themselves carry.
  source            text NOT NULL REFERENCES sources (id),
  available_at      timestamptz NOT NULL,
  clustered_at      timestamptz NOT NULL DEFAULT now(),

  -- `ClusterBatchResult.stats`, verbatim: the provenance of "what did this poll do".
  detections        integer NOT NULL CHECK (detections >= 0),
  seeded            integer NOT NULL CHECK (seeded >= 0),
  attached          integer NOT NULL CHECK (attached >= 0),
  merged            integer NOT NULL CHECK (merged >= 0),
  unattached        integer NOT NULL CHECK (unattached >= 0),
  already_assigned  integer NOT NULL CHECK (already_assigned >= 0),

  -- Ordered like the cursor reads it: a run's batches in (available_at, source) order.
  PRIMARY KEY (clustering_run_id, available_at, source)
);

COMMENT ON TABLE clustering_batches IS
  'Append-only ledger of ingest batches clustered into a run; the pending-batch cursor of the live identity pipeline.';
COMMENT ON COLUMN clustering_batches.source IS
  'Source of the ingest batch (ingest_batches key, with available_at).';
COMMENT ON COLUMN clustering_batches.available_at IS
  'available_at of the ingest batch, as stamped on its detections. Also the engine batch instant.';
COMMENT ON COLUMN clustering_batches.clustered_at IS
  'Wall-clock time of the commit that clustered the batch. Operational only; no rule reads it.';
COMMENT ON COLUMN clustering_batches.detections IS
  'ClusterBatchResult.stats.detections: non-quarantined rows handed to the engine.';

-- ── the working set's frozen facts ──────────────────────────────────────────────
ALTER TABLE clusters
  ADD COLUMN seed_detection_uid text,
  ADD COLUMN minted_at timestamptz;

-- The seed is the member that created the cluster, which is not always the earliest one
-- (a later batch can attach an older, late-arriving acquisition) — that is exactly why the
-- engine stores it instead of deriving it. For a row that predates this migration the
-- earliest member in canonical order (acq_ts, then uid) is the best reconstruction
-- available; the minting instant falls back the same way.
UPDATE clusters c
   SET seed_detection_uid = (
         SELECT ed.detection_uid
           FROM event_detections ed
          WHERE ed.clustering_run_id = c.clustering_run_id
            AND ed.fire_event_id = c.fire_event_id
          ORDER BY ed.acq_ts, ed.detection_uid COLLATE "C"
          LIMIT 1
       ),
       minted_at = COALESCE(
         (SELECT fe.created_at FROM fire_events fe WHERE fe.id = c.fire_event_id),
         c.first_detection_at
       );

-- Rows the backfill could not fill have no member to name as a seed, so they are not a
-- cluster the engine could continue. The working set is rebuildable (layer 2); nothing
-- public is lost.
DELETE FROM clusters WHERE seed_detection_uid IS NULL OR minted_at IS NULL;

ALTER TABLE clusters
  ALTER COLUMN seed_detection_uid SET NOT NULL,
  ALTER COLUMN minted_at SET NOT NULL,
  ADD CONSTRAINT clusters_seed_detection_uid_check
    CHECK (seed_detection_uid ~ '^[0-9a-f]{64}$');

COMMENT ON COLUMN clusters.seed_detection_uid IS
  'Detection the cluster was created by; the frozen seed of its public_id. Never changes.';
COMMENT ON COLUMN clusters.minted_at IS
  'Instant the public_id was minted (the engine batch instant). Its UTC year is the cosmetic fw-YYYY.';

-- ── the lifecycle carry ─────────────────────────────────────────────────────────
ALTER TABLE fire_events
  ALTER COLUMN miss_evidence TYPE double precision,
  ADD COLUMN geo_weight_day timestamptz,
  ADD COLUMN geo_weight_spent double precision,
  ADD COLUMN lifecycle_seen_detection_at timestamptz,
  -- A balance without its day is uninterpretable (a balance naming an earlier day is
  -- spent), and a day without a balance is a half-written carry.
  ADD CONSTRAINT fire_events_geo_weight_pair
    CHECK ((geo_weight_day IS NULL) = (geo_weight_spent IS NULL)),
  ADD CONSTRAINT fire_events_geo_weight_spent_check
    CHECK (geo_weight_spent IS NULL OR geo_weight_spent >= 0);

COMMENT ON COLUMN fire_events.miss_evidence IS
  'Accumulated miss evidence E carried between lifecycle ticks (ADR-002 D4). Bookkeeping: never bumps seq.';
COMMENT ON COLUMN fire_events.geo_weight_day IS
  'UTC midnight of the day geo_weight_spent belongs to. NULL with geo_weight_spent when no GEO weight was carried.';
COMMENT ON COLUMN fire_events.geo_weight_spent IS
  'GEO miss weight already spent on geo_weight_day (the daily cap balance). Bookkeeping: never bumps seq.';
COMMENT ON COLUMN fire_events.lifecycle_seen_detection_at IS
  'Newest acquisition the previous lifecycle tick knew about; NULL until the first tick. The redetection test compares against it.';

ALTER TABLE clustering_runs
  ADD COLUMN lifecycle_ticked_at timestamptz;

COMMENT ON COLUMN clustering_runs.lifecycle_ticked_at IS
  'Instant of the previous lifecycle tick over this run''s events; the start of the next evidence window.';

-- ── classification and grants ───────────────────────────────────────────────────
INSERT INTO table_backup_class (table_name, class, note) VALUES
  ('clustering_batches', 'main', 'identity pipeline ledger; no personal data by construction');

-- No UPDATE, no DELETE: the ledger is the record of what the pipeline did.
GRANT SELECT, INSERT ON clustering_batches TO fire_watch_app;

-- migrate:down

DELETE FROM table_backup_class WHERE table_name = 'clustering_batches';

DROP TABLE IF EXISTS clustering_batches;

ALTER TABLE clustering_runs
  DROP COLUMN IF EXISTS lifecycle_ticked_at;

ALTER TABLE fire_events
  DROP CONSTRAINT IF EXISTS fire_events_geo_weight_spent_check,
  DROP CONSTRAINT IF EXISTS fire_events_geo_weight_pair,
  DROP COLUMN IF EXISTS lifecycle_seen_detection_at,
  DROP COLUMN IF EXISTS geo_weight_spent,
  DROP COLUMN IF EXISTS geo_weight_day,
  ALTER COLUMN miss_evidence TYPE real;

ALTER TABLE clusters
  DROP CONSTRAINT IF EXISTS clusters_seed_detection_uid_check,
  DROP COLUMN IF EXISTS minted_at,
  DROP COLUMN IF EXISTS seed_detection_uid;
