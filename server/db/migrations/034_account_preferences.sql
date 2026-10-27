-- Migration 034 — a signed-in account's synced preferences (TASKS V2-C5, cross-device sync).
--
-- **`account_preferences`** holds one small JSON document per account: the web app's
-- standing choices (opt-in overlays, the static-source and protected-site layers, theme,
-- language, time window, new-signal sound) so that a second device signed in to the same
-- account finds them. The shape is `@fire-watch/contracts` `AccountPreferencesDocument`
-- (`schema` = `account_preferences_v1`); the server validates it before writing and never
-- reads a member's meaning.
--
--   * one row per account: `account_id` is the primary key, so there is nothing to
--     de-duplicate and no history — a write replaces the document;
--   * optimistic concurrency: `revision` starts at 1 and every write is a conditional
--     UPDATE `WHERE revision = <the revision the client read>` that bumps it, so of two
--     devices writing from the same revision exactly one moves the row and the other is
--     answered 409. The first write is an `INSERT ... ON CONFLICT DO NOTHING`, which loses
--     the same way to a concurrent first write;
--   * bounded: the CHECK caps the stored text at 8 KiB, twice the contract's 4 KiB cap
--     on the serialised document (jsonb's text form adds a space after every separator),
--     so a bug in the route's validation still cannot turn a row into storage.
--
-- Erasure: deleted by `erase-account.ts` with the account's other rows (ERASURE_PLAN v6),
-- and migration 010's `refuse_write_for_erased_account` trigger guards it like the other
-- account-keyed tables. The tombstone purge waits for this table too. Export (I6) carries
-- the document.
--
-- Backup class `personal`: keyed by account; the document is the reader's own settings.

-- migrate:up

CREATE TABLE account_preferences (
  account_id uuid PRIMARY KEY REFERENCES accounts (id) ON DELETE CASCADE,
  document   jsonb NOT NULL,
  revision   bigint NOT NULL CHECK (revision > 0),
  updated_at timestamptz NOT NULL,
  CONSTRAINT account_preferences_document_is_object CHECK (jsonb_typeof(document) = 'object'),
  CONSTRAINT account_preferences_document_bounded CHECK (octet_length(document::text) <= 8192)
);

CREATE TRIGGER account_preferences_refuse_erased_account
  BEFORE INSERT OR UPDATE OF account_id ON account_preferences
  FOR EACH ROW EXECUTE FUNCTION refuse_write_for_erased_account();

INSERT INTO table_backup_class (table_name, class, note) VALUES
  ('account_preferences', 'personal', 'keyed by account; the reader''s synced display settings');

-- ── grants ──────────────────────────────────────────────────────────────────────
GRANT SELECT, INSERT, UPDATE, DELETE ON account_preferences TO fire_watch_app;

-- migrate:down

DELETE FROM table_backup_class WHERE table_name = 'account_preferences';
DROP TRIGGER IF EXISTS account_preferences_refuse_erased_account ON account_preferences;
DROP TABLE IF EXISTS account_preferences;
