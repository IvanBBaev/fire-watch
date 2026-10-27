/**
 * The signed-webhook stores over Postgres (TASKS V2-G2; migration 035; docs/WEBHOOKS.md):
 * the owner's endpoint registry and what the channel needs at send time.
 *
 * **Which writes are transactions, and why.**
 *
 *   * Creating an endpoint takes a transaction-scoped advisory lock on the account, so
 *     "count, insert the subscription, insert the endpoint" cannot interleave with a second
 *     create: without it two concurrent requests could each count four and each insert a
 *     fifth and sixth past the cap.
 *   * Recording an attempt locks the endpoint row first (`FOR UPDATE`), then writes the log
 *     row and its effect on the endpoint (and on its subscription) together, so a burst of
 *     concurrent failures counts each one and disables exactly once. An endpoint deleted
 *     meanwhile records nothing and reads as disabled.
 *
 * Removing an endpoint is one statement: delete the endpoint (its log cascades) and revoke
 * its subscription, scrubbing the subscription's `endpoint` the way unlinking a channel does.
 * The subscription row stays because queued outbox rows still reference it.
 *
 * Auto-disable revokes the subscription without scrubbing it, so a successful test ping can
 * re-enable the endpoint by clearing `revoked_at` again.
 */

import type { EpochMs } from '../../core/ports/clock.js';
import type {
  SealedSecret,
  WebhookAttemptRecord,
  WebhookDeliveryStore,
  WebhookDeliveryTarget,
  WebhookDisabledReason,
  WebhookEndpointEffect,
  WebhookEndpointStore,
  WebhookEndpointView,
} from '../../core/ports/webhook-store.js';
import type { WebhookAlertFacts } from '../../core/webhooks/webhook-payload.js';
import { boolean, epochMs, field, number, string } from './pg-rows.js';

/** The slice of `pg` this module uses. Redeclared rather than imported. */
export interface PgWebhookQueryable {
  query<Row extends Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<{ rows: Row[]; rowCount: number | null }>;
}

export interface PgWebhookClient extends PgWebhookQueryable {
  release(): void;
}

export interface PgWebhookPool extends PgWebhookQueryable {
  connect(): Promise<PgWebhookClient>;
}

/** The advisory-lock class for endpoint creation; sign-in's is 7007, opt-in's 7012. */
export const WEBHOOK_LOCK_CLASS = 7035;

const LOCK_ACCOUNT = `SELECT pg_advisory_xact_lock(${WEBHOOK_LOCK_CLASS}, hashtext($1::text))`;

const COUNT_FOR_ACCOUNT = `
SELECT count(*)::int AS n FROM webhook_endpoints WHERE account_id = $1::uuid`;

const INSERT_SUBSCRIPTION = `
INSERT INTO channel_subscriptions (id, account_id, channel, endpoint, created_at)
VALUES (gen_random_uuid(), $1::uuid, 'webhook', $2::text, $3::timestamptz)
RETURNING id::text AS id`;

const INSERT_ENDPOINT = `
INSERT INTO webhook_endpoints
  (id, account_id, channel_subscription_id, url, secret_ciphertext, secret_key_id,
   created_at, secret_rotated_at)
VALUES ($1::uuid, $2::uuid, $3::uuid, $4::text, $5::bytea, $6::text, $7::timestamptz,
        $7::timestamptz)`;

const VIEW_COLUMNS = `
  e.id::text AS id,
  e.url,
  e.created_at,
  e.secret_rotated_at,
  (s.confirmed_at IS NOT NULL) AS confirmed,
  e.disabled_at,
  e.disabled_reason,
  e.consecutive_failures,
  e.last_success_at,
  e.last_failure_at`;

const LIST_FOR_ACCOUNT = `
SELECT ${VIEW_COLUMNS}
FROM webhook_endpoints e
JOIN channel_subscriptions s ON s.id = e.channel_subscription_id
WHERE e.account_id = $1::uuid
ORDER BY e.created_at, e.id`;

const GET_FOR_ACCOUNT = `
SELECT ${VIEW_COLUMNS}
FROM webhook_endpoints e
JOIN channel_subscriptions s ON s.id = e.channel_subscription_id
WHERE e.account_id = $1::uuid AND e.id = $2::uuid`;

const REMOVE = `
WITH gone AS (
  DELETE FROM webhook_endpoints
  WHERE account_id = $1::uuid AND id = $2::uuid
  RETURNING channel_subscription_id
)
UPDATE channel_subscriptions s
SET revoked_at = COALESCE(s.revoked_at, $3::timestamptz), endpoint = ''
FROM gone
WHERE s.id = gone.channel_subscription_id
RETURNING s.id`;

const ROTATE_SECRET = `
UPDATE webhook_endpoints
SET secret_ciphertext = $3::bytea, secret_key_id = $4::text, secret_rotated_at = $5::timestamptz
WHERE account_id = $1::uuid AND id = $2::uuid`;

const LOAD_TARGET = `
SELECT id::text AS id, account_id::text AS account_id, url, secret_ciphertext, secret_key_id,
       (disabled_at IS NOT NULL) AS disabled
FROM webhook_endpoints
WHERE id = $1::uuid`;

const LAST_ATTEMPT = `
SELECT attempt, next_attempt_at
FROM webhook_deliveries
WHERE webhook_endpoint_id = $1::uuid AND delivery_id = $2::text
ORDER BY attempt DESC
LIMIT 1`;

const ALERT_FACTS = `
SELECT o.alert_type, o.decided_at, e.public_id, e.score, e.status, e.started_at,
       e.last_detection_at
FROM alert_outbox o
JOIN fire_events e ON e.id = o.fire_event_id
WHERE o.id = $1::bigint`;

const LOCK_ENDPOINT = `
SELECT channel_subscription_id::text AS channel_subscription_id
FROM webhook_endpoints
WHERE id = $1::uuid
FOR UPDATE`;

const INSERT_ATTEMPT = `
INSERT INTO webhook_deliveries
  (account_id, webhook_endpoint_id, kind, outbox_id, delivery_id, attempt, attempted_at,
   next_attempt_at, outcome, status_code, duration_ms, error)
VALUES ($1::uuid, $2::uuid, $3::text, $4::bigint, $5::text, $6::integer, $7::timestamptz,
        $8::timestamptz, $9::text, $10::integer, $11::integer, $12::text)`;

const ON_SUCCESS = `
UPDATE webhook_endpoints
SET consecutive_failures = 0, last_success_at = $2::timestamptz
WHERE id = $1::uuid
RETURNING (disabled_at IS NOT NULL) AS disabled`;

/** A confirming success (the test ping) also re-enables a disabled endpoint. */
const ON_CONFIRMING_SUCCESS = `
UPDATE webhook_endpoints
SET consecutive_failures = 0, last_success_at = $2::timestamptz,
    disabled_at = NULL, disabled_reason = NULL
WHERE id = $1::uuid
RETURNING (disabled_at IS NOT NULL) AS disabled`;

const CONFIRM_SUBSCRIPTION = `
UPDATE channel_subscriptions
SET confirmed_at = COALESCE(confirmed_at, $2::timestamptz), revoked_at = NULL
WHERE id = $1::uuid`;

const ON_FAILURE = `
UPDATE webhook_endpoints
SET consecutive_failures = consecutive_failures + 1,
    last_failure_at = $2::timestamptz,
    disabled_reason = CASE
      WHEN disabled_at IS NULL AND consecutive_failures + 1 >= $3::integer
        THEN 'consecutive_failures' ELSE disabled_reason END,
    disabled_at = CASE
      WHEN disabled_at IS NULL AND consecutive_failures + 1 >= $3::integer
        THEN $2::timestamptz ELSE disabled_at END
WHERE id = $1::uuid
RETURNING (disabled_at IS NOT NULL) AS disabled`;

const ON_DISABLE = `
UPDATE webhook_endpoints
SET consecutive_failures = consecutive_failures + 1,
    last_failure_at = $2::timestamptz,
    disabled_reason = COALESCE(disabled_reason, $3::text),
    disabled_at = COALESCE(disabled_at, $2::timestamptz)
WHERE id = $1::uuid
RETURNING (disabled_at IS NOT NULL) AS disabled`;

const READ_DISABLED = `
SELECT (disabled_at IS NOT NULL) AS disabled FROM webhook_endpoints WHERE id = $1::uuid`;

/** Revoked, not scrubbed: a confirming ping may bring the endpoint back. */
const REVOKE_SUBSCRIPTION = `
UPDATE channel_subscriptions
SET revoked_at = COALESCE(revoked_at, $2::timestamptz)
WHERE id = $1::uuid`;

/** Exported for the tests that assert the statements' shape rather than their effect. */
export const WEBHOOK_SQL = {
  lockAccount: LOCK_ACCOUNT,
  countForAccount: COUNT_FOR_ACCOUNT,
  insertSubscription: INSERT_SUBSCRIPTION,
  insertEndpoint: INSERT_ENDPOINT,
  listForAccount: LIST_FOR_ACCOUNT,
  getForAccount: GET_FOR_ACCOUNT,
  remove: REMOVE,
  rotateSecret: ROTATE_SECRET,
  loadTarget: LOAD_TARGET,
  lastAttempt: LAST_ATTEMPT,
  alertFacts: ALERT_FACTS,
  lockEndpoint: LOCK_ENDPOINT,
  insertAttempt: INSERT_ATTEMPT,
  onSuccess: ON_SUCCESS,
  onConfirmingSuccess: ON_CONFIRMING_SUCCESS,
  confirmSubscription: CONFIRM_SUBSCRIPTION,
  onFailure: ON_FAILURE,
  onDisable: ON_DISABLE,
  readDisabled: READ_DISABLED,
  revokeSubscription: REVOKE_SUBSCRIPTION,
} as const;

export function createPgWebhookEndpointStore(pool: PgWebhookPool): WebhookEndpointStore {
  return {
    create(endpoint, limit) {
      return inTransaction(pool, async (client) => {
        await client.query(LOCK_ACCOUNT, [`webhook:${endpoint.accountId}`]);
        const counted = await client.query(COUNT_FOR_ACCOUNT, [endpoint.accountId]);
        if (number(field(counted.rows[0], 'n'), 'n') >= limit) return false;
        const at = iso(endpoint.atMs);
        const subscription = await client.query(INSERT_SUBSCRIPTION, [
          endpoint.accountId,
          endpoint.id,
          at,
        ]);
        await client.query(INSERT_ENDPOINT, [
          endpoint.id,
          endpoint.accountId,
          string(field(subscription.rows[0], 'id'), 'id'),
          endpoint.url,
          Buffer.from(endpoint.sealed.ciphertext),
          endpoint.sealed.keyId,
          at,
        ]);
        return true;
      });
    },

    async list(accountId) {
      const result = await pool.query(LIST_FOR_ACCOUNT, [accountId]);
      return result.rows.map(decodeView);
    },

    async get(accountId, endpointId) {
      const result = await pool.query(GET_FOR_ACCOUNT, [accountId, endpointId]);
      const row = result.rows[0];
      return row === undefined ? null : decodeView(row);
    },

    async remove(accountId, endpointId, atMs) {
      const result = await pool.query(REMOVE, [accountId, endpointId, iso(atMs)]);
      return (result.rowCount ?? 0) > 0;
    },

    async rotateSecret(accountId, endpointId, sealed, atMs) {
      const result = await pool.query(ROTATE_SECRET, [
        accountId,
        endpointId,
        Buffer.from(sealed.ciphertext),
        sealed.keyId,
        iso(atMs),
      ]);
      return (result.rowCount ?? 0) > 0;
    },
  };
}

export function createPgWebhookDeliveryStore(pool: PgWebhookPool): WebhookDeliveryStore {
  return {
    async loadTarget(endpointId) {
      const result = await pool.query(LOAD_TARGET, [endpointId]);
      const row = result.rows[0];
      return row === undefined ? null : decodeTarget(row);
    },

    async lastAttempt(endpointId, deliveryId) {
      const result = await pool.query(LAST_ATTEMPT, [endpointId, deliveryId]);
      const row = result.rows[0];
      if (row === undefined) return null;
      const next = field(row, 'next_attempt_at');
      return {
        attempt: number(field(row, 'attempt'), 'attempt'),
        nextAttemptAt: next === null ? null : epochMs(next, 'next_attempt_at'),
      };
    },

    async alertFacts(outboxId) {
      const result = await pool.query(ALERT_FACTS, [outboxId]);
      const row = result.rows[0];
      return row === undefined ? null : decodeFacts(row);
    },

    recordAttempt(record, effect) {
      return inTransaction(pool, async (client) => {
        const locked = await client.query(LOCK_ENDPOINT, [record.endpointId]);
        const endpointRow = locked.rows[0];
        if (endpointRow === undefined) return { disabled: true };
        const subscriptionId = string(
          field(endpointRow, 'channel_subscription_id'),
          'channel_subscription_id',
        );
        await client.query(INSERT_ATTEMPT, attemptValues(record));
        const disabled = await applyEffect(client, record, effect, subscriptionId);
        return { disabled };
      });
    },
  };
}

async function applyEffect(
  client: PgWebhookQueryable,
  record: WebhookAttemptRecord,
  effect: WebhookEndpointEffect,
  subscriptionId: string,
): Promise<boolean> {
  const at = iso(record.attemptedAtMs);
  switch (effect.kind) {
    case 'success': {
      const sql = effect.confirm ? ON_CONFIRMING_SUCCESS : ON_SUCCESS;
      const disabled = readDisabled(await client.query(sql, [record.endpointId, at]));
      if (effect.confirm) await client.query(CONFIRM_SUBSCRIPTION, [subscriptionId, at]);
      return disabled;
    }
    case 'failure': {
      const result = await client.query(ON_FAILURE, [record.endpointId, at, effect.disableAfter]);
      const disabled = readDisabled(result);
      if (disabled) await client.query(REVOKE_SUBSCRIPTION, [subscriptionId, at]);
      return disabled;
    }
    case 'disable': {
      const result = await client.query(ON_DISABLE, [record.endpointId, at, effect.reason]);
      await client.query(REVOKE_SUBSCRIPTION, [subscriptionId, at]);
      return readDisabled(result);
    }
    case 'none':
      return readDisabled(await client.query(READ_DISABLED, [record.endpointId]));
  }
}

function attemptValues(record: WebhookAttemptRecord): readonly unknown[] {
  return [
    record.accountId,
    record.endpointId,
    record.kind,
    record.outboxId,
    record.deliveryId,
    record.attempt,
    iso(record.attemptedAtMs),
    record.nextAttemptAtMs === null ? null : iso(record.nextAttemptAtMs),
    record.outcome,
    record.statusCode,
    Math.max(0, Math.round(record.durationMs)),
    record.error === null ? null : record.error.slice(0, 512),
  ];
}

async function inTransaction<T>(
  pool: PgWebhookPool,
  work: (client: PgWebhookClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

function iso(ms: EpochMs): string {
  return new Date(ms).toISOString();
}

function readDisabled(result: { rows: Record<string, unknown>[] }): boolean {
  const row = result.rows[0];
  // The row was locked FOR UPDATE in this transaction, so it cannot have vanished.
  if (row === undefined) throw new Error('webhook endpoint vanished under its row lock');
  return boolean(field(row, 'disabled'), 'disabled');
}

function nullableEpochMs(value: unknown, name: string): EpochMs | null {
  return value === null ? null : epochMs(value, name);
}

const DISABLED_REASONS: readonly WebhookDisabledReason[] = ['consecutive_failures', 'gone'];

function disabledReason(value: unknown): WebhookDisabledReason | null {
  if (value === null) return null;
  const found = DISABLED_REASONS.find((candidate) => candidate === value);
  if (found === undefined) throw new Error('disabled_reason holds a value outside the set');
  return found;
}

function decodeView(row: Record<string, unknown>): WebhookEndpointView {
  return {
    id: string(field(row, 'id'), 'id'),
    url: string(field(row, 'url'), 'url'),
    createdAtMs: epochMs(field(row, 'created_at'), 'created_at'),
    secretRotatedAtMs: epochMs(field(row, 'secret_rotated_at'), 'secret_rotated_at'),
    confirmed: boolean(field(row, 'confirmed'), 'confirmed'),
    disabledAtMs: nullableEpochMs(field(row, 'disabled_at'), 'disabled_at'),
    disabledReason: disabledReason(field(row, 'disabled_reason')),
    consecutiveFailures: number(field(row, 'consecutive_failures'), 'consecutive_failures'),
    lastSuccessAtMs: nullableEpochMs(field(row, 'last_success_at'), 'last_success_at'),
    lastFailureAtMs: nullableEpochMs(field(row, 'last_failure_at'), 'last_failure_at'),
  };
}

function decodeSealed(row: Record<string, unknown>): SealedSecret {
  const ciphertext = field(row, 'secret_ciphertext');
  if (!(ciphertext instanceof Uint8Array)) throw new Error('secret_ciphertext is not bytes');
  return {
    ciphertext: new Uint8Array(ciphertext),
    keyId: string(field(row, 'secret_key_id'), 'secret_key_id'),
  };
}

function decodeTarget(row: Record<string, unknown>): WebhookDeliveryTarget {
  return {
    endpointId: string(field(row, 'id'), 'id'),
    accountId: string(field(row, 'account_id'), 'account_id'),
    url: string(field(row, 'url'), 'url'),
    sealed: decodeSealed(row),
    disabled: boolean(field(row, 'disabled'), 'disabled'),
  };
}

function decodeFacts(row: Record<string, unknown>): WebhookAlertFacts {
  return {
    alertType: string(field(row, 'alert_type'), 'alert_type'),
    decidedAtMs: epochMs(field(row, 'decided_at'), 'decided_at'),
    event: {
      publicId: string(field(row, 'public_id'), 'public_id'),
      score: number(field(row, 'score'), 'score'),
      status: string(field(row, 'status'), 'status'),
      startedAtMs: epochMs(field(row, 'started_at'), 'started_at'),
      lastDetectionAtMs: epochMs(field(row, 'last_detection_at'), 'last_detection_at'),
    },
  };
}
