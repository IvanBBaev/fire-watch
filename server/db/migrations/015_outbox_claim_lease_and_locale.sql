-- Migration 015 — a time-bounded claim lease and a per-row locale on the outbox (TASKS H4,
-- H5; ADR-004 D1, D2, D6).
--
-- **`claimed_at` — the claim lease (H4).** Until now a `claimed` row carried no record of
-- when it was claimed, so an orphaned claim could only be recovered by releasing *every*
-- `claimed` row at dispatcher start-up. That is safe only under D1's single dispatcher: a
-- second process (a botched deploy, an overlapping restart) would release the first one's
-- in-flight rows and send them twice. With this column:
--
--   * the claim statement stamps `claimed_at` with the dispatcher's `now` (a parameter,
--     never `now()`), in the same statement that moves the row `pending` → `claimed`;
--   * a claim older than the lease (`CLAIM_LEASE_MS`, `core/alerts/claim-lease.ts`) is
--     returned to `pending` by whichever dispatcher next runs a cycle — the start-up
--     "release everything" step is gone;
--   * the gateway refuses to hand a row to a provider once too little of its lease is left
--     for the worst-case send to finish inside it, so an expired lease never means two
--     providers calls for one claim;
--   * every settle is fenced on the `claimed_at` the settling dispatcher claimed with, so a
--     dispatcher whose lease expired cannot settle the row a second claim now owns.
--
-- `claimed_at` records the *last* claim and is not cleared on settle: for a sent row it is
-- when the final attempt was claimed, which is useful next to `decided_at` and
-- `dispatched_at` in a latency post-mortem. The CHECK makes a `claimed` row without one
-- impossible; the backfill stamps rows claimed under the old code with the migration's
-- own time, so they expire one lease after the deploy rather than never.
--
-- **`locale` — the language the row is rendered in (H5).** The renderer took the locale
-- from the recipient resolver, which had no column to read and answered `bg` for everyone.
-- The locale is now decided with the row and stored on it, so the copy a row was sent in
-- is a fact of the decision, not of whatever the resolver happened to answer at send time.
-- Neither `accounts` nor `channel_subscriptions` holds a language (migration 007 deferred
-- it as a product decision), so the default is the only source today: `bg`, per the
-- renderer port and A6. The CHECK is the shipped locale set (`ALERT_LOCALES`,
-- `core/alerts/templates/alert-copy.ts`); widening it is a migration, on purpose, because
-- a locale with no reviewed copy must never be stored as sendable.
--
-- Erasure (migration 010, `erasure-plan.ts` v4): both columns survive pseudonymization.
-- `claimed_at` is a pipeline timestamp; `locale` names which copy of the decision was sent,
-- which the A1.3 liability defence needs, and it names no recipient. Both are exported by
-- the account export (`export-schema.ts`). The pseudonymized-row trigger is unaffected:
-- erasure closes `claimed` rows `cancelled_erasure` before pseudonymizing, so the backfill
-- below never touches a pseudonymized row.
--
-- Backup class: `alert_outbox` is already `personal` (migration 010); no registry change.
-- Grants: the runtime role's table-level SELECT/INSERT/UPDATE (migration 001) covers the
-- new columns.

-- migrate:up

ALTER TABLE alert_outbox
  ADD COLUMN claimed_at timestamptz,
  ADD COLUMN locale text NOT NULL DEFAULT 'bg'
    CONSTRAINT alert_outbox_locale_shipped CHECK (locale IN ('bg', 'en'));

UPDATE alert_outbox
SET claimed_at = now()
WHERE status = 'claimed';

ALTER TABLE alert_outbox
  ADD CONSTRAINT alert_outbox_claim_has_lease
    CHECK (status <> 'claimed' OR claimed_at IS NOT NULL);

-- The lease sweep's only question: which claims are older than the cutoff.
CREATE INDEX alert_outbox_claim_lease
  ON alert_outbox (claimed_at)
  WHERE status = 'claimed';

-- migrate:down

DROP INDEX alert_outbox_claim_lease;

ALTER TABLE alert_outbox
  DROP CONSTRAINT alert_outbox_claim_has_lease,
  DROP COLUMN locale,
  DROP COLUMN claimed_at;
