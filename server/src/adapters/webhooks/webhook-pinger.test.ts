import { describe, expect, it } from 'vitest';

import type {
  WebhookAttemptRecord,
  WebhookDeliveryStore,
  WebhookEndpointEffect,
  WebhookSecretSealer,
} from '../../core/ports/webhook-store.js';
import type {
  WebhookSendRequest,
  WebhookSendResult,
} from '../alerts/channels/webhook/webhook-transport.js';
import { createWebhookPinger } from './webhook-pinger.js';

const NOW = Date.UTC(2026, 9, 27, 12, 0, 0);
const ENDPOINT = '35353535-0000-4000-8000-0000000000aa';
const ACCOUNT = '35353535-0000-4000-8000-0000000000bb';
const PING_ID = '35353535-0000-4000-8000-0000000000cc';

function setup(result: Partial<WebhookSendResult>) {
  const records: { record: WebhookAttemptRecord; effect: WebhookEndpointEffect }[] = [];
  const sends: WebhookSendRequest[] = [];
  const store: WebhookDeliveryStore = {
    loadTarget(id) {
      return id === ENDPOINT
        ? {
            endpointId: ENDPOINT,
            accountId: ACCOUNT,
            url: 'https://hooks.example-receiver.com/in',
            sealed: { ciphertext: new Uint8Array(44), keyId: 'k1' },
            disabled: true,
          }
        : null;
    },
    lastAttempt() {
      return Promise.resolve(null);
    },
    alertFacts() {
      return Promise.resolve(null);
    },
    recordAttempt(record, effect) {
      records.push({ record, effect });
      return Promise.resolve({ disabled: false });
    },
  };
  const sealer: WebhookSecretSealer = {
    seal() {
      throw new Error('not used');
    },
    open: () => 'whsec_placeholder-generated-in-test',
  };
  const pinger = createWebhookPinger({
    store,
    sealer,
    transport: {
      send(request) {
        sends.push(request);
        return Promise.resolve({
          class: 'delivered',
          statusCode: 200,
          error: null,
          durationMs: 7,
          ...result,
        });
      },
    },
    now: () => NOW,
    newId: () => PING_ID,
  });
  return { pinger, records, sends };
}

describe('createWebhookPinger', () => {
  it('sends a signed ping and confirms (and re-enables) the endpoint on a 2xx', async () => {
    const { pinger, records, sends } = setup({});
    expect(await pinger.ping(ACCOUNT, ENDPOINT)).toEqual({
      deliveryId: PING_ID,
      outcome: 'delivered',
      statusCode: 200,
      error: null,
      durationMs: 7,
      confirmed: true,
    });
    expect(JSON.parse(sends[0]?.body ?? '{}')).toMatchObject({
      type: 'ping',
      delivery_id: PING_ID,
      endpoint_id: ENDPOINT,
    });
    expect(records[0]).toMatchObject({
      record: { kind: 'ping', outboxId: null, attempt: 1, outcome: 'delivered' },
      effect: { kind: 'success', confirm: true },
    });
  });

  it('logs a failed ping without counting it against the endpoint, and never retries', async () => {
    for (const [cls, outcome] of [
      ['retry', 'failed'],
      ['reject', 'failed'],
      ['gone', 'gone'],
      ['refused', 'refused'],
    ] as const) {
      const { pinger, records } = setup({ class: cls, statusCode: null, error: 'x' });
      const result = await pinger.ping(ACCOUNT, ENDPOINT);
      expect(result).toMatchObject({ outcome, confirmed: false });
      expect(records[0]?.record.nextAttemptAtMs).toBeNull();
      expect(records[0]?.effect).toEqual({ kind: 'none' });
    }
  });

  it('answers null for an endpoint the account does not own, without sending', async () => {
    const { pinger, sends } = setup({});
    expect(await pinger.ping('35353535-0000-4000-8000-0000000000dd', ENDPOINT)).toBeNull();
    expect(await pinger.ping(ACCOUNT, PING_ID)).toBeNull();
    expect(sends).toHaveLength(0);
  });
});
