import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import {
  buildAccountExport,
  type AccountExportOutcome,
} from '../../core/account-export/build-account-export.js';
import { createRateLimiter } from '../../core/http/rate-limiter.js';
import { epochMsFromIso, VirtualClock, type EpochMs } from '../../core/ports/clock.js';
import {
  ACCOUNT_EXPORT_PATH,
  exportFileName,
  registerAccountExportRoutes,
  type AccountExportRouteDeps,
} from './account-export-route.js';
import type { ProblemLogEntry } from './problem.js';
import { SESSION_COOKIE_NAME } from './session-cookie.js';

const CLOCK = new VirtualClock('2026-09-24T08:00:00Z');
const TOKEN = 'S'.repeat(43);
const COOKIE = `${SESSION_COOKIE_NAME}=${TOKEN}`;
const ACCOUNT = '77777777-0000-4000-8000-000000000001';
const THIRTY_DAYS = 30 * 86_400_000;

const apps: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

/** A real `account_export_v1` document over an empty account, built by the core. */
async function emptyExport(accountId: string, at: EpochMs): Promise<AccountExportOutcome> {
  const row: Record<string, null | string | boolean> = {
    id: accountId,
    email: null,
    email_verified_at: null,
    timezone: 'Europe/Sofia',
    quiet_hours_start: '22:00',
    quiet_hours_end: '07:00',
    new_fire_overrides_quiet_hours: true,
    created_at: '2026-06-01T10:00:00Z',
    deleted_at: null,
  };
  return buildAccountExport(
    accountId,
    at,
    {
      readAccount: () => Promise.resolve({ state: 'live', row, email: null }),
      readZones: () => Promise.resolve([]),
      readRows: () => Promise.resolve([]),
    },
    {
      seal: () => {
        throw new Error('not used');
      },
      open: () => {
        throw new Error('not used');
      },
    },
  );
}

function build(overrides: Partial<AccountExportRouteDeps> = {}) {
  const exported: { accountId: string; at: EpochMs }[] = [];
  const problems: ProblemLogEntry[] = [];
  const deps: AccountExportRouteDeps = {
    authenticate: (token, at) =>
      Promise.resolve(
        token === TOKEN
          ? { sessionId: 'sid', accountId: ACCOUNT, expiresAt: at + THIRTY_DAYS }
          : null,
      ),
    exportAccount: (accountId, at) => {
      exported.push({ accountId, at });
      return emptyExport(accountId, at);
    },
    allowedOrigins: ['https://fire-watch.example'],
    clock: CLOCK,
    onProblem: (entry) => problems.push(entry),
    ...overrides,
  };
  const app = Fastify({ logger: false });
  registerAccountExportRoutes(app, deps);
  apps.push(app);
  return { app, exported, problems };
}

describe('GET /api/v1/account/export', () => {
  it('answers the session account as a JSON attachment nothing may cache', async () => {
    const { app, exported } = build();
    const response = await app.inject({
      method: 'GET',
      url: ACCOUNT_EXPORT_PATH,
      headers: { cookie: COOKIE },
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toBe('application/json; charset=utf-8');
    expect(response.headers['content-disposition']).toBe(
      'attachment; filename="fire-watch-account-export-2026-09-24.json"',
    );
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    // The sliding session is re-issued, as on the zones routes.
    expect(response.headers['set-cookie']).toMatch(new RegExp(`^${SESSION_COOKIE_NAME}=${TOKEN}`));
    const document = response.json<Record<string, unknown>>();
    expect(document['format']).toBe('account_export_v1');
    expect(document['account_id']).toBe(ACCOUNT);
    expect(exported).toEqual([{ accountId: ACCOUNT, at: epochMsFromIso('2026-09-24T08:00:00Z') }]);
  });

  it('401 without a cookie; nothing is read and no cookie is set', async () => {
    const { app, exported } = build();
    const response = await app.inject({ method: 'GET', url: ACCOUNT_EXPORT_PATH });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ code: 'not_signed_in' });
    expect(response.headers['content-type']).toMatch(/application\/problem\+json/);
    expect(response.headers['set-cookie']).toBeUndefined();
    expect(exported).toEqual([]);
  });

  it('401 with a dead cookie, which is cleared', async () => {
    const { app, exported } = build();
    const response = await app.inject({
      method: 'GET',
      url: ACCOUNT_EXPORT_PATH,
      headers: { cookie: `${SESSION_COOKIE_NAME}=dead` },
    });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ code: 'not_signed_in' });
    expect(response.headers['set-cookie']).toMatch(/Max-Age=0$/);
    expect(exported).toEqual([]);
  });

  it('takes no account id from the request: a query naming another is ignored', async () => {
    const { app, exported } = build();
    await app.inject({
      method: 'GET',
      url: `${ACCOUNT_EXPORT_PATH}?accountId=someone-else`,
      headers: { cookie: COOKIE },
    });
    expect(exported.map((entry) => entry.accountId)).toEqual([ACCOUNT]);
  });

  it('404 when the account is gone by the time the snapshot is read', async () => {
    const { app } = build({ exportAccount: () => Promise.resolve({ status: 'erased' }) });
    const response = await app.inject({
      method: 'GET',
      url: ACCOUNT_EXPORT_PATH,
      headers: { cookie: COOKIE },
    });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ code: 'account_not_found' });
    expect(response.headers['content-disposition']).toBeUndefined();
  });

  it('a failing export is a 500 problem that leaks nothing and reaches the observer', async () => {
    const { app, problems } = build({
      exportAccount: () => Promise.reject(new Error('could not serialize access')),
    });
    const response = await app.inject({
      method: 'GET',
      url: ACCOUNT_EXPORT_PATH,
      headers: { cookie: COOKIE },
    });
    expect(response.statusCode).toBe(500);
    expect(response.json()).toMatchObject({ code: 'internal_error' });
    expect(response.headers['content-type']).toMatch(/application\/problem\+json/);
    expect(response.body).not.toContain('serialize');
    expect(response.headers['content-disposition']).toBeUndefined();
    expect(problems).toHaveLength(1);
  });
});

describe('GET /api/v1/account/export — per-account limit', () => {
  it('429 with Retry-After once the account has used its window, before any read', async () => {
    const { app, exported } = build({
      limiter: createRateLimiter({ limit: 2, windowMs: 3_600_000 }),
    });
    const get = () =>
      app.inject({ method: 'GET', url: ACCOUNT_EXPORT_PATH, headers: { cookie: COOKIE } });
    expect((await get()).statusCode).toBe(200);
    expect((await get()).statusCode).toBe(200);
    const refused = await get();
    expect(refused.statusCode).toBe(429);
    expect(refused.json()).toMatchObject({ code: 'rate_limited' });
    expect(refused.headers['content-type']).toMatch(/application\/problem\+json/);
    expect(refused.headers['retry-after']).toBe('3600');
    expect(refused.headers['content-disposition']).toBeUndefined();
    expect(exported).toHaveLength(2);
  });

  it('never spends the limit on a request without a session', async () => {
    const { app, exported } = build({
      limiter: createRateLimiter({ limit: 1, windowMs: 3_600_000 }),
    });
    await app.inject({ method: 'GET', url: ACCOUNT_EXPORT_PATH });
    await app.inject({ method: 'GET', url: ACCOUNT_EXPORT_PATH });
    const response = await app.inject({
      method: 'GET',
      url: ACCOUNT_EXPORT_PATH,
      headers: { cookie: COOKIE },
    });
    expect(response.statusCode).toBe(200);
    expect(exported).toHaveLength(1);
  });
});

describe('exportFileName', () => {
  it('is the UTC day, even late in the Sofia evening', () => {
    expect(exportFileName(epochMsFromIso('2026-09-24T22:30:00Z'))).toBe(
      'fire-watch-account-export-2026-09-24.json',
    );
  });
});
