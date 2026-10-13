import Fastify, { type FastifyInstance } from 'fastify';
import { describe, expect, it } from 'vitest';

import type {
  SnsEnvelope,
  SnsRejection,
  SnsVerifier,
  SubscriptionConfirmationResult,
} from '../mail/sns-verifier.js';
import { VirtualClock, type EpochMs } from '../../core/ports/clock.js';
import type { EmailSuppressor } from '../../core/ports/email-suppressor.js';
import { createHealthServer } from './health-server.js';
import { PROBLEM_CONTENT_TYPE, type ProblemLogEntry } from './problem.js';
import {
  registerSesFeedbackRoute,
  SES_FEEDBACK_BODY_LIMIT,
  SES_FEEDBACK_PATH,
  type SesFeedbackEvent,
} from './ses-feedback-route.js';

const NOW = '2026-10-13T09:00:00Z';
const TOPIC = 'arn:aws:sns:eu-central-1:123456789012:fire-watch-ses-feedback';
const ADDRESS = 'reader@example.invalid';

function envelope(overrides: Partial<SnsEnvelope> = {}): SnsEnvelope {
  return {
    type: 'Notification',
    messageId: 'sns-1',
    topicArn: TOPIC,
    message: JSON.stringify(bounce('Permanent')),
    timestamp: NOW,
    signatureVersion: '1',
    signature: 'c2lnbmF0dXJl',
    signingCertUrl: 'https://sns.eu-central-1.amazonaws.com/cert.pem',
    ...overrides,
  };
}

function bounce(bounceType: string): Record<string, unknown> {
  return {
    notificationType: 'Bounce',
    mail: { messageId: 'ses-1' },
    bounce: { bounceType, bouncedRecipients: [{ emailAddress: ADDRESS }] },
  };
}

interface Harness {
  readonly app: FastifyInstance;
  readonly events: SesFeedbackEvent[];
  readonly problems: ProblemLogEntry[];
  readonly suppressed: (readonly [string, EpochMs])[];
  readonly bodies: unknown[];
  readonly confirmed: SnsEnvelope[];
}

function harness(options: {
  readonly verdict?: { ok: true; envelope: SnsEnvelope } | { ok: false; reason: SnsRejection };
  readonly confirmation?: SubscriptionConfirmationResult;
  readonly suppressor?: EmailSuppressor;
  readonly app?: FastifyInstance;
}): Harness {
  const events: SesFeedbackEvent[] = [];
  const problems: ProblemLogEntry[] = [];
  const suppressed: (readonly [string, EpochMs])[] = [];
  const bodies: unknown[] = [];
  const confirmed: SnsEnvelope[] = [];
  const verifier: SnsVerifier = {
    verify: (body) => {
      bodies.push(body);
      return Promise.resolve(options.verdict ?? { ok: true, envelope: envelope() });
    },
    confirmSubscription: (verified) => {
      confirmed.push(verified);
      return Promise.resolve(options.confirmation ?? 'confirmed');
    },
  };
  const suppressor: EmailSuppressor = options.suppressor ?? {
    suppress: (address, at) => {
      suppressed.push([address, at]);
      return Promise.resolve(1);
    },
  };
  const app = options.app ?? Fastify();
  registerSesFeedbackRoute(app, {
    verifier,
    suppressor,
    clock: new VirtualClock(NOW),
    observe: (event) => events.push(event),
    onProblem: (entry) => problems.push(entry),
  });
  return { app, events, problems, suppressed, bodies, confirmed };
}

/** What SNS actually sends: a JSON document labelled text/plain. */
function post(app: FastifyInstance, body = '{"Type":"Notification"}') {
  return app.inject({
    method: 'POST',
    url: SES_FEEDBACK_PATH,
    headers: { 'content-type': 'text/plain; charset=UTF-8' },
    payload: body,
  });
}

describe('POST /api/v1/hooks/ses-feedback', () => {
  it('hands the raw text/plain body to the verifier', async () => {
    const h = harness({});
    const response = await post(h.app, '{"Type":"Notification","x":1}');
    expect(response.statusCode).toBe(200);
    expect(h.bodies).toEqual(['{"Type":"Notification","x":1}']);
  });

  it('applies a permanent bounce at the clock time and logs counts, not the address', async () => {
    const h = harness({});
    const response = await post(h.app);
    expect(response.statusCode).toBe(200);
    expect(h.suppressed).toEqual([[ADDRESS, Date.parse(NOW)]]);
    expect(h.events).toEqual([
      {
        outcome: 'applied',
        snsMessageId: 'sns-1',
        kind: 'bounce',
        type: 'Bounce',
        mailMessageId: 'ses-1',
        recipients: 1,
        suppressedAddresses: 1,
        ignoredAddresses: 0,
        revokedSubscriptions: 1,
        reasons: { permanent_bounce: 1 },
      },
    ]);
    expect(JSON.stringify(h.events)).not.toContain('example.invalid');
  });

  it('acknowledges a transient bounce without suppressing anything', async () => {
    const h = harness({
      verdict: { ok: true, envelope: envelope({ message: JSON.stringify(bounce('Transient')) }) },
    });
    expect((await post(h.app)).statusCode).toBe(200);
    expect(h.suppressed).toEqual([]);
    expect(h.events[0]).toMatchObject({ outcome: 'applied', ignoredAddresses: 1 });
  });

  it('acknowledges an unreadable feedback document, since a retry would be the same one', async () => {
    const h = harness({ verdict: { ok: true, envelope: envelope({ message: 'not json' }) } });
    expect((await post(h.app)).statusCode).toBe(200);
    expect(h.suppressed).toEqual([]);
    expect(h.events).toEqual([
      { outcome: 'unreadable_feedback', snsMessageId: 'sns-1', reason: 'message is not JSON' },
    ]);
  });

  it.each<SnsRejection>(['bad_signature', 'wrong_topic', 'stale', 'bad_cert_url', 'cert_expired'])(
    'refuses a message that fails verification (%s) with 401 and says nothing why',
    async (reason) => {
      const h = harness({ verdict: { ok: false, reason } });
      const response = await post(h.app);
      expect(response.statusCode).toBe(401);
      expect(response.headers['content-type']).toContain(PROBLEM_CONTENT_TYPE);
      expect(response.json()).toMatchObject({ code: 'webhook_unauthenticated' });
      expect(response.body).not.toContain(reason);
      expect(h.events).toEqual([{ outcome: 'refused', reason }]);
      expect(h.suppressed).toEqual([]);
    },
  );

  it.each<SnsRejection>(['malformed', 'unsupported_type', 'unsupported_signature_version'])(
    'refuses a body that is not an SNS envelope (%s) with 400',
    async (reason) => {
      const h = harness({ verdict: { ok: false, reason } });
      const response = await post(h.app);
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ code: 'request_refused' });
    },
  );

  it('answers 500 when the certificate could not be fetched, so SNS retries', async () => {
    const h = harness({ verdict: { ok: false, reason: 'cert_unavailable' } });
    const response = await post(h.app);
    expect(response.statusCode).toBe(500);
    expect(response.json()).toMatchObject({ code: 'internal_error' });
  });

  it('answers 500 when the database fails, so SNS retries', async () => {
    const h = harness({
      suppressor: { suppress: () => Promise.reject(new Error('connection terminated')) },
    });
    const response = await post(h.app);
    expect(response.statusCode).toBe(500);
    expect(response.body).not.toContain('connection terminated');
    expect(h.problems).toHaveLength(1);
    expect(h.events).toEqual([]);
  });

  it('confirms a verified subscription and answers 200', async () => {
    const confirmation = envelope({
      type: 'SubscriptionConfirmation',
      subscribeUrl: 'https://sns.eu-central-1.amazonaws.com/?Action=ConfirmSubscription',
      token: 't',
    });
    const h = harness({ verdict: { ok: true, envelope: confirmation } });
    expect((await post(h.app)).statusCode).toBe(200);
    expect(h.confirmed).toEqual([confirmation]);
    expect(h.events).toEqual([
      { outcome: 'subscription_confirmation', snsMessageId: 'sns-1', result: 'confirmed' },
    ]);
  });

  it('answers 500 when the confirmation GET fails, so SNS sends it again', async () => {
    const h = harness({
      verdict: { ok: true, envelope: envelope({ type: 'SubscriptionConfirmation' }) },
      confirmation: 'failed',
    });
    expect((await post(h.app)).statusCode).toBe(500);
  });

  it('refuses a confirmation whose SubscribeURL is not SNS', async () => {
    const h = harness({
      verdict: { ok: true, envelope: envelope({ type: 'SubscriptionConfirmation' }) },
      confirmation: 'bad_subscribe_url',
    });
    expect((await post(h.app)).statusCode).toBe(401);
  });

  it('acknowledges an unsubscribe confirmation and does nothing else', async () => {
    const h = harness({
      verdict: { ok: true, envelope: envelope({ type: 'UnsubscribeConfirmation' }) },
    });
    expect((await post(h.app)).statusCode).toBe(200);
    expect(h.confirmed).toEqual([]);
    expect(h.suppressed).toEqual([]);
    expect(h.events).toEqual([{ outcome: 'unsubscribe_confirmation', snsMessageId: 'sns-1' }]);
  });

  it('accepts an application/json body as well', async () => {
    const h = harness({});
    const response = await h.app.inject({
      method: 'POST',
      url: SES_FEEDBACK_PATH,
      payload: { Type: 'Notification' },
    });
    expect(response.statusCode).toBe(200);
    expect(h.bodies).toEqual([{ Type: 'Notification' }]);
  });
});

describe('the SES feedback hook on the probe server', () => {
  function probeServer(): FastifyInstance {
    return createHealthServer({
      reader: { readObservations: () => Promise.resolve([]) },
      probe: { ping: () => Promise.resolve() },
      clock: new VirtualClock(NOW),
      expected: [],
      rateLimit: { limit: 1, windowMs: 60_000 },
    });
  }

  it('does not exist unless registered', async () => {
    const response = await post(probeServer());
    expect(response.statusCode).toBe(404);
  });

  it('takes a body far over the probe server global limit', async () => {
    const h = harness({ app: probeServer() });
    const big = JSON.stringify({ Type: 'Notification', padding: 'x'.repeat(200_000) });
    expect(big.length).toBeLessThan(SES_FEEDBACK_BODY_LIMIT);
    expect((await post(h.app, big)).statusCode).toBe(200);
    await h.app.close();
  });

  it('is exempt from the probe limiter', async () => {
    const h = harness({ app: probeServer() });
    const statuses: number[] = [];
    for (let i = 0; i < 3; i += 1) statuses.push((await post(h.app)).statusCode);
    expect(statuses).toEqual([200, 200, 200]);
    await h.app.close();
  });
});
