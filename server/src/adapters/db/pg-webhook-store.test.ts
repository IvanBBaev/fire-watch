import { describe, expect, it } from 'vitest';

import { epochMsFromIso } from '../../core/ports/clock.js';
import type { WebhookAttemptRecord } from '../../core/ports/webhook-store.js';
import {
  createPgWebhookDeliveryStore,
  createPgWebhookEndpointStore,
  WEBHOOK_LOCK_CLASS,
  WEBHOOK_SQL,
  type PgWebhookClient,
} from './pg-webhook-store.js';

const AT = epochMsFromIso('2026-10-27T08:00:00Z');
const ACCOUNT = '35353535-0000-4000-8000-000000000001';
const ENDPOINT = '35353535-0000-4000-8000-0000000000e1';
const SUBSCRIPTION = '35353535-0000-4000-8000-0000000000a1';
const SEALED = { ciphertext: new Uint8Array(60).fill(7), keyId: 'webhook2026a' };

type Answer = { rows: Record<string, unknown>[]; rowCount: number } | Error;

/** A stub pool answering by statement; anything unlisted gets no rows and rowCount 1. */
function stubPool(answers: Partial<Record<keyof typeof WEBHOOK_SQL, Answer>> = {}) {
  const queries: { text: string; values: readonly unknown[] }[] = [];
  let released = 0;
  const byText = new Map<string, Answer>();
  for (const [key, answer] of Object.entries(answers)) {
    byText.set(WEBHOOK_SQL[key as keyof typeof WEBHOOK_SQL], answer);
  }
  const query = <Row extends Record<string, unknown>>(
    text: string,
    values: readonly unknown[] = [],
  ) => {
    queries.push({ text, values });
    const answer = byText.get(text);
    if (answer instanceof Error) return Promise.reject(answer);
    return Promise.resolve({
      rows: (answer?.rows ?? []) as Row[],
      rowCount: answer?.rowCount ?? 1,
    });
  };
  const client: PgWebhookClient = {
    query,
    release() {
      released += 1;
    },
  };
  const keyOf = new Map<string, string>(
    Object.entries(WEBHOOK_SQL).map(([key, text]) => [text, key]),
  );
  return {
    queries,
    trace: () => queries.map((q) => keyOf.get(q.text) ?? q.text),
    valuesOf: (key: keyof typeof WEBHOOK_SQL) =>
      queries.find((q) => q.text === WEBHOOK_SQL[key])?.values,
    released: () => released,
    pool: { query, connect: () => Promise.resolve(client) },
  };
}

function record(overrides: Partial<WebhookAttemptRecord> = {}): WebhookAttemptRecord {
  return {
    endpointId: ENDPOINT,
    accountId: ACCOUNT,
    kind: 'alert',
    outboxId: '42',
    deliveryId: '42',
    attempt: 1,
    attemptedAtMs: AT,
    durationMs: 12.6,
    outcome: 'delivered',
    statusCode: 200,
    error: null,
    nextAttemptAtMs: null,
    ...overrides,
  };
}

const LOCKED = { rows: [{ channel_subscription_id: SUBSCRIPTION }], rowCount: 1 };
const ENABLED = { rows: [{ disabled: false }], rowCount: 1 };
const DISABLED = { rows: [{ disabled: true }], rowCount: 1 };

describe('createPgWebhookEndpointStore', () => {
  it('locks the account, counts, then inserts the subscription and the endpoint', async () => {
    const stub = stubPool({
      countForAccount: { rows: [{ n: 4 }], rowCount: 1 },
      insertSubscription: { rows: [{ id: SUBSCRIPTION }], rowCount: 1 },
    });
    const store = createPgWebhookEndpointStore(stub.pool);
    const created = await store.create(
      {
        id: ENDPOINT,
        accountId: ACCOUNT,
        url: 'https://hooks.example.org/fw',
        sealed: SEALED,
        atMs: AT,
      },
      5,
    );
    expect(created).toBe(true);
    expect(stub.trace()).toEqual([
      'BEGIN',
      'lockAccount',
      'countForAccount',
      'insertSubscription',
      'insertEndpoint',
      'COMMIT',
    ]);
    expect(WEBHOOK_SQL.lockAccount).toContain(String(WEBHOOK_LOCK_CLASS));
    expect(stub.valuesOf('lockAccount')).toEqual([`webhook:${ACCOUNT}`]);
    // The subscription's endpoint is the endpoint id, never the URL.
    expect(stub.valuesOf('insertSubscription')).toEqual([
      ACCOUNT,
      ENDPOINT,
      '2026-10-27T08:00:00.000Z',
    ]);
    const values = stub.valuesOf('insertEndpoint') ?? [];
    expect(values[2]).toBe(SUBSCRIPTION);
    expect(Buffer.isBuffer(values[4])).toBe(true);
    expect(values[5]).toBe('webhook2026a');
    expect(stub.released()).toBe(1);
  });

  it('refuses past the cap without inserting anything', async () => {
    const stub = stubPool({ countForAccount: { rows: [{ n: 5 }], rowCount: 1 } });
    const store = createPgWebhookEndpointStore(stub.pool);
    const created = await store.create(
      {
        id: ENDPOINT,
        accountId: ACCOUNT,
        url: 'https://hooks.example.org/fw',
        sealed: SEALED,
        atMs: AT,
      },
      5,
    );
    expect(created).toBe(false);
    expect(stub.trace()).toEqual(['BEGIN', 'lockAccount', 'countForAccount', 'COMMIT']);
  });

  it('rolls back when an insert fails', async () => {
    const stub = stubPool({
      countForAccount: { rows: [{ n: 0 }], rowCount: 1 },
      insertSubscription: new Error('boom'),
    });
    const store = createPgWebhookEndpointStore(stub.pool);
    await expect(
      store.create(
        {
          id: ENDPOINT,
          accountId: ACCOUNT,
          url: 'https://hooks.example.org/fw',
          sealed: SEALED,
          atMs: AT,
        },
        5,
      ),
    ).rejects.toThrow('boom');
    expect(stub.trace().at(-1)).toBe('ROLLBACK');
    expect(stub.released()).toBe(1);
  });

  it('decodes the owner view and never selects the secret', async () => {
    const row = {
      id: ENDPOINT,
      url: 'https://hooks.example.org/fw',
      created_at: new Date(AT),
      secret_rotated_at: new Date(AT),
      confirmed: true,
      disabled_at: new Date(AT + 1000),
      disabled_reason: 'gone',
      consecutive_failures: 3,
      last_success_at: null,
      last_failure_at: new Date(AT + 1000),
    };
    const stub = stubPool({ listForAccount: { rows: [row], rowCount: 1 } });
    const store = createPgWebhookEndpointStore(stub.pool);
    expect(await store.list(ACCOUNT)).toEqual([
      {
        id: ENDPOINT,
        url: 'https://hooks.example.org/fw',
        createdAtMs: AT,
        secretRotatedAtMs: AT,
        confirmed: true,
        disabledAtMs: AT + 1000,
        disabledReason: 'gone',
        consecutiveFailures: 3,
        lastSuccessAtMs: null,
        lastFailureAtMs: AT + 1000,
      },
    ]);
    expect(WEBHOOK_SQL.listForAccount).not.toContain('secret_ciphertext');
    expect(WEBHOOK_SQL.getForAccount).not.toContain('secret_ciphertext');
    expect(await store.get(ACCOUNT, ENDPOINT)).toBeNull();
  });

  it('refuses a disabled reason outside the set', async () => {
    const stub = stubPool({
      getForAccount: {
        rows: [
          {
            id: ENDPOINT,
            url: 'https://x.example',
            created_at: new Date(AT),
            secret_rotated_at: new Date(AT),
            confirmed: false,
            disabled_at: new Date(AT),
            disabled_reason: 'whim',
            consecutive_failures: 0,
            last_success_at: null,
            last_failure_at: null,
          },
        ],
        rowCount: 1,
      },
    });
    await expect(createPgWebhookEndpointStore(stub.pool).get(ACCOUNT, ENDPOINT)).rejects.toThrow(
      'disabled_reason',
    );
  });

  it('answers remove and rotate by the rows they touched', async () => {
    const stub = stubPool({
      remove: { rows: [], rowCount: 0 },
      rotateSecret: { rows: [], rowCount: 1 },
    });
    const store = createPgWebhookEndpointStore(stub.pool);
    expect(await store.remove(ACCOUNT, ENDPOINT, AT)).toBe(false);
    expect(await store.rotateSecret(ACCOUNT, ENDPOINT, SEALED, AT)).toBe(true);
    expect(WEBHOOK_SQL.remove).toContain("endpoint = ''");
    expect(WEBHOOK_SQL.remove).toContain('account_id = $1::uuid');
    expect(WEBHOOK_SQL.rotateSecret).toContain('account_id = $1::uuid');
  });
});

describe('createPgWebhookDeliveryStore', () => {
  it('loads a target with its sealed secret', async () => {
    const stub = stubPool({
      loadTarget: {
        rows: [
          {
            id: ENDPOINT,
            account_id: ACCOUNT,
            url: 'https://hooks.example.org/fw',
            secret_ciphertext: Buffer.from(SEALED.ciphertext),
            secret_key_id: 'webhook2026a',
            disabled: false,
          },
        ],
        rowCount: 1,
      },
    });
    const target = await createPgWebhookDeliveryStore(stub.pool).loadTarget(ENDPOINT);
    expect(target).toEqual({
      endpointId: ENDPOINT,
      accountId: ACCOUNT,
      url: 'https://hooks.example.org/fw',
      sealed: SEALED,
      disabled: false,
    });
  });

  it('reads the newest attempt and the alert facts', async () => {
    const stub = stubPool({
      lastAttempt: {
        rows: [{ attempt: 2, next_attempt_at: new Date(AT + 60_000), delivered: false }],
        rowCount: 1,
      },
      alertFacts: {
        rows: [
          {
            alert_type: 'new_fire',
            decided_at: new Date(AT),
            public_id: 'fw-abc',
            score: 0.5,
            status: 'active',
            started_at: new Date(AT - 3_600_000),
            last_detection_at: new Date(AT - 60_000),
          },
        ],
        rowCount: 1,
      },
    });
    const store = createPgWebhookDeliveryStore(stub.pool);
    expect(await store.lastAttempt(ENDPOINT, '42')).toEqual({
      attempt: 2,
      nextAttemptAt: AT + 60_000,
      delivered: false,
    });
    expect(await store.alertFacts('42')).toEqual({
      alertType: 'new_fire',
      decidedAtMs: AT,
      event: {
        publicId: 'fw-abc',
        score: 0.5,
        status: 'active',
        startedAtMs: AT - 3_600_000,
        lastDetectionAtMs: AT - 60_000,
      },
    });
    expect(WEBHOOK_SQL.lastAttempt).toContain('ORDER BY attempt DESC');
  });

  it('records a delivered alert and resets the count', async () => {
    const stub = stubPool({ lockEndpoint: LOCKED, onSuccess: ENABLED });
    const result = await createPgWebhookDeliveryStore(stub.pool).recordAttempt(record(), {
      kind: 'success',
      confirm: false,
    });
    expect(result).toEqual({ disabled: false });
    expect(stub.trace()).toEqual(['BEGIN', 'lockEndpoint', 'insertAttempt', 'onSuccess', 'COMMIT']);
    const values = stub.valuesOf('insertAttempt') ?? [];
    expect(values[3]).toBe('42');
    expect(values[10]).toBe(13);
  });

  it('confirms and re-enables on a confirming success', async () => {
    const stub = stubPool({ lockEndpoint: LOCKED, onConfirmingSuccess: ENABLED });
    await createPgWebhookDeliveryStore(stub.pool).recordAttempt(
      record({ kind: 'ping', outboxId: null, deliveryId: 'ping-1' }),
      { kind: 'success', confirm: true },
    );
    expect(stub.trace()).toEqual([
      'BEGIN',
      'lockEndpoint',
      'insertAttempt',
      'onConfirmingSuccess',
      'confirmSubscription',
      'COMMIT',
    ]);
    expect(stub.valuesOf('confirmSubscription')?.[0]).toBe(SUBSCRIPTION);
    expect(WEBHOOK_SQL.confirmSubscription).toContain('revoked_at = NULL');
  });

  it('counts a failure and revokes the subscription once the count disables', async () => {
    const counting = stubPool({ lockEndpoint: LOCKED, onFailure: ENABLED });
    await createPgWebhookDeliveryStore(counting.pool).recordAttempt(
      record({ outcome: 'retry', statusCode: 503, nextAttemptAtMs: AT + 60_000 }),
      { kind: 'failure', disableAfter: 20 },
    );
    expect(counting.trace()).not.toContain('revokeSubscription');
    expect(counting.valuesOf('onFailure')?.[2]).toBe(20);

    const tripping = stubPool({ lockEndpoint: LOCKED, onFailure: DISABLED });
    const result = await createPgWebhookDeliveryStore(tripping.pool).recordAttempt(
      record({ outcome: 'failed', statusCode: 500 }),
      { kind: 'failure', disableAfter: 20 },
    );
    expect(result).toEqual({ disabled: true });
    expect(tripping.trace()).toContain('revokeSubscription');
    expect(WEBHOOK_SQL.revokeSubscription).not.toContain('endpoint');
  });

  it('disables at once and revokes on a disable effect', async () => {
    const stub = stubPool({ lockEndpoint: LOCKED, onDisable: DISABLED });
    const result = await createPgWebhookDeliveryStore(stub.pool).recordAttempt(
      record({ outcome: 'gone', statusCode: 410 }),
      { kind: 'disable', reason: 'gone' },
    );
    expect(result).toEqual({ disabled: true });
    expect(stub.valuesOf('onDisable')?.[2]).toBe('gone');
    expect(stub.trace()).toContain('revokeSubscription');
  });

  it('logs only on a none effect, and caps the error text', async () => {
    const stub = stubPool({ lockEndpoint: LOCKED, readDisabled: ENABLED });
    await createPgWebhookDeliveryStore(stub.pool).recordAttempt(
      record({ kind: 'ping', outboxId: null, outcome: 'failed', error: 'x'.repeat(600) }),
      { kind: 'none' },
    );
    expect(stub.trace()).toEqual([
      'BEGIN',
      'lockEndpoint',
      'insertAttempt',
      'readDisabled',
      'COMMIT',
    ]);
    expect(String(stub.valuesOf('insertAttempt')?.[11])).toHaveLength(512);
  });

  it('records nothing for an endpoint deleted meanwhile', async () => {
    const stub = stubPool({ lockEndpoint: { rows: [], rowCount: 0 } });
    const result = await createPgWebhookDeliveryStore(stub.pool).recordAttempt(record(), {
      kind: 'success',
      confirm: false,
    });
    expect(result).toEqual({ disabled: true });
    expect(stub.trace()).toEqual(['BEGIN', 'lockEndpoint', 'COMMIT']);
  });
});
