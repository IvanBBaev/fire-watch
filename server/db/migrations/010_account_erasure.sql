-- Migration 010 — account erasure (TASKS I4; ADR-004 D8, A1.3, A1.9; 14 M3).
--
-- Erasure runs as one transaction in `adapters/db/pg-account-erasure.ts`, under the
-- runtime role: it cancels and pseudonymizes the account's outbox rows, deletes its alert
-- state, zones (the shadow log follows by cascade), subscriptions, sessions and link
-- requests, tombstones the account and writes one ledger row. The ordering argument is in
-- `core/erasure/erase-account.ts`. This migration adds what that transaction needs and
-- the guards that make it final:
--
--   * `alert_outbox.watch_zone_id` becomes nullable, because A1.3 destroys the zone
--     reference at pseudonymization and the zone row itself is deleted. A CHECK keeps NULL
--     legal only on a pseudonymized row. A1.3's salted per-year zone hash is not built:
--     NULL is the stronger form, and it is what OPERATIONS §6.2 rule 7 already does to
--     the backup projection.
--   * A pseudonymized outbox row is immutable: no later UPDATE can re-attach a zone or an
--     endpoint, or move a `cancelled_erasure` row back into the queue.
--   * An erased account is a scrubbed tombstone (CHECK: no address), immutable once
--     tombstoned, and no zone, subscription or session can be written under it. The guard
--     takes a key-share lock on the account row, so a write racing the erasure waits for
--     the erasure's `FOR UPDATE` and then sees the tombstone, instead of passing its
--     foreign-key check against the still-existing row.
--   * An erased account id can never be inserted again, even after its tombstone is gone.
--   * `erasure_requests` is the ledger: the proof an erasure ran, and the list a restore
--     inside the backup window has to replay. It holds no personal data beyond a SHA-256
--     of the account id — no address, no zone, nothing that says who asked. The deadline
--     is capped in the database at the 30-day horizon (A1.3).
--
-- Backup class: `erasure_requests` is `personal`, the fail-closed default of OPERATIONS
-- §6.2 rule 6. Whether the ledger may ride the 56-day main set is a founder decision.
-- It carries no foreign key, so the personal→main direction invariant is untouched.
--
-- Grants: the runtime role may add ledger rows and read them, never rewrite or remove
-- them — "the process that erases cannot delete the evidence it erased". Removal goes
-- through `purge_erasure_ledger`, a SECURITY DEFINER function that refuses any cutoff
-- inside the 30-day horizon. Its retention is not armed (see `core/erasure/purge-plan.ts`).
-- No identity column, so no sequence grant. The triggers are the owner's: the runtime
-- role can neither drop nor disable them, and `session_replication_role` needs a
-- superuser.

-- migrate:up

-- ── alert_outbox: the zone reference can be destroyed ──────────────────────────────
ALTER TABLE alert_outbox
  ALTER COLUMN watch_zone_id DROP NOT NULL,
  ADD CONSTRAINT alert_outbox_zone_or_pseudonymized
    CHECK (watch_zone_id IS NOT NULL OR pseudonymized_at IS NOT NULL);

CREATE FUNCTION refuse_update_of_pseudonymized_outbox() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'alert_outbox row % is pseudonymized and cannot be changed', OLD.id
    USING ERRCODE = 'check_violation';
END
$$;

CREATE TRIGGER alert_outbox_pseudonymized_is_final
  BEFORE UPDATE ON alert_outbox
  FOR EACH ROW WHEN (OLD.pseudonymized_at IS NOT NULL)
  EXECUTE FUNCTION refuse_update_of_pseudonymized_outbox();

-- ── accounts: a scrubbed, final tombstone ──────────────────────────────────────────
ALTER TABLE accounts
  ADD CONSTRAINT accounts_tombstone_scrubbed
    CHECK (deleted_at IS NULL OR (email IS NULL AND email_verified_at IS NULL));

CREATE FUNCTION refuse_update_of_erased_account() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'account is erased and cannot be changed'
    USING ERRCODE = 'check_violation';
END
$$;

CREATE TRIGGER accounts_tombstone_is_final
  BEFORE UPDATE ON accounts
  FOR EACH ROW WHEN (OLD.deleted_at IS NOT NULL)
  EXECUTE FUNCTION refuse_update_of_erased_account();

-- Locks without filtering on deleted_at: a filtered locking read would skip a row whose
-- snapshot still says live and never wait for the erasure holding it.
CREATE FUNCTION refuse_write_for_erased_account() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  erased timestamptz;
BEGIN
  SELECT deleted_at INTO erased FROM accounts WHERE id = NEW.account_id FOR KEY SHARE;
  IF erased IS NOT NULL THEN
    RAISE EXCEPTION 'account is erased; % cannot reference it', TG_TABLE_NAME
      USING ERRCODE = 'foreign_key_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER watch_zones_refuse_erased_account
  BEFORE INSERT OR UPDATE OF account_id ON watch_zones
  FOR EACH ROW EXECUTE FUNCTION refuse_write_for_erased_account();
CREATE TRIGGER channel_subscriptions_refuse_erased_account
  BEFORE INSERT OR UPDATE OF account_id ON channel_subscriptions
  FOR EACH ROW EXECUTE FUNCTION refuse_write_for_erased_account();
CREATE TRIGGER account_sessions_refuse_erased_account
  BEFORE INSERT OR UPDATE OF account_id ON account_sessions
  FOR EACH ROW EXECUTE FUNCTION refuse_write_for_erased_account();

-- ── the ledger ──────────────────────────────────────────────────────────────────────
CREATE TABLE erasure_requests (
  -- sha256(account id as text). The account row is a tombstone and every row that named
  -- it is gone, so the hash links to nothing live; within the personal backup window it
  -- is exactly what a restore needs to find the account to erase again.
  account_hash bytea PRIMARY KEY CHECK (octet_length(account_hash) = 32),
  erased_at    timestamptz NOT NULL,
  -- The instant every personal artifact made before erased_at is gone by (A1.3).
  deadline_at  timestamptz NOT NULL,
  plan_version text NOT NULL CHECK (plan_version ~ '^[a-z0-9_]+_v[0-9]+$'),
  -- Rows touched per table: numbers only.
  counts       jsonb NOT NULL CHECK (jsonb_typeof(counts) = 'object'),
  CONSTRAINT erasure_requests_deadline_in_horizon
    CHECK (deadline_at > erased_at AND deadline_at <= erased_at + interval '30 days')
);

CREATE INDEX erasure_requests_by_erased_at ON erasure_requests (erased_at);

CREATE FUNCTION purge_erasure_ledger(cutoff timestamptz, max_rows integer) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  purged integer;
BEGIN
  IF cutoff IS NULL OR cutoff > now() - interval '30 days' THEN
    RAISE EXCEPTION 'erasure ledger rows inside the 30-day erasure horizon are never purged'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF max_rows IS NULL OR max_rows < 1 THEN
    RAISE EXCEPTION 'max_rows must be positive' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  DELETE FROM public.erasure_requests
  WHERE account_hash IN (
    SELECT account_hash FROM public.erasure_requests
    WHERE erased_at < cutoff
    ORDER BY erased_at
    LIMIT max_rows
  );
  GET DIAGNOSTICS purged = ROW_COUNT;
  RETURN purged;
END
$$;

REVOKE ALL ON FUNCTION purge_erasure_ledger(timestamptz, integer) FROM PUBLIC;

-- The runtime role holds DELETE on accounts (001), so a tombstone can be removed; this is
-- what stops the erased id from then being inserted again and data rebuilt under it.
-- Both table-reading trigger functions pin `search_path`: pg_restore runs its COPYs with
-- an empty search_path, and an unqualified table name would fail every restored row.
CREATE FUNCTION refuse_reuse_of_erased_account_id() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM erasure_requests
    WHERE account_hash = sha256(convert_to(NEW.id::text, 'UTF8'))
  ) THEN
    RAISE EXCEPTION 'account id was erased and cannot be reused'
      USING ERRCODE = 'unique_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER accounts_refuse_erased_id
  BEFORE INSERT ON accounts
  FOR EACH ROW EXECUTE FUNCTION refuse_reuse_of_erased_account_id();

INSERT INTO table_backup_class (table_name, class, note) VALUES
  ('erasure_requests', 'personal', 'account id hash only; fail-closed default until decided');

-- ── grants ──────────────────────────────────────────────────────────────────────
-- No UPDATE, no DELETE: a ledger row is evidence. Purge only through the function.
GRANT SELECT, INSERT ON erasure_requests TO fire_watch_app;
GRANT EXECUTE ON FUNCTION purge_erasure_ledger(timestamptz, integer) TO fire_watch_app;

-- migrate:down

-- Refuses rather than inventing a zone for a row whose zone reference was destroyed.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM alert_outbox WHERE watch_zone_id IS NULL) THEN
    RAISE EXCEPTION 'alert_outbox holds pseudonymized rows with no zone; migration 010 cannot be rolled back over them';
  END IF;
END
$$;

DROP TRIGGER IF EXISTS accounts_refuse_erased_id ON accounts;
DROP FUNCTION IF EXISTS refuse_reuse_of_erased_account_id();
DROP FUNCTION IF EXISTS purge_erasure_ledger(timestamptz, integer);
DELETE FROM table_backup_class WHERE table_name = 'erasure_requests';
DROP TABLE IF EXISTS erasure_requests;

DROP TRIGGER IF EXISTS account_sessions_refuse_erased_account ON account_sessions;
DROP TRIGGER IF EXISTS channel_subscriptions_refuse_erased_account ON channel_subscriptions;
DROP TRIGGER IF EXISTS watch_zones_refuse_erased_account ON watch_zones;
DROP FUNCTION IF EXISTS refuse_write_for_erased_account();

DROP TRIGGER IF EXISTS accounts_tombstone_is_final ON accounts;
DROP FUNCTION IF EXISTS refuse_update_of_erased_account();
ALTER TABLE accounts DROP CONSTRAINT IF EXISTS accounts_tombstone_scrubbed;

DROP TRIGGER IF EXISTS alert_outbox_pseudonymized_is_final ON alert_outbox;
DROP FUNCTION IF EXISTS refuse_update_of_pseudonymized_outbox();
ALTER TABLE alert_outbox
  DROP CONSTRAINT IF EXISTS alert_outbox_zone_or_pseudonymized,
  ALTER COLUMN watch_zone_id SET NOT NULL;
