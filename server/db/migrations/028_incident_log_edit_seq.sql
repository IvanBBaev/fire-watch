-- Migration 028 — an edit counter on incident log versions (TASKS I1; 05 C4).
--
-- 026 made a write to an open version a compare-and-set on (version, status). An edit
-- that keeps a draft a draft leaves both unchanged, so a submit decided from the draft
-- *before* that edit still matched and both writes landed: the reviewer could be handed
-- text the submitter never saw. `edit_seq` counts the in-place updates of a version row;
-- the store bumps it on every UPDATE and the CAS compares it too, so any write in between
-- makes a racing one a conflict.
--
-- A published row is frozen by 026's trigger, so its counter never moves again.

-- migrate:up

ALTER TABLE incident_log_versions
  ADD COLUMN edit_seq integer NOT NULL DEFAULT 0
  CONSTRAINT incident_log_versions_edit_seq_nonnegative CHECK (edit_seq >= 0);

-- migrate:down

ALTER TABLE incident_log_versions DROP COLUMN edit_seq;
