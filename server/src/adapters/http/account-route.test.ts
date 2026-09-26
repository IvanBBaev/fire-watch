import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import type { ErasureOutcome } from '../../core/erasure/erase-account.js';
import {
  epochMsFromIso,
  isoFromEpochMs,
  VirtualClock,
  type EpochMs,
} from '../../core/ports/clock.js';
import { ACCOUNT_PATH, registerAccountRoutes, type AccountRouteDeps } from './account-route.js';
import type { ProblemLogEntry } from './problem.js';
import { SESSION_COOKIE_NAME } from './session-cookie.js';

const ORIGIN = 'https://fire-watch.example';
const CLOCK = new VirtualClock('2026-08-20T05:20:00Z');
const TOKEN = 'S'.repeat(43);
const COOKIE = `${SESSION_COOKIE_NAME}=${TOKEN}`;
const ACCOUNT = '77777777-0000-4000-8000-000000000001';
const THIRTY_DAYS = 30 * 86_400_000;

const apps: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

function build(overrides: Partial<AccountRouteDeps> = {}) {
  const erased: { accountId: string; at: EpochMs }[] = [];
  const problems: ProblemLogEntry[] = [];
  const deps: AccountRouteDeps = {
    authenticate: (token, at) =>
      Promise.resolve(
        token === TOKEN
          ? { sessionId: 'sid', accountId: ACCOUNT, expiresAt: at + THIRTY_DAYS }
          : null,
      ),
    erase: (accountId, at): Promise<ErasureOutcome> => {
      erased.push({ accountId, at });
      return Promise.resolve({ status: 'already_erased' });
    },
    allowedOrigins: [ORIGIN],
    clock: CLOCK,
    onProblem: (entry) => problems.push(entry),
    ...overrides,
  };
  const app = Fastify({ logger: false });
  registerAccountRoutes(app, deps);
  apps.push(app);
  return { app, erased, problems };
}

describe('DELETE /api/v1/account', () => {
  it('erases the session account, answers 204 and clears the cookie', async () => {
    const { app, erased } = build();
    const response = await app.inject({
      method: 'DELETE',
      url: ACCOUNT_PATH,
      headers: { cookie: COOKIE, origin: ORIGIN },
    });
    expect(response.statusCode).toBe(204);
    expect(response.body).toBe('');
    expect(response.headers['set-cookie']).toMatch(/Max-Age=0$/);
    expect(erased).toEqual([{ accountId: ACCOUNT, at: epochMsFromIso('2026-08-20T05:20:00Z') }]);
  });

  it('401 without a cookie; nothing is erased and no cookie is set', async () => {
    const { app, erased } = build();
    const response = await app.inject({
      method: 'DELETE',
      url: ACCOUNT_PATH,
      headers: { origin: ORIGIN },
    });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ code: 'not_signed_in' });
    expect(response.headers['set-cookie']).toBeUndefined();
    expect(erased).toEqual([]);
  });

  it('401 with a dead cookie, which is cleared', async () => {
    const { app, erased } = build();
    const response = await app.inject({
      method: 'DELETE',
      url: ACCOUNT_PATH,
      headers: { cookie: `${SESSION_COOKIE_NAME}=dead`, origin: ORIGIN },
    });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ code: 'not_signed_in' });
    expect(response.headers['set-cookie']).toMatch(/Max-Age=0$/);
    expect(erased).toEqual([]);
  });

  it('403 on a foreign Origin, before authenticating or erasing', async () => {
    let authenticated = 0;
    const { app, erased } = build({
      authenticate: () => {
        authenticated += 1;
        return Promise.resolve(null);
      },
    });
    const response = await app.inject({
      method: 'DELETE',
      url: ACCOUNT_PATH,
      headers: { cookie: COOKIE, origin: 'https://evil.example' },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ code: 'origin_refused' });
    expect(authenticated).toBe(0);
    expect(erased).toEqual([]);
  });

  it('takes no account id from the request: a query or body naming another is ignored', async () => {
    const { app, erased } = build();
    await app.inject({
      method: 'DELETE',
      url: `${ACCOUNT_PATH}?accountId=someone-else`,
      headers: { cookie: COOKIE, origin: ORIGIN },
    });
    expect(erased.map((entry) => entry.accountId)).toEqual([ACCOUNT]);
  });

  it('a failing erasure is a 500 problem, keeps the cookie, and reaches the observer', async () => {
    const { app, problems } = build({
      erase: () => Promise.reject(new Error('deadlock detected')),
    });
    const response = await app.inject({
      method: 'DELETE',
      url: ACCOUNT_PATH,
      headers: { cookie: COOKIE, origin: ORIGIN },
    });
    expect(response.statusCode).toBe(500);
    expect(response.json()).toMatchObject({ code: 'internal_error' });
    expect(response.headers['content-type']).toMatch(/application\/problem\+json/);
    expect(response.body).not.toContain('deadlock');
    expect(response.headers['set-cookie']).toBeUndefined();
    expect(problems).toHaveLength(1);
  });
});

describe('GET /api/v1/account', () => {
  it('answers signed-in with the slid expiry, re-issues the cookie, and names nobody', async () => {
    const { app, erased } = build();
    const response = await app.inject({
      method: 'GET',
      url: ACCOUNT_PATH,
      headers: { cookie: COOKIE },
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    const expiresAt = epochMsFromIso('2026-08-20T05:20:00Z') + THIRTY_DAYS;
    expect(response.json()).toEqual({
      signed_in: true,
      session_expires_at: isoFromEpochMs(expiresAt),
    });
    expect(response.body).not.toContain(ACCOUNT);
    expect(response.headers['set-cookie']).toContain(`${SESSION_COOKIE_NAME}=${TOKEN}`);
    expect(erased).toEqual([]);
  });

  it('401 without a cookie, and no cookie is set', async () => {
    const { app } = build();
    const response = await app.inject({ method: 'GET', url: ACCOUNT_PATH });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ code: 'not_signed_in' });
    expect(response.headers['content-type']).toMatch(/application\/problem\+json/);
    expect(response.headers['set-cookie']).toBeUndefined();
  });

  it('401 with a dead cookie, which is cleared', async () => {
    const { app } = build();
    const response = await app.inject({
      method: 'GET',
      url: ACCOUNT_PATH,
      headers: { cookie: `${SESSION_COOKIE_NAME}=dead` },
    });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ code: 'not_signed_in' });
    expect(response.headers['set-cookie']).toMatch(/Max-Age=0$/);
  });

  it('is a GET, so a cross-site Origin is not refused (and nothing changes)', async () => {
    const { app, erased } = build();
    const response = await app.inject({
      method: 'GET',
      url: ACCOUNT_PATH,
      headers: { cookie: COOKIE, origin: 'https://evil.example' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers['access-control-allow-origin']).toBeUndefined();
    expect(erased).toEqual([]);
  });
});
