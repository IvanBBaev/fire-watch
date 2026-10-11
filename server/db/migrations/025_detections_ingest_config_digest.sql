-- Migration 025 — every detection records the digest of the config it was ingested under
-- (TASKS C1, follow-up owned by B4; ADR-002 D5).
--
-- `ingest_config_version` names the polling-bbox config a row was written under, but the
-- version string is hand-written: a config edited without a bump would leave two
-- different polls both claiming `polling_bbox_v1`, and the row could not say which one
-- produced it. `clustering_runs` already carries version *and* digest for this reason;
-- `detections` now does too. Same type as `clustering_runs.config_digest` (text, the
-- 8-hex FNV-1a of `configDigest`), with a format CHECK so a version string, an empty
-- string or a longer hash written into the wrong column fails at insert.
--
-- Nullable, honestly. Rows written before this migration have no recorded digest, and
-- deriving one from today's config would assert exactly what this column exists to
-- prove — that today's values are the ones that produced the row. NULL means "written
-- before 025, digest unknown"; every ingest path (live poll, GEO slot, SP staging) fills
-- it from the same config object whose version it stores, and the writer's unit tests
-- pin that mapping. A NOT NULL for new rows only would need a NOT VALID constraint whose
-- semantics on a partitioned table (and on the staging table cloned from it) are worse
-- than the gap it closes; the column stays nullable and the code is the guard.
--
-- Partitioned table: ADD COLUMN and ADD CONSTRAINT on `detections` propagate to every
-- month partition. The C7 staging table is `LIKE detections INCLUDING ALL`, so it gets
-- the same column and the same CHECK and still matches for ATTACH PARTITION. The CHECK
-- passes on NULL, so validating it against the existing partitions is a cheap scan.

-- migrate:up

ALTER TABLE detections
  ADD COLUMN ingest_config_digest text;

ALTER TABLE detections
  ADD CONSTRAINT detections_ingest_config_digest_format
    CHECK (ingest_config_digest ~ '^[0-9a-f]{8}$');

COMMENT ON COLUMN detections.ingest_config_digest IS
  'configDigest of the ingest config named by ingest_config_version (8 hex chars, FNV-1a over canonical JSON). NULL only on rows written before migration 025.';

-- migrate:down

ALTER TABLE detections
  DROP CONSTRAINT IF EXISTS detections_ingest_config_digest_format,
  DROP COLUMN IF EXISTS ingest_config_digest;
