-- Migration 060 — source_registry_v2: three reserved v3 source ids (V3-P4).
--
-- The registry is owned by packages/contracts/src/sources.ts; `sources` is its projection,
-- existing so `detections.source` can carry a foreign key, and the parity test in
-- `schema.integration.test.ts` compares the two row for row. v2 appends three rows and
-- edits none (GLOSSARY §1a rule 1):
--
--   * `efa:firesat`   — Earth Fire Alliance FireSat (V3-A1);
--   * `firms:landsat` — FIRMS LANDSAT_NRT, attach-only confirmation (V3-A3);
--   * `ororatech:frp` — the commercial constellation, paid tier only (V3-A4).
--
-- Sentinel-3 SLSTR FRP (V3-A2) has no new row: `eumetsat:slstr:frp` is a v1 id.
--
-- The rows carry the new status `reserved`: an id exists, nothing polls it, and it is in
-- no live set. The `status` CHECK widens to admit it; nothing else in the schema changes,
-- and no existing row is touched.
--
-- Not personal: reference data. `sources` already has its backup class (001).

-- migrate:up

ALTER TABLE sources DROP CONSTRAINT sources_status_check;
ALTER TABLE sources ADD CONSTRAINT sources_status_check
  CHECK (status IN ('active', 'retired', 'reserved'));

INSERT INTO sources (id, queried_product, product_tier, status, status_effective_from, attach_only) VALUES
  ('efa:firesat',   'FIRESAT_NRT',   'NRT', 'reserved', '2026-10-29', false),
  ('firms:landsat', 'LANDSAT_NRT',   'NRT', 'reserved', '2026-10-29', true),
  ('ororatech:frp', 'ORORATECH_FRP', 'NRT', 'reserved', '2026-10-29', false);

-- migrate:down

DELETE FROM sources WHERE id IN ('efa:firesat', 'firms:landsat', 'ororatech:frp');
ALTER TABLE sources DROP CONSTRAINT sources_status_check;
ALTER TABLE sources ADD CONSTRAINT sources_status_check
  CHECK (status IN ('active', 'retired'));
