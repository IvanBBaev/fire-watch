import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { createRateLimiter } from '../../core/http/rate-limiter.js';
import { VirtualClock } from '../../core/ports/clock.js';
import type { WebhookEndpointView } from '../../core/ports/webhook-store.js';
import type { WebhookPingResult } from '../webhooks/webhook-pinger.js';
import { WebhookRegistrationError } from '../webhooks/webhook-registry.js';
import type { ProblemLogEntry } from './problem.js';
import { SESSION_COOKIE_NAME } from './session-cookie.js';
import { registerWebhooksRoutes, WEBHOOKS_PATH, type WebhooksRouteDeps } from './webhooks-route.js';

const ORIGIN = 'https://fire-watch.example';
const CLOCK = new VirtualClock('2026-10-27T12:00:00Z');
const TOKEN = 'S'.repeat(43);
const COOKIE = `${SESSION_COOKIE_NAME}=${TOKEN}`;
const ACCOUNT = '35353535-0000-4000-8000-0000000000bb';
const ENDPOINT = '35353535-0000-4000-8000-0000000000aa';
const OTHER = '35353535-0000-4000-8000-0000000000dd';
const THIRTY_DAYS = 30 * 86_400_000;
const RECEIVER_URL = 'https://hooks.example-receiver.com/in/receiver-token-123';
/** What the stub registry hands out; a placeholder, never a credential. */
const ISSUED = ['whsec', 'placeholder', 'route'].join('_');

const VIEW: WebhookEndpointView = {
  id: ENDPOINT,
  url: RECEIVER_URL,
  createdAtMs: CLOCK.now(),
  secretRotatedAtMs: CLOCK.now(),
  confirmed: false,
  disabledAtMs: null,
  disabledReason: null,
  consecutiveFailures: 0,
  lastSuccessAtMs: null,
  lastFailureAtMs: null,
};

const PINGED: WebhookPingResult = {
  deliveryId: '35353535-0000-4000-8000-0000000000cc',
  outcome: 'delivered',
  statusCode: 200,
  error: null,
  durationMs: 41,
  confirmed: true,
};

const apps: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

function build(overrides: Partial<WebhooksRouteDeps> = {}) {
  const calls: string[] = [];
  const problems: ProblemLogEntry[] = [];
  const owns = (accountId: string, id: string) => accountId === ACCOUNT && id === ENDPOINT;
  const deps: WebhooksRouteDeps = {
    authenticate: (token, at) =>
      Promise.resolve(
        token === TOKEN
          ? { sessionId: 'sid', accountId: ACCOUNT, expiresAt: at + THIRTY_DAYS }
          : null,
      ),
    create: (accountId, url) => {
      calls.push(`create ${accountId} ${url}`);
      return Promise.resolve({ endpoint: VIEW, secret: ISSUED });
    },
    list: (accountId) => Promise.resolve(accountId === ACCOUNT ? [VIEW] : []),
    remove: (accountId, id) => {
      calls.push(`remove ${id}`);
      return Promise.resolve(owns(accountId, id));
    },
    rotateSecret: (accountId, id, at) => {
      calls.push(`rotate ${id}`);
      return Promise.resolve(owns(accountId, id) ? { secret: ISSUED, rotatedAtMs: at } : null);
    },
    ping: (accountId, id) => {
      calls.push(`ping ${id}`);
      return Promise.resolve(owns(accountId, id) ? PINGED : null);
    },
    allowedOrigins: [ORIGIN],
    clock: CLOCK,
    onProblem: (entry) => problems.push(entry),
    ...overrides,
  };
  const app = Fastify({ logger: false });
  registerWebhooksRoutes(app, deps);
  apps.push(app);
  return { app, calls, problems };
}

const post = (url: string, payload?: unknown) => ({
  method: 'POST' as const,
  url,
  headers: { cookie: COOKIE, origin: ORIGIN },
  ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
});

describe('webhook routes', () => {
  it('401 without a session, before any work', async () => {
    const { app, calls } = build();
    const response = await app.inject({
      method: 'POST',
      url: WEBHOOKS_PATH,
      headers: { origin: ORIGIN },
      payload: { url: RECEIVER_URL },
    });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ code: 'not_signed_in' });
    expect(calls).toEqual([]);
  });

  it('refuses a foreign Origin on a state-changing route', async () => {
    const { app, calls } = build();
    const response = await app.inject({
      ...post(`${WEBHOOKS_PATH}/${ENDPOINT}/test`),
      headers: { cookie: COOKIE, origin: 'https://evil.example' },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ code: 'origin_refused' });
    expect(calls).toEqual([]);
  });

  it('lists endpoints without secrets, snake_case', async () => {
    const { app } = build();
    const response = await app.inject({
      method: 'GET',
      url: WEBHOOKS_PATH,
      headers: { cookie: COOKIE },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      endpoints: [
        {
          id: ENDPOINT,
          url: RECEIVER_URL,
          confirmed: false,
          created_at: '2026-10-27T12:00:00Z',
          secret_rotated_at: '2026-10-27T12:00:00Z',
          disabled_at: null,
          disabled_reason: null,
          consecutive_failures: 0,
          last_success_at: null,
          last_failure_at: null,
        },
      ],
    });
    expect(response.body).not.toContain(ISSUED);
  });

  it('creates for the session’s account and returns the secret once, no-store', async () => {
    const { app, calls } = build();
    const response = await app.inject(post(WEBHOOKS_PATH, { url: RECEIVER_URL, account: OTHER }));
    expect(response.statusCode).toBe(201);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(calls).toEqual([`create ${ACCOUNT} ${RECEIVER_URL}`]);
    expect(response.json()).toMatchObject({
      endpoint: { id: ENDPOINT, confirmed: false },
      secret: ISSUED,
      signature_header: 'X-FireWatch-Signature',
    });
  });

  it.each([[{}], [{ url: 42 }], [{ url: 'x'.repeat(9_000) }]])(
    'refuses a malformed body %#',
    async (payload) => {
      const { app, calls } = build();
      const response = await app.inject(post(WEBHOOKS_PATH, payload));
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ code: 'invalid_body' });
      expect(calls).toEqual([]);
    },
  );

  it('maps registry refusals without echoing the URL', async () => {
    const refusing = (refusal: WebhookRegistrationError['refusal']) =>
      build({ create: () => Promise.reject(new WebhookRegistrationError(refusal)) });

    const invalid = await refusing({ kind: 'url_invalid', reason: 'private_address' }).app.inject(
      post(WEBHOOKS_PATH, { url: RECEIVER_URL }),
    );
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json()).toMatchObject({ code: 'webhook_url_invalid' });
    expect(invalid.body).not.toContain('receiver-token-123');

    const full = await refusing({ kind: 'limit_reached', limit: 5 }).app.inject(
      post(WEBHOOKS_PATH, { url: RECEIVER_URL }),
    );
    expect(full.statusCode).toBe(409);
    expect(full.json()).toMatchObject({ code: 'webhook_limit_reached' });
  });

  it('deletes an owned endpoint, and 404s a foreign or malformed id alike', async () => {
    const { app, calls } = build();
    const del = (id: string) =>
      app.inject({
        method: 'DELETE',
        url: `${WEBHOOKS_PATH}/${id}`,
        headers: { cookie: COOKIE, origin: ORIGIN },
      });
    expect((await del(ENDPOINT)).statusCode).toBe(204);
    const foreign = await del(OTHER);
    expect(foreign.statusCode).toBe(404);
    expect(foreign.json()).toMatchObject({ code: 'webhook_endpoint_not_found' });
    expect((await del('not-a-uuid')).statusCode).toBe(404);
    expect(calls).toEqual([`remove ${ENDPOINT}`, `remove ${OTHER}`]);
  });

  it('rotates the secret, shown once, no-store', async () => {
    const { app } = build();
    const response = await app.inject(post(`${WEBHOOKS_PATH}/${ENDPOINT}/rotate-secret`));
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.json()).toEqual({
      secret: ISSUED,
      secret_rotated_at: '2026-10-27T12:00:00Z',
    });
    const foreign = await app.inject(post(`${WEBHOOKS_PATH}/${OTHER}/rotate-secret`));
    expect(foreign.statusCode).toBe(404);
  });

  it('sends a test ping and reports its outcome as data', async () => {
    const { app } = build();
    const response = await app.inject(post(`${WEBHOOKS_PATH}/${ENDPOINT}/test`));
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      delivery_id: PINGED.deliveryId,
      outcome: 'delivered',
      status_code: 200,
      error: null,
      duration_ms: 41,
      confirmed: true,
    });
    expect((await app.inject(post(`${WEBHOOKS_PATH}/${OTHER}/test`))).statusCode).toBe(404);
  });

  it('limits test pings per account', async () => {
    const { app, calls } = build({
      pingLimiter: createRateLimiter({ limit: 1, windowMs: 60_000 }),
    });
    expect((await app.inject(post(`${WEBHOOKS_PATH}/${ENDPOINT}/test`))).statusCode).toBe(200);
    const limited = await app.inject(post(`${WEBHOOKS_PATH}/${ENDPOINT}/test`));
    expect(limited.statusCode).toBe(429);
    expect(limited.json()).toMatchObject({ code: 'rate_limited' });
    expect(limited.headers['retry-after']).toBeDefined();
    expect(calls).toEqual([`ping ${ENDPOINT}`]);
  });
});
