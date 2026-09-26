-- Migration 013 — register dbmate's `schema_migrations` in the backup registry (TASKS C6;
-- OPERATIONS §6.2 rules 5, 6, 8; §6.3).
--
-- `schema_migrations` is created by dbmate, not by a migration, so no migration could
-- register it before it held rows, and the nightly job's fail-closed default would treat it
-- as personal: its rows would leave the main artifact, and a main artifact restored alone
-- (rule 8) would come back with an empty migration history and fail the drill's schema
-- check for a table that holds nothing but version numbers. `core/backup/dump-plan.ts`
-- bridges that with `TOOLING_RELATION_CLASS`; this row makes the registry itself say so,
-- which is what the rest of the system (the schema suite, the erasure and export suites,
-- anyone reading the registry) consults.
--
-- Backup class `main`: migration version strings only; no row can identify a recipient.
--
-- `spatial_ref_sys` stays unregistered on purpose: it belongs to the PostGIS extension, and
-- the backup's relation query leaves extension-owned tables out altogether.
--
-- No grants: the runtime role needs nothing from dbmate's ledger.

-- migrate:up

INSERT INTO table_backup_class (table_name, class, note) VALUES
  ('schema_migrations', 'main', 'dbmate ledger; version strings only');

-- migrate:down

DELETE FROM table_backup_class WHERE table_name = 'schema_migrations';
