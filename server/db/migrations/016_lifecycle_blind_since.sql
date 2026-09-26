-- Migration 016 — the start of an event's observation-free run, carried between lifecycle
-- ticks (ADR-002 D4, DATA-SOURCES A2.3(3); TASKS D4 wiring).
--
-- The unobservability fallback closes an event that no pass has been able to observe for
-- 14 whole UTC days. The accumulator counted those days inside a single tick window only,
-- which is right for the golden replay (one window per scenario step) and wrong for the
-- live worker, whose identity cycle ticks every poll: a sixty-second window holds no whole
-- UTC day, so the count was zero on every tick and the fallback could never fire. With no
-- cloud feed wired, every pass is cloud-blocked and adds no miss evidence either, so a live
-- event that simply went quiet stayed `active` on the map forever.
--
-- `lifecycle_blind_since` is the UTC midnight the current blind run is counted from: the
-- day after the last observing pass, or the first tick's window start when there has been
-- none. It moves only when a tick sees an observing pass, so any split of the same span
-- into ticks counts the same days. Bookkeeping like the rest of 005's carry: it is not in
-- 004's trigger list, so writing it every tick moves no `seq`.
--
-- The table-level grant on `fire_events` (001) already covers a new column for the
-- runtime role; nothing to grant.

-- migrate:up

ALTER TABLE fire_events
  ADD COLUMN lifecycle_blind_since timestamptz;

COMMENT ON COLUMN fire_events.lifecycle_blind_since IS
  'UTC midnight the event''s current run of observation-free days is counted from; NULL until the first lifecycle tick. Bookkeeping: never bumps seq.';

-- migrate:down

ALTER TABLE fire_events
  DROP COLUMN IF EXISTS lifecycle_blind_since;
