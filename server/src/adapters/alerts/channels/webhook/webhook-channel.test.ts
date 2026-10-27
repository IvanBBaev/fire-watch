import { describe, expect, it } from 'vitest';

import { WEBHOOK_PARAMS } from '../../../../core/config/webhook-params.js';
import type { OutboundMessage } from '../../../../core/ports/alert-channel.js';
import type {
  WebhookAttemptRecord,
  WebhookDeliveryStore,
  WebhookDeliveryTarget,
  WebhookEndpointEffect,
  WebhookPreviousAttempt,
  WebhookSecretSealer,
} from '../../../../core/ports/webhook-store.js';
import type { WebhookAlertFacts } from '../../../../core/webhooks/webhook-payload.js';
import { createWebhookChannel } from './webhook-channel.js';
import type {
  WebhookSendRequest,
  WebhookSendResult,
  WebhookTransport,
} from './webhook-transport.js';

const NOW = Date.UTC(2026, 9, 27, 12, 0, 0);
const ENDPOINT = '35353535-0000-4000-8000-0000000000aa';
const ACCOUNT = '35353535-0000-4000-8000-0000000000bb';
const PARAMS = WEBHOOK_PARAMS.values;
/** Placeholder plaintext the stub sealer "opens"; not a credential. */
const OPENED = 'whsec_placeholder-generated-in-test';

const FACTS: WebhookAlertFacts = {
  alertType: 'new_fire',
  decidedAtMs: NOW - 60_000,
  event: {
    publicId: 'fw-2026-abc',
    score: 0.7,
    status: 'active',
    startedAtMs: NOW - 3_600_000,
    lastDetectionAtMs: NOW - 120_000,
  },
};

function message(overrides: Partial<OutboundMessage> = {}): OutboundMessage {
  return {
    outboxId: '4242',
    channel: 'webhook',
    endpoint: ENDPOINT,
    rendered: {
      title: 'New fire near Home',
      body: 'A fire was detected 3 km from Home.',
      footer: 'Satellite detection; not an official warning.',
      url: 'https://fire.watch/e/fw-2026-abc',
    },
    locale: 'en',
    ttlSeconds: 21_600,
    ...overrides,
  };
}

interface Harness {
  store: WebhookDeliveryStore;
  records: { record: WebhookAttemptRecord; effect: WebhookEndpointEffect }[];
  sends: WebhookSendRequest[];
  transport: WebhookTransport;
}

function harness(opts: {
  target?: WebhookDeliveryTarget | null;
  previous?: WebhookPreviousAttempt | null;
  facts?: WebhookAlertFacts | null;
  result?: Partial<WebhookSendResult>;
  disabledAfter?: boolean;
}): Harness {
  const records: Harness['records'] = [];
  const sends: WebhookSendRequest[] = [];
  return {
    records,
    sends,
    store: {
      loadTarget() {
        return opts.target === undefined
          ? {
              endpointId: ENDPOINT,
              accountId: ACCOUNT,
              url: 'https://hooks.example-receiver.com/in',
              sealed: { ciphertext: new Uint8Array(44), keyId: 'k1' },
              disabled: false,
            }
          : opts.target;
      },
      lastAttempt() {
        return Promise.resolve(opts.previous ?? null);
      },
      alertFacts() {
        return Promise.resolve(opts.facts === undefined ? FACTS : opts.facts);
      },
      recordAttempt(record, effect) {
        records.push({ record, effect });
        return Promise.resolve({ disabled: opts.disabledAfter ?? false });
      },
    },
    transport: {
      send(request) {
        sends.push(request);
        return Promise.resolve({
          class: 'delivered',
          statusCode: 200,
          error: null,
          durationMs: 12,
          ...opts.result,
        });
      },
    },
  };
}

const sealer: WebhookSecretSealer = {
  seal() {
    throw new Error('not used');
  },
  open() {
    return OPENED;
  },
};

function channel(h: Harness, overrides: { sealer?: WebhookSecretSealer } = {}) {
  return createWebhookChannel({
    store: h.store,
    sealer: overrides.sealer ?? sealer,
    transport: h.transport,
    params: PARAMS,
    now: () => NOW,
    random: () => 0.5,
  });
}

describe('createWebhookChannel', () => {
  it('sends a signed alert payload and resets the failure count on a 2xx', async () => {
    const h = harness({});
    expect(await channel(h).deliver(message())).toEqual({ kind: 'delivered', providerAckAt: NOW });
    expect(h.sends).toHaveLength(1);
    const sent = h.sends[0];
    expect(sent?.secret).toBe(OPENED);
    expect(sent?.deliveryId).toBe('4242');
    const payload = JSON.parse(sent?.body ?? '{}') as Record<string, unknown>;
    expect(payload).toMatchObject({
      version: 'fire-watch.webhook.v1',
      type: 'alert',
      delivery_id: '4242',
      event: { id: 'fw-2026-abc', hazard: 'wildfire' },
    });
    expect(h.records).toMatchObject([
      {
        record: {
          kind: 'alert',
          outboxId: '4242',
          attempt: 1,
          outcome: 'delivered',
          nextAttemptAtMs: null,
        },
        effect: { kind: 'success', confirm: false },
      },
    ]);
  });

  it('schedules a jittered retry and reports transient', async () => {
    const h = harness({
      result: { class: 'retry', statusCode: 503, error: 'webhook h answered 503' },
    });
    const outcome = await channel(h).deliver(message());
    expect(outcome).toEqual({ kind: 'transient', error: 'webhook h answered 503' });
    expect(h.records[0]?.record).toMatchObject({
      outcome: 'retry',
      statusCode: 503,
      nextAttemptAtMs: NOW + 0.5 * PARAMS.backoffBaseMs,
    });
    expect(h.records[0]?.effect).toEqual({
      kind: 'failure',
      disableAfter: PARAMS.disableAfterConsecutiveFailures,
    });
  });

  it('waits without a request while the backoff runs', async () => {
    const h = harness({ previous: { attempt: 2, nextAttemptAt: NOW + 5_000, delivered: false } });
    const outcome = await channel(h).deliver(message());
    expect(outcome).toEqual({ kind: 'transient', error: 'webhook retry not due for 5000 ms' });
    expect(h.sends).toHaveLength(0);
    expect(h.records).toHaveLength(0);
  });

  it('makes the next attempt once the backoff elapsed', async () => {
    const h = harness({ previous: { attempt: 2, nextAttemptAt: NOW - 1, delivered: false } });
    await channel(h).deliver(message());
    expect(h.records[0]?.record.attempt).toBe(3);
  });

  it('fails the delivery on the last allowed attempt', async () => {
    const h = harness({
      previous: { attempt: PARAMS.maxAttempts - 1, nextAttemptAt: NOW, delivered: false },
      result: { class: 'retry', statusCode: null, error: 'timeout' },
    });
    expect(await channel(h).deliver(message())).toEqual({
      kind: 'permanent',
      error: 'timeout',
      subscription: 'keep',
    });
    expect(h.records[0]?.record).toMatchObject({
      attempt: PARAMS.maxAttempts,
      outcome: 'failed',
      nextAttemptAtMs: null,
    });
  });

  it('closes an exhausted delivery without a request, and a delivered one as sent', async () => {
    const exhausted = harness({ previous: { attempt: 3, nextAttemptAt: null, delivered: false } });
    expect((await channel(exhausted).deliver(message())).kind).toBe('permanent');
    expect(exhausted.sends).toHaveLength(0);

    const delivered = harness({ previous: { attempt: 1, nextAttemptAt: null, delivered: true } });
    expect(await channel(delivered).deliver(message())).toEqual({
      kind: 'delivered',
      providerAckAt: NOW,
    });
    expect(delivered.sends).toHaveLength(0);
  });

  it('fails a rejected 4xx at once and disables on 410', async () => {
    const rejected = harness({
      result: { class: 'reject', statusCode: 400, error: 'answered 400' },
    });
    expect(await channel(rejected).deliver(message())).toEqual({
      kind: 'permanent',
      error: 'answered 400',
      subscription: 'keep',
    });
    expect(rejected.records[0]?.record.outcome).toBe('failed');

    const gone = harness({ result: { class: 'gone', statusCode: 410, error: 'answered 410' } });
    expect(await channel(gone).deliver(message())).toEqual({
      kind: 'permanent',
      error: 'answered 410',
      subscription: 'prune',
    });
    expect(gone.records[0]).toMatchObject({
      record: { outcome: 'gone' },
      effect: { kind: 'disable', reason: 'gone' },
    });
  });

  it('logs a refused send as a counted failure and does not retry it', async () => {
    const h = harness({ result: { class: 'refused', statusCode: null, error: 'non-public' } });
    expect((await channel(h).deliver(message())).kind).toBe('permanent');
    expect(h.records[0]?.record.outcome).toBe('refused');
    expect(h.records[0]?.effect.kind).toBe('failure');
  });

  it('stops retrying when the failure disabled the endpoint', async () => {
    const h = harness({
      result: { class: 'retry', statusCode: 502, error: 'answered 502' },
      disabledAfter: true,
    });
    expect(await channel(h).deliver(message())).toEqual({
      kind: 'permanent',
      error: 'answered 502; endpoint disabled after consecutive failures',
      subscription: 'keep',
    });
  });

  it('prunes a subscription whose endpoint id is unusable or gone', async () => {
    expect(await channel(harness({})).deliver(message({ endpoint: '' }))).toMatchObject({
      kind: 'permanent',
      subscription: 'prune',
    });
    const h = harness({ target: null });
    expect(await channel(h).deliver(message())).toMatchObject({
      kind: 'permanent',
      subscription: 'prune',
    });
    expect(h.sends).toHaveLength(0);
  });

  it('does not send to a disabled endpoint or for a vanished event', async () => {
    const disabled = harness({
      target: {
        endpointId: ENDPOINT,
        accountId: ACCOUNT,
        url: 'https://hooks.example-receiver.com/in',
        sealed: { ciphertext: new Uint8Array(44), keyId: 'k1' },
        disabled: true,
      },
    });
    expect((await channel(disabled).deliver(message())).kind).toBe('permanent');
    const vanished = harness({ facts: null });
    expect((await channel(vanished).deliver(message())).kind).toBe('permanent');
    expect([...disabled.sends, ...vanished.sends]).toHaveLength(0);
  });

  it('is transient when the secret cannot be opened, and says nothing of why', async () => {
    const h = harness({});
    const broken: WebhookSecretSealer = {
      ...sealer,
      open() {
        throw new Error('key k1 missing');
      },
    };
    expect(await channel(h, { sealer: broken }).deliver(message())).toEqual({
      kind: 'transient',
      error: 'webhook signing secret could not be opened',
    });
    expect(h.sends).toHaveLength(0);
  });

  it('rejects a message routed to another channel', async () => {
    await expect(channel(harness({})).deliver(message({ channel: 'email' }))).rejects.toThrow(
      TypeError,
    );
  });
});
