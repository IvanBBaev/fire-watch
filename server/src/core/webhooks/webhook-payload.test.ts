import { WEBHOOK_PAYLOAD_VERSION } from '@fire-watch/contracts';
import { describe, expect, it } from 'vitest';

import { epochMsFromIso } from '../ports/clock.js';
import { attributionFor } from '../snapshot/snapshot-builder.js';
import {
  buildWebhookAlertPayload,
  buildWebhookPingPayload,
  serializeWebhookPayload,
} from './webhook-payload.js';

const SENT = epochMsFromIso('2026-10-27T12:00:00Z');

const RENDERED = {
  title: 'New fire near Plovdiv',
  body: 'A new fire was detected.',
  footer: 'Not an official warning.',
  url: 'https://fire.watch/e/fw-2026-abcde',
};

const FACTS = {
  alertType: 'new_event',
  decidedAtMs: epochMsFromIso('2026-10-27T11:59:30Z'),
  event: {
    publicId: 'fw-2026-abcde',
    score: 0.8,
    status: 'active',
    startedAtMs: epochMsFromIso('2026-10-27T10:00:00Z'),
    lastDetectionAtMs: epochMsFromIso('2026-10-27T11:55:00Z'),
  },
};

describe('buildWebhookAlertPayload', () => {
  it('carries the rendered alert, the event facts, the score bucket and the API credits', () => {
    const payload = buildWebhookAlertPayload({
      deliveryId: '42',
      sentAtMs: SENT,
      locale: 'en',
      rendered: RENDERED,
      facts: FACTS,
    });
    expect(payload).toEqual({
      version: WEBHOOK_PAYLOAD_VERSION,
      type: 'alert',
      delivery_id: '42',
      sent_at: '2026-10-27T12:00:00Z',
      alert: {
        type: 'new_event',
        decided_at: '2026-10-27T11:59:30Z',
        locale: 'en',
        title: RENDERED.title,
        body: RENDERED.body,
        footer: RENDERED.footer,
      },
      event: {
        id: 'fw-2026-abcde',
        permalink: RENDERED.url,
        hazard: 'wildfire',
        severity: 'confirmed',
        status: 'active',
        started_at: '2026-10-27T10:00:00Z',
        last_detection_at: '2026-10-27T11:55:00Z',
      },
      attribution: attributionFor(SENT),
    });
    expect(payload.attribution.length).toBeGreaterThan(0);
  });

  it('never exposes the raw score', () => {
    const body = serializeWebhookPayload(
      buildWebhookAlertPayload({
        deliveryId: '1',
        sentAtMs: SENT,
        locale: 'en',
        rendered: { ...RENDERED, url: null },
        facts: { ...FACTS, event: { ...FACTS.event, score: 0.4321 } },
      }),
    );
    expect(body).not.toContain('0.4321');
    expect(JSON.parse(body)).toMatchObject({
      event: { severity: 'unverified', permalink: null },
    });
  });
});

describe('buildWebhookPingPayload', () => {
  it('names the endpoint and carries no event', () => {
    const payload = buildWebhookPingPayload({
      deliveryId: 'd-1',
      endpointId: '00000000-0000-4000-8000-000000000001',
      sentAtMs: SENT,
    });
    expect(payload).toEqual({
      version: WEBHOOK_PAYLOAD_VERSION,
      type: 'ping',
      delivery_id: 'd-1',
      sent_at: '2026-10-27T12:00:00Z',
      endpoint_id: '00000000-0000-4000-8000-000000000001',
      attribution: attributionFor(SENT),
    });
    expect(JSON.parse(serializeWebhookPayload(payload))).toEqual(payload);
  });
});
