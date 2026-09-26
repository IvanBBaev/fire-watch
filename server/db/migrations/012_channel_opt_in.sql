-- Migration 012 — double opt-in for alert channels, and Telegram minimization (TASKS I3;
-- ADR-004 D6, D8 as amended by A16; 05 §5.3.3, §5.5.3; 09 §5.3).
--
-- **A channel is never dispatchable until it is confirmed.** `channel_subscriptions` gains
-- `confirmed_at`; the recipient resolver (A1.9's liveness re-check, the one statement every
-- send passes) answers `live: false` for a row whose `confirmed_at` is null. There is no
-- backfill: every existing row is pending, which is the fail-closed reading — no row here
-- was ever confirmed by anyone, because no confirmation mechanism existed.
--
-- **`channel_confirmations`** is the pending-verification record 05 §5.5.3 names:
--
--   * one row per issued confirmation token, holding its SHA-256 only (`bytea`, 32 bytes,
--     CHECKed) — the token itself is never stored, as for `auth_link_requests`;
--   * single use: `consumed_at` is set by a conditional UPDATE, and the row that moved is
--     the one that confirmed; a newer issuance for the same endpoint sets `superseded_at`
--     on the open one; unlinking the channel sets `revoked_at`. At most one of the three;
--   * time-bounded: `expires_at` after `issued_at`. The email TTL (48 h) and the re-send
--     limit (3/address/day) are in `core/channels/opt-in-policy.ts`; the Telegram link TTL
--     is a founder decision and ships unarmed, so no Telegram token can be issued yet.
--
-- An email (or push) confirmation names the pending subscription it confirms. A Telegram
-- link has no subscription until the user sends `/start <token>` to the bot — the chat id
-- is only learned then — so its `channel_subscription_id` is null until it is consumed, and
-- set in the same statement that consumes it.
--
-- **Telegram minimization (D8, 09 §5.3).** A Telegram subscription's endpoint is the
-- private chat id and nothing else: the CHECK admits a positive decimal integer or the
-- empty string (an unlinked channel's scrubbed endpoint), so a username, a display name or
-- a group chat (negative id) cannot be stored even by mistake. No column anywhere holds a
-- Telegram username or profile.
--
-- Erasure: the account's confirmations are deleted by `erase-account.ts` before its
-- subscriptions, and migration 010's `refuse_write_for_erased_account` trigger guards this
-- table like the other account-keyed ones. The tombstone purge waits for this table too.
--
-- Backup class `personal`: keyed by account, and by subscription (an address or chat id).

-- migrate:up

ALTER TABLE channel_subscriptions
  ADD COLUMN confirmed_at timestamptz,
  ADD CONSTRAINT channel_subscriptions_confirmed_after_created
    CHECK (confirmed_at IS NULL OR confirmed_at >= created_at),
  ADD CONSTRAINT channel_subscriptions_telegram_chat_id_only
    CHECK (channel <> 'telegram' OR endpoint ~ '^([1-9][0-9]{0,19})?$');

CREATE TABLE channel_confirmations (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id              uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  channel                 text NOT NULL CHECK (channel IN ('push', 'telegram', 'email')),
  -- The pending subscription this token confirms; for a Telegram link, the one the
  -- consuming `/start` created.
  channel_subscription_id uuid REFERENCES channel_subscriptions (id) ON DELETE CASCADE,
  -- SHA-256 of the confirmation token. The token itself is never stored.
  token_hash              bytea NOT NULL UNIQUE CHECK (octet_length(token_hash) = 32),
  issued_at               timestamptz NOT NULL,
  expires_at              timestamptz NOT NULL,
  consumed_at             timestamptz,
  superseded_at           timestamptz,
  revoked_at              timestamptz,
  CONSTRAINT channel_confirmations_expiry_after_issue CHECK (expires_at > issued_at),
  CONSTRAINT channel_confirmations_one_ending
    CHECK (num_nonnulls(consumed_at, superseded_at, revoked_at) <= 1),
  -- Email and push confirm an endpoint that already exists.
  CONSTRAINT channel_confirmations_names_subscription
    CHECK (channel = 'telegram' OR channel_subscription_id IS NOT NULL),
  -- A Telegram link has a subscription exactly when it was consumed.
  CONSTRAINT channel_confirmations_telegram_link_consumed
    CHECK (channel <> 'telegram' OR (channel_subscription_id IS NULL) = (consumed_at IS NULL))
);

-- The re-send count and the supersede sweep: per account and channel, by time.
CREATE INDEX channel_confirmations_by_account ON channel_confirmations (account_id, channel, issued_at);
-- The open confirmation of a pending subscription (supersede, revoke).
CREATE INDEX channel_confirmations_open_by_subscription ON channel_confirmations (channel_subscription_id)
  WHERE consumed_at IS NULL AND superseded_at IS NULL AND revoked_at IS NULL;

CREATE TRIGGER channel_confirmations_refuse_erased_account
  BEFORE INSERT OR UPDATE OF account_id ON channel_confirmations
  FOR EACH ROW EXECUTE FUNCTION refuse_write_for_erased_account();

INSERT INTO table_backup_class (table_name, class, note) VALUES
  ('channel_confirmations', 'personal', 'keyed by account and subscription; token hashes only');

-- ── grants ──────────────────────────────────────────────────────────────────────
-- `channel_subscriptions` already carries SELECT, INSERT, UPDATE, DELETE from 001, and a
-- new column inherits a table-level grant.
GRANT SELECT, INSERT, UPDATE, DELETE ON channel_confirmations TO fire_watch_app;

-- migrate:down

DELETE FROM table_backup_class WHERE table_name = 'channel_confirmations';
DROP TRIGGER IF EXISTS channel_confirmations_refuse_erased_account ON channel_confirmations;
DROP TABLE IF EXISTS channel_confirmations;

ALTER TABLE channel_subscriptions
  DROP CONSTRAINT IF EXISTS channel_subscriptions_telegram_chat_id_only,
  DROP CONSTRAINT IF EXISTS channel_subscriptions_confirmed_after_created,
  DROP COLUMN IF EXISTS confirmed_at;
