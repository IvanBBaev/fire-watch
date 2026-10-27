import { ACCOUNT_PREFERENCES_MAX_BYTES, ACCOUNT_PREFERENCES_SCHEMA } from '@fire-watch/contracts';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import {
  readAccountPreferences,
  writeAccountPreferences,
} from '../../core/preferences/account-preferences.js';
import type {
  AccountPreferencesStore,
  StoredAccountPreferences,
} from '../../core/ports/account-preferences-store.js';
import { VirtualClock } from '../../core/ports/clock.js';
import {
  ACCOUNT_PREFERENCES_PATH,
  registerAccountPreferencesRoutes,
  type AccountPreferencesRouteDeps,
} from './account-preferences-route.js';
import { SESSION_COOKIE_NAME } from './session-cookie.js';

const ORIGIN = 'https://fire-watch.example';
const CLOCK = new VirtualClock('2026-10-27T08:00:00Z');
const TOKEN = 'S'.repeat(43);
const COOKIE = `${SESSION_COOKIE_NAME}=${TOKEN}`;
const ACCOUNT = '77777777-0000-4000-8000-000000000001';
const THIRTY_DAYS = 30 * 86_400_000;

const DARK = { schema: ACCOUNT_PREFERENCES_SCHEMA, preferences: { theme: 'dark' } };
const LIGHT = {
  schema: ACCOUNT_PREFERENCES_SCHEMA,
  preferences: { theme: 'light', overlays: ['wind'] },
};

/** The store's contract in memory: a conditional write, nothing merged. */
function memoryStore(): AccountPreferencesStore & {
  readonly rows: Map<string, StoredAccountPreferences>;
  readonly writes: { accountId: string; atIso: string }[];
} {
  const rows = new Map<string, StoredAccountPreferences>();
  const writes: { accountId: string; atIso: string }[] = [];
  return {
    rows,
    writes,
    read: (accountId) => Promise.resolve(rows.get(accountId) ?? null),
    write: (accountId, document, expectedRevision, atIso) => {
      const current = rows.get(accountId)?.revision ?? 0;
      if (current !== expectedRevision) return Promise.resolve(null);
      rows.set(accountId, { revision: current + 1, document });
      writes.push({ accountId, atIso });
      return Promise.resolve(current + 1);
    },
  };
}

const apps: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

function build(overrides: Partial<AccountPreferencesRouteDeps> = {}) {
  const store = memoryStore();
  const deps: AccountPreferencesRouteDeps = {
    authenticate: (token, at) =>
      Promise.resolve(
        token === TOKEN
          ? { sessionId: 'sid', accountId: ACCOUNT, expiresAt: at + THIRTY_DAYS }
          : null,
      ),
    read: (accountId) => readAccountPreferences(accountId, store),
    write: (request, atIso) => writeAccountPreferences(request, atIso, store),
    allowedOrigins: [ORIGIN],
    clock: CLOCK,
    ...overrides,
  };
  const app = Fastify({ logger: false });
  registerAccountPreferencesRoutes(app, deps);
  apps.push(app);
  return { app, store };
}

function put(app: FastifyInstance, body: unknown, ifMatch: string | undefined, origin = ORIGIN) {
  return app.inject({
    method: 'PUT',
    url: ACCOUNT_PREFERENCES_PATH,
    headers: {
      cookie: COOKIE,
      origin,
      'content-type': 'application/json',
      ...(ifMatch === undefined ? {} : { 'if-match': ifMatch }),
    },
    payload: JSON.stringify(body),
  });
}

describe('GET /api/v1/account/preferences', () => {
  it('answers revision 0 and the empty document when nothing is stored', async () => {
    const { app } = build();
    const response = await app.inject({
      method: 'GET',
      url: ACCOUNT_PREFERENCES_PATH,
      headers: { cookie: COOKIE },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      revision: 0,
      document: { schema: ACCOUNT_PREFERENCES_SCHEMA, preferences: {} },
    });
    expect(response.headers['etag']).toBe('"0"');
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers['set-cookie']).toMatch(new RegExp(`^${SESSION_COOKIE_NAME}=${TOKEN}`));
  });

  it('serves a stored row that no longer parses as empty, keeping its revision', async () => {
    const { app, store } = build();
    store.rows.set(ACCOUNT, { revision: 5, document: { schema: 'account_preferences_v9' } });
    const response = await app.inject({
      method: 'GET',
      url: ACCOUNT_PREFERENCES_PATH,
      headers: { cookie: COOKIE },
    });
    expect(response.json()).toEqual({
      revision: 5,
      document: { schema: ACCOUNT_PREFERENCES_SCHEMA, preferences: {} },
    });
    expect(response.headers['etag']).toBe('"5"');
  });

  it('401 without a session', async () => {
    const { app } = build();
    const response = await app.inject({ method: 'GET', url: ACCOUNT_PREFERENCES_PATH });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ code: 'not_signed_in' });
  });
});

describe('PUT /api/v1/account/preferences', () => {
  it('creates from "0", then updates from the revision it answered', async () => {
    const { app, store } = build();
    const first = await put(app, DARK, '"0"');
    expect(first.statusCode).toBe(200);
    expect(first.json()).toEqual({ revision: 1, document: DARK });
    expect(first.headers['etag']).toBe('"1"');

    const second = await put(app, LIGHT, first.headers['etag']);
    expect(second.statusCode).toBe(200);
    expect(second.json()).toEqual({ revision: 2, document: LIGHT });
    expect(store.rows.get(ACCOUNT)).toEqual({ revision: 2, document: LIGHT });
    expect(store.writes.map((w) => w.atIso)).toEqual([
      '2026-10-27T08:00:00Z',
      '2026-10-27T08:00:00Z',
    ]);
  });

  it('409 when another device wrote first, leaving its write in place', async () => {
    const { app, store } = build();
    await put(app, DARK, '"0"');
    await put(app, LIGHT, '"1"');
    const stale = await put(app, DARK, '"1"');
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({ code: 'preferences_conflict' });
    expect(stale.headers['cache-control']).toBe('no-store');
    expect(store.rows.get(ACCOUNT)?.document).toEqual(LIGHT);
  });

  it('409 on a second first write', async () => {
    const { app } = build();
    await put(app, DARK, '"0"');
    expect((await put(app, LIGHT, '"0"')).statusCode).toBe(409);
  });

  it.each([undefined, '*', '1', 'W/"1"', '"abc"'])(
    '428 for If-Match %j, before anything is written',
    async (ifMatch) => {
      const { app, store } = build();
      const response = await put(app, DARK, ifMatch);
      expect(response.statusCode).toBe(428);
      expect(response.json()).toMatchObject({ code: 'preferences_revision_required' });
      expect(store.writes).toEqual([]);
    },
  );

  it.each([
    ['an unknown member', { ...DARK, preferences: { camera: [1, 2, 3] } }],
    ['a wrong schema', { ...DARK, schema: 'account_preferences_v2' }],
    ['a wrong type', { ...DARK, preferences: { theme: 3 } }],
    ['not an object', ['theme']],
  ])('422 for %s', async (_label, body) => {
    const { app, store } = build();
    const response = await put(app, body, '"0"');
    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({ code: 'preferences_invalid' });
    expect(response.body).not.toContain('camera');
    expect(store.writes).toEqual([]);
  });

  it('refuses an oversized body before parsing it', async () => {
    const { app, store } = build();
    const response = await put(
      app,
      { ...DARK, preferences: { age_window: 'x'.repeat(3 * ACCOUNT_PREFERENCES_MAX_BYTES) } },
      '"0"',
    );
    expect(response.statusCode).toBe(413);
    expect(response.json()).toMatchObject({ code: 'request_refused' });
    expect(store.writes).toEqual([]);
  });

  it('403 on a foreign Origin, before authenticating', async () => {
    let authenticated = 0;
    const { app } = build({
      authenticate: () => {
        authenticated += 1;
        return Promise.resolve(null);
      },
    });
    const response = await put(app, DARK, '"0"', 'https://evil.example');
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ code: 'origin_refused' });
    expect(authenticated).toBe(0);
  });

  it('401 with a dead cookie, which is cleared', async () => {
    const { app, store } = build({ authenticate: () => Promise.resolve(null) });
    const response = await put(app, DARK, '"0"');
    expect(response.statusCode).toBe(401);
    expect(response.headers['set-cookie']).toMatch(/Max-Age=0$/);
    expect(store.writes).toEqual([]);
  });

  it('writes only the session account, whatever the request names', async () => {
    const { app, store } = build();
    await app.inject({
      method: 'PUT',
      url: `${ACCOUNT_PREFERENCES_PATH}?accountId=someone-else`,
      headers: {
        cookie: COOKIE,
        origin: ORIGIN,
        'content-type': 'application/json',
        'if-match': '"0"',
      },
      payload: JSON.stringify(DARK),
    });
    expect(store.writes.map((w) => w.accountId)).toEqual([ACCOUNT]);
  });
});
