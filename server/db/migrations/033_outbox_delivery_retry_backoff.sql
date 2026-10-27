-- Migration 033 — delivery retries back off, and stop (TASKS H4/H5; ADR-004 D1, D6).
--
-- Until now a failed delivery attempt had no memory. A transient provider error settled
-- the row `released`, straight back to `pending`, and the next dispatch cycle (10 s later)
-- claimed it again — a provider outage was hammered every 10 s per row until each row's
-- D6 deadline closed it `ttl_expired` (30 min for push, 6 h for telegram and email). A row
-- whose template failed to render was worse: the render threw, the row was abandoned
-- `claimed`, and the abandoned-claim release put it back for the same failure every cycle
-- until the same deadline. Neither state was visible on the row.
--
-- **`delivery_attempts`** counts the attempts that *failed* — a transient provider error,
-- an adapter that threw, a render that threw. It is incremented by the settle that records
-- the failure, not by the claim: a claim that ends in a release that is no attempt at all
-- (the cool-off waiting for a second approver, a lease too short to start a send, a claim
-- abandoned because the recipient lookup was unreachable) must not spend a row's retries.
-- When the count reaches `delivery_params`' `retry.maxAttempts` the gateway closes the row
-- `failed` with `last_error` = `retry_exhausted:<the last error>`, which is the terminal
-- record of the delivery in the outbox itself.
--
-- **`next_attempt_at`** is the earliest instant the row may be claimed again, set by the
-- same settle from the backoff (`core/alerts/delivery-retry.ts`). NULL means "now": every
-- existing row, and every row that has never failed. The claim filters on it; no index
-- serves it, because the claim's order is still `priority, decided_at, id` and a backing-off
-- row is simply passed over — the pending set is small and bounded by D6's queue expiry.
--
-- Erasure (`erasure-plan.ts` v6): both columns survive pseudonymization. They are pipeline
-- state and name no recipient; how often a decision's delivery failed is part of the A1.3
-- record of what was attempted. Both are exported by the account export
-- (`export-schema.ts`).
--
-- Backup class: `alert_outbox` is already `personal` (migration 010); no registry change.
-- Grants: the runtime role's table-level SELECT/INSERT/UPDATE (migration 001) covers the
-- new columns.

-- migrate:up

ALTER TABLE alert_outbox
  ADD COLUMN delivery_attempts integer NOT NULL DEFAULT 0
    CONSTRAINT alert_outbox_delivery_attempts_non_negative CHECK (delivery_attempts >= 0),
  ADD COLUMN next_attempt_at timestamptz;

-- migrate:down

ALTER TABLE alert_outbox
  DROP COLUMN next_attempt_at,
  DROP COLUMN delivery_attempts;
