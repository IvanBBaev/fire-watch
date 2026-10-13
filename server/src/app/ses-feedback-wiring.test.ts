import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';

import type { SnsVerifier } from '../adapters/mail/sns-verifier.js';
import { SES_FEEDBACK_PATH } from '../adapters/http/ses-feedback-route.js';
import { VirtualClock } from '../core/ports/clock.js';
import { loadConfig } from './config.js';
import { wireSesFeedbackRoute } from './ses-feedback-wiring.js';

const TOPIC = 'arn:aws:sns:eu-central-1:123456789012:fire-watch-ses-feedback';
const BASE_ENV = {
  DATABASE_URL: 'postgres://fire:watch@localhost:5432/fire_watch',
  FIRMS_MAP_KEY: '0123456789abcdef0123456789abcdef',
};

const complaint: SnsVerifier = {
  verify: () =>
    Promise.resolve({
      ok: true,
      envelope: {
        type: 'Notification',
        messageId: 'sns-7',
        topicArn: TOPIC,
        message: JSON.stringify({
          eventType: 'Complaint',
          mail: { messageId: 'ses-7' },
          complaint: { complainedRecipients: [{ emailAddress: 'Reader@Example.invalid' }] },
        }),
        timestamp: '2026-10-13T09:00:00Z',
        signatureVersion: '2',
        signature: 'c2lnbmF0dXJl',
        signingCertUrl: 'https://sns.eu-central-1.amazonaws.com/cert.pem',
      },
    }),
  confirmSubscription: () => Promise.resolve('confirmed'),
};

describe('wireSesFeedbackRoute', () => {
  it('registers nothing, and opens no pool, without a topic', async () => {
    const app = Fastify();
    const wiring = wireSesFeedbackRoute(app, loadConfig(BASE_ENV), { log: { note: () => {} } });
    expect(wiring.enabled).toBe(false);
    const response = await app.inject({ method: 'POST', url: SES_FEEDBACK_PATH, payload: '{}' });
    expect(response.statusCode).toBe(404);
    await wiring.close();
  });

  it('with a topic, suppresses through the port and logs one event without the address', async () => {
    const app = Fastify();
    const notes: Record<string, unknown>[] = [];
    const suppressed: string[] = [];
    const wiring = wireSesFeedbackRoute(
      app,
      loadConfig({ ...BASE_ENV, FIRE_WATCH_SES_FEEDBACK_TOPIC_ARN: TOPIC }),
      {
        log: { note: (record) => notes.push(record) },
        clock: new VirtualClock('2026-10-13T09:00:01Z'),
        verifier: complaint,
        suppressor: {
          suppress: (address) => {
            suppressed.push(address);
            return Promise.resolve(2);
          },
        },
      },
    );
    expect(wiring.enabled).toBe(true);

    const response = await app.inject({
      method: 'POST',
      url: SES_FEEDBACK_PATH,
      headers: { 'content-type': 'text/plain; charset=UTF-8' },
      payload: '{}',
    });

    expect(response.statusCode).toBe(200);
    expect(suppressed).toEqual(['reader@example.invalid']);
    expect(notes).toEqual([
      {
        ses_feedback: expect.objectContaining({
          outcome: 'applied',
          snsMessageId: 'sns-7',
          kind: 'complaint',
          revokedSubscriptions: 2,
        }) as unknown,
      },
    ]);
    expect(JSON.stringify(notes).toLowerCase()).not.toContain('example.invalid');
    await wiring.close();
  });
});
