-- Migration 003 — the provenance columns ADR-004 A1.1 added and 001 did not carry.
--
-- Normative source: ADR-004 D1 as amended by A1.2 (TASKS H1). 001 built `alert_outbox`
-- against D1's original text — `trigger_type` with three values, no human in the record
-- — and A1.1 widened that record afterwards. Three columns are missing, and the gap is
-- not cosmetic: A1.1 exists because "the row that woke 4,000 people at 03:00 looked
-- exactly like an automatic one".
--
-- What lands:
--
--   `trigger_type`     — what *caused* the row, over A1.1's four-value vocabulary. This
--                        is a second column and not a widened `alert_type`, because the
--                        two answer different questions and only one of them is an
--                        identity. `alert_type` is the third field of the A1.11 unique
--                        key: it says what the recipient is being told, and `manual` is
--                        not something anyone can be told. A human continuing an
--                        over-budget escalation sends an `escalation`; what is manual
--                        about it is the trigger. Folding `manual` into `alert_type`
--                        would put it in the idempotency key and make "the operator
--                        pushed this one" a different alert from the one it continues.
--   `actor_id`         — the human who initiated. NULL on every automatic row.
--   `budget_override`  — the row was released past budget B (D5).
--
-- Deliberately NOT landing here: A1.1's refusal rule as a CHECK constraint. It is
-- tempting — the predicate is written out in the amendment and Postgres would enforce it
-- for free — and it would be wrong. A1.1 says such a row is *undeliverable*, not
-- unwritable, and the two differ by the whole approval flow: a manual row is written
-- with `status = 'awaiting_approval'` precisely so that a second human can come along
-- later and fill `approver_id` in. A CHECK would reject the row at the moment it is
-- created and leave nothing for anyone to approve. The rule is enforced where A1.1 puts
-- it, in the gateway, against a row that already exists — `isDeliverable` in
-- `core/alerts/outbox.ts` is that predicate.

-- migrate:up

ALTER TABLE alert_outbox
  -- Nullable first, then backfilled, then tightened: `SET NOT NULL` on a populated
  -- table needs every existing row to already satisfy it. On an automatic row the
  -- trigger and the alert are the same thing, which is exactly what the backfill says.
  ADD COLUMN trigger_type text,
  ADD COLUMN actor_id text,
  ADD COLUMN budget_override boolean NOT NULL DEFAULT false;

UPDATE alert_outbox SET trigger_type = alert_type WHERE trigger_type IS NULL;

ALTER TABLE alert_outbox
  ALTER COLUMN trigger_type SET NOT NULL,
  ADD CONSTRAINT alert_outbox_trigger_type_check
    CHECK (trigger_type IN ('manual', 'new_fire', 'escalation', 'digest')),
  -- The one part of A1.1 that *is* an identity and not a workflow state: a row whose
  -- trigger is one of the three automatic ones must agree with what it announces.
  -- Only `manual` is allowed to differ, and only in the direction A1.1 describes.
  ADD CONSTRAINT alert_outbox_trigger_matches_alert
    CHECK (trigger_type = 'manual' OR trigger_type = alert_type);

COMMENT ON COLUMN alert_outbox.trigger_type IS
  'A1.1 four-value provenance: what caused the row. Equals alert_type on automatic rows.';
COMMENT ON COLUMN alert_outbox.actor_id IS
  'A1.1: the human who initiated a manual send. NULL on automatic rows.';
COMMENT ON COLUMN alert_outbox.budget_override IS
  'A1.1/D5: the row was released past budget B by a human.';

-- The dispatch queue orders by `priority, decided_at, id` (A1.2) and priority is a pure
-- function of `trigger_type`, so the index 001 created still covers the claim exactly.
-- Nothing about ordering changes here; only the column the order is derived from is now
-- present to be audited against.

-- migrate:down

ALTER TABLE alert_outbox
  DROP CONSTRAINT IF EXISTS alert_outbox_trigger_matches_alert,
  DROP CONSTRAINT IF EXISTS alert_outbox_trigger_type_check,
  DROP COLUMN IF EXISTS budget_override,
  DROP COLUMN IF EXISTS actor_id,
  DROP COLUMN IF EXISTS trigger_type;
