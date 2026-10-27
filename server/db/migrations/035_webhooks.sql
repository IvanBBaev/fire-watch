-- Migration 035 — signed webhooks, one more alert channel (TASKS V2-G2; docs/WEBHOOKS.md).
--
-- **The channel vocabulary gains `webhook`.** The `channel` CHECKs on `channel_subscriptions`
-- and `alert_outbox` (001) are widened; `channel_confirmations` (012) is not, because a
-- webhook is not confirmed by a token sent to it: the owner confirms it by sending a signed
-- test ping that the receiver answers with a 2xx, which sets the subscription's
-- `confirmed_at` (opt-in, so the recipient resolver's liveness rule holds unchanged).
--
-- **`webhook_endpoints`** — one row per registered endpoint, one-to-one with the
-- `channel_subscriptions` row the alert pipeline routes to. That subscription's `endpoint`
-- is the endpoint's id (a uuid, CHECKed below), never the URL: the URL lives here, where
-- erasure, export and the SSRF re-check can reach it, and the outbox carries nothing a
-- receiver could be identified by.
--
--   * `url` — the normalised https URL (`core/webhooks/webhook-url.ts`). The CHECK is a
--     backstop; the SSRF guard runs in the application, at registration and before every
--     send, because only the application resolves the host.
--   * `secret_ciphertext` / `secret_key_id` — the per-endpoint signing secret sealed with
--     AES-256-GCM under a service-held key (`aes-gcm-webhook-secret-sealer.ts`), the
--     construction migration 026 uses for staff TOTP secrets. Encrypted, not hashed: the
--     server must recompute the HMAC on every send, so it needs the plaintext back. A
--     database dump without the key holds no usable secret.
--     `iv (12) ‖ ciphertext (16–128) ‖ tag (16)`, hence the length CHECK.
--   * `consecutive_failures` — failed attempts in a row across every delivery to this
--     endpoint; a success resets it. At `webhook_params_v1.disableAfterConsecutiveFailures`
--     the endpoint is disabled (`disabled_at`, `disabled_reason`) and its subscription
--     revoked, so the pipeline stops routing to it. A `410 Gone` disables at once.
--
-- **`webhook_deliveries`** — the delivery log: one row per HTTP attempt (or per attempt
-- refused before the network by the SSRF guard), alert or ping. It is also the retry
-- schedule: `next_attempt_at` on the newest attempt of a delivery is when the channel will
-- next try it (`core/webhooks/webhook-retry.ts`), so a retry needs no column on the outbox
-- and no loop of its own. Retention: `PURGE_RETENTION.webhook_deliveries`
-- (`core/erasure/purge-plan.ts`), proposed at 30 days in `webhook_params_v1`, unarmed until
-- ratified like every other retention. The log holds no request or response body.
--
-- Erasure (I4): both tables carry `account_id`, are deleted by `erase-account.ts` before
-- the subscriptions, and are guarded by migration 010's `refuse_write_for_erased_account`
-- trigger. Both cascade from the account and from their parent for completeness.
--
-- Backup class `personal`: keyed by account; the URL can identify the owner's server.

-- migrate:up

ALTER TABLE channel_subscriptions
  DROP CONSTRAINT channel_subscriptions_channel_check,
  ADD CONSTRAINT channel_subscriptions_channel_check
    CHECK (channel IN ('push', 'telegram', 'email', 'webhook')),
  ADD CONSTRAINT channel_subscriptions_webhook_endpoint_id_only
    CHECK (channel <> 'webhook' OR endpoint ~ '^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})?$');

ALTER TABLE alert_outbox
  DROP CONSTRAINT alert_outbox_channel_check,
  ADD CONSTRAINT alert_outbox_channel_check
    CHECK (channel IN ('push', 'telegram', 'email', 'webhook'));

CREATE TABLE webhook_endpoints (
  -- Chosen by the application before the secret is sealed: the seal's associated data
  -- binds the ciphertext to this id.
  id                      uuid PRIMARY KEY,
  account_id              uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  channel_subscription_id uuid NOT NULL UNIQUE
                            REFERENCES channel_subscriptions (id) ON DELETE CASCADE,
  url                     text NOT NULL CHECK (url ~ '^https://' AND length(url) <= 2048),
  secret_ciphertext       bytea NOT NULL CHECK (octet_length(secret_ciphertext) BETWEEN 44 AND 156),
  secret_key_id           text NOT NULL CHECK (secret_key_id ~ '^[A-Za-z0-9_.-]{1,64}$'),
  created_at              timestamptz NOT NULL DEFAULT now(),
  secret_rotated_at       timestamptz NOT NULL DEFAULT now(),
  consecutive_failures    integer NOT NULL DEFAULT 0 CHECK (consecutive_failures >= 0),
  last_success_at         timestamptz,
  last_failure_at         timestamptz,
  disabled_at             timestamptz,
  disabled_reason         text CHECK (disabled_reason IN ('consecutive_failures', 'gone')),
  CONSTRAINT webhook_endpoints_disabled_with_reason
    CHECK ((disabled_at IS NULL) = (disabled_reason IS NULL)),
  CONSTRAINT webhook_endpoints_rotated_after_created CHECK (secret_rotated_at >= created_at)
);

-- The per-account cap and the owner's list.
CREATE INDEX webhook_endpoints_by_account ON webhook_endpoints (account_id, created_at);

CREATE TABLE webhook_deliveries (
  id                  bigserial PRIMARY KEY,
  account_id          uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  webhook_endpoint_id uuid NOT NULL REFERENCES webhook_endpoints (id) ON DELETE CASCADE,
  kind                text NOT NULL CHECK (kind IN ('alert', 'ping')),
  -- The alert outbox row, for an alert. Not a foreign key: the outbox is pseudonymised
  -- and archived on its own schedule, and the log must not hold it back.
  outbox_id           bigint,
  -- The payload's `delivery_id`: the outbox id for an alert, a fresh uuid for a ping.
  delivery_id         text NOT NULL CHECK (length(delivery_id) BETWEEN 1 AND 64),
  attempt             integer NOT NULL CHECK (attempt >= 1),
  attempted_at        timestamptz NOT NULL,
  -- When the next attempt of this delivery may run; NULL when none will.
  next_attempt_at     timestamptz,
  outcome             text NOT NULL
                        CHECK (outcome IN ('delivered', 'retry', 'failed', 'gone', 'refused')),
  status_code         integer CHECK (status_code BETWEEN 100 AND 599),
  duration_ms         integer NOT NULL CHECK (duration_ms >= 0),
  -- Our own description of the failure (redacted, capped); never the receiver's body.
  error               text CHECK (length(error) <= 512),
  CONSTRAINT webhook_deliveries_alert_has_outbox CHECK ((kind = 'alert') = (outbox_id IS NOT NULL)),
  CONSTRAINT webhook_deliveries_next_only_on_retry
    CHECK (next_attempt_at IS NULL OR outcome = 'retry'),
  CONSTRAINT webhook_deliveries_one_row_per_attempt UNIQUE (webhook_endpoint_id, delivery_id, attempt)
);

-- The retention purge: oldest first.
CREATE INDEX webhook_deliveries_by_attempted_at ON webhook_deliveries (attempted_at);
-- Erasure and export.
CREATE INDEX webhook_deliveries_by_account ON webhook_deliveries (account_id);

CREATE TRIGGER webhook_endpoints_refuse_erased_account
  BEFORE INSERT OR UPDATE OF account_id ON webhook_endpoints
  FOR EACH ROW EXECUTE FUNCTION refuse_write_for_erased_account();
CREATE TRIGGER webhook_deliveries_refuse_erased_account
  BEFORE INSERT OR UPDATE OF account_id ON webhook_deliveries
  FOR EACH ROW EXECUTE FUNCTION refuse_write_for_erased_account();

INSERT INTO table_backup_class (table_name, class, note) VALUES
  ('webhook_endpoints', 'personal', 'keyed by account; URL and sealed signing secret'),
  ('webhook_deliveries', 'personal', 'keyed by account; attempt outcomes, no bodies');

GRANT SELECT, INSERT, UPDATE, DELETE ON webhook_endpoints TO fire_watch_app;
GRANT SELECT, INSERT, DELETE ON webhook_deliveries TO fire_watch_app;
GRANT USAGE ON SEQUENCE webhook_deliveries_id_seq TO fire_watch_app;

-- migrate:down

DELETE FROM table_backup_class WHERE table_name IN ('webhook_endpoints', 'webhook_deliveries');
DROP TABLE IF EXISTS webhook_deliveries;
DROP TABLE IF EXISTS webhook_endpoints;

DELETE FROM alert_outbox WHERE channel = 'webhook';
DELETE FROM channel_subscriptions WHERE channel = 'webhook';

ALTER TABLE alert_outbox
  DROP CONSTRAINT alert_outbox_channel_check,
  ADD CONSTRAINT alert_outbox_channel_check CHECK (channel IN ('push', 'telegram', 'email'));

ALTER TABLE channel_subscriptions
  DROP CONSTRAINT IF EXISTS channel_subscriptions_webhook_endpoint_id_only,
  DROP CONSTRAINT channel_subscriptions_channel_check,
  ADD CONSTRAINT channel_subscriptions_channel_check
    CHECK (channel IN ('push', 'telegram', 'email'));
