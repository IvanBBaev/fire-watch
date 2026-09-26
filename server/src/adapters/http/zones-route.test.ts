import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { VirtualClock } from '../../core/ports/clock.js';
import {
  ZoneRequestError,
  type CreatedWatchZone,
  type CreateWatchZoneRequest,
  type OwnedWatchZone,
} from '../../core/zones/create-watch-zone.js';
import type { ProblemLogEntry } from './problem.js';
import { SESSION_COOKIE_NAME } from './session-cookie.js';
import { registerZonesRoutes, ZONES_PATH, type ZonesRouteDeps } from './zones-route.js';

const ORIGIN = 'https://fire-watch.example';
const CLOCK = new VirtualClock('2026-08-20T05:20:00Z');
const TOKEN = 'S'.repeat(43);
const COOKIE = `${SESSION_COOKIE_NAME}=${TOKEN}`;
const ACCOUNT = '77777777-0000-4000-8000-000000000001';
const ZONE = '77777777-0000-4000-8000-0000000000aa';
const THIRTY_DAYS = 30 * 86_400_000;

const OWNED: OwnedWatchZone = {
  zoneId: ZONE,
  name: 'Home',
  radiusM: 10_000,
  minScore: 0.45,
  coarsened: true,
  storedCentre: { lat: 42.69, lon: 23.32 },
  createdAtIso: '2026-08-20T05:20:00Z',
};

const apps: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

function build(overrides: Partial<ZonesRouteDeps> = {}) {
  const created: CreateWatchZoneRequest[] = [];
  const removed: string[] = [];
  const problems: ProblemLogEntry[] = [];
  const deps: ZonesRouteDeps = {
    authenticate: (token, at) =>
      Promise.resolve(
        token === TOKEN
          ? { sessionId: 'sid', accountId: ACCOUNT, expiresAt: at + THIRTY_DAYS }
          : null,
      ),
    create: (request) => {
      created.push(request);
      const zone: CreatedWatchZone = {
        ...OWNED,
        seed: {
          zoneId: ZONE,
          seededAtIso: OWNED.createdAtIso,
          upserts: [],
          onboarding: [{ zoneId: ZONE, eventPublicId: 'evt-1', distanceKm: 3.2 }],
          skipped: [],
          decisions: [],
        },
      };
      return Promise.resolve(zone);
    },
    list: (accountId) => Promise.resolve(accountId === ACCOUNT ? [OWNED] : []),
    remove: (_accountId, zoneId) => {
      removed.push(zoneId);
      return Promise.resolve(zoneId === ZONE);
    },
    allowedOrigins: [ORIGIN],
    clock: CLOCK,
    onProblem: (entry) => problems.push(entry),
    ...overrides,
  };
  const app = Fastify({ logger: false });
  registerZonesRoutes(app, deps);
  apps.push(app);
  return { app, created, removed, problems };
}

describe('sessions', () => {
  it('401 without a cookie, and no cookie is set', async () => {
    const { app } = build();
    const response = await app.inject({ method: 'GET', url: ZONES_PATH });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ code: 'not_signed_in' });
    expect(response.headers['set-cookie']).toBeUndefined();
  });

  it('401 with a dead cookie, which is cleared', async () => {
    const { app } = build();
    const response = await app.inject({
      method: 'GET',
      url: ZONES_PATH,
      headers: { cookie: `${SESSION_COOKIE_NAME}=dead` },
    });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ code: 'not_signed_in' });
    expect(response.headers['set-cookie']).toMatch(/Max-Age=0$/);
  });

  it('a live session is re-issued with the slid thirty-day expiry', async () => {
    const { app } = build();
    const response = await app.inject({
      method: 'GET',
      url: ZONES_PATH,
      headers: { cookie: COOKIE },
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers['set-cookie']).toBe(
      `${COOKIE}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=2592000`,
    );
  });
});

describe(`GET ${ZONES_PATH}`, () => {
  it('lists the account’s zones with their stored centres, snake_case', async () => {
    const { app } = build();
    const response = await app.inject({
      method: 'GET',
      url: ZONES_PATH,
      headers: { cookie: COOKIE },
    });
    expect(response.json()).toEqual({
      zones: [
        {
          id: ZONE,
          name: 'Home',
          radius_m: 10_000,
          min_score: 0.45,
          coarsened: true,
          centre: { lat: 42.69, lon: 23.32 },
          created_at: '2026-08-20T05:20:00Z',
        },
      ],
    });
  });
});

describe(`POST ${ZONES_PATH}`, () => {
  it('passes the session’s account — never one from the body — and answers 201 with the onboarding list', async () => {
    const { app, created } = build();
    const response = await app.inject({
      method: 'POST',
      url: ZONES_PATH,
      headers: { cookie: COOKIE, origin: ORIGIN },
      payload: {
        name: 'Home',
        lat: 42.6977,
        lon: 23.3219,
        radius_m: 5000,
        coarsen: true,
        min_score: 0.45,
        accountId: 'x',
      },
    });
    expect(response.statusCode).toBe(201);
    expect(created).toEqual([
      {
        accountId: ACCOUNT,
        name: 'Home',
        centre: { lat: 42.6977, lon: 23.3219 },
        radiusM: 5000,
        coarsen: true,
        minScore: 0.45,
      },
    ]);
    const body = response.json<{ zone: { centre: unknown }; onboarding: unknown }>();
    expect(body.zone.centre).toEqual({ lat: 42.69, lon: 23.32 });
    expect(body.onboarding).toEqual([{ event_id: 'evt-1', distance_km: 3.2 }]);
  });

  it('leaves optional members to the core’s defaults', async () => {
    const { app, created } = build();
    await app.inject({
      method: 'POST',
      url: ZONES_PATH,
      headers: { cookie: COOKIE, origin: ORIGIN },
      payload: { name: 'Home', lat: 42.7, lon: 23.3 },
    });
    expect(created[0]).toEqual({
      accountId: ACCOUNT,
      name: 'Home',
      centre: { lat: 42.7, lon: 23.3 },
    });
  });

  it('refuses a foreign Origin before authenticating', async () => {
    const { app, created } = build();
    const response = await app.inject({
      method: 'POST',
      url: ZONES_PATH,
      headers: { cookie: COOKIE, origin: 'https://evil.example' },
      payload: { name: 'Home', lat: 42.7, lon: 23.3 },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ code: 'origin_refused' });
    expect(created).toHaveLength(0);
  });

  it.each([
    {},
    { name: 'Home', lat: '42.7', lon: 23.3 },
    { name: 7, lat: 42.7, lon: 23.3 },
    { name: 'Home', lat: 42.7, lon: 23.3, coarsen: 'yes' },
    { name: 'Home', lat: 42.7, lon: 23.3, radius_m: '10km' },
  ])('refuses body %j with 400', async (payload) => {
    const { app, created } = build();
    const response = await app.inject({
      method: 'POST',
      url: ZONES_PATH,
      headers: { cookie: COOKIE, origin: ORIGIN },
      payload,
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: 'invalid_body' });
    expect(created).toHaveLength(0);
  });

  it.each([
    ['invalid_radius', 400, 'zone_radius_invalid'],
    ['outside_area', 400, 'zone_outside_area'],
    ['account_unavailable', 401, 'not_signed_in'],
  ] as const)(
    'maps %s to %i (%s) without a coordinate in the body or the log',
    async (refusal, status, code) => {
      const { app, problems } = build({
        create: () => Promise.reject(new ZoneRequestError(refusal)),
      });
      const response = await app.inject({
        method: 'POST',
        url: ZONES_PATH,
        headers: { cookie: COOKIE, origin: ORIGIN },
        payload: { name: 'Home', lat: 42.123456, lon: 23.654321 },
      });
      expect(response.statusCode).toBe(status);
      expect(response.json()).toMatchObject({ code });
      for (const text of [response.body, ...problems.map((p) => String(p.error))]) {
        expect(text).not.toContain('42.123456');
        expect(text).not.toContain('23.654321');
      }
    },
  );
});

describe('DELETE /api/v1/zones/:id', () => {
  it('204 for an owned zone', async () => {
    const { app, removed } = build();
    const response = await app.inject({
      method: 'DELETE',
      url: `${ZONES_PATH}/${ZONE}`,
      headers: { cookie: COOKIE, origin: ORIGIN },
    });
    expect(response.statusCode).toBe(204);
    expect(removed).toEqual([ZONE]);
  });

  it('404 for an id the account does not own, and for a malformed id without a store call', async () => {
    const { app, removed } = build();
    const other = await app.inject({
      method: 'DELETE',
      url: `${ZONES_PATH}/77777777-0000-4000-8000-0000000000bb`,
      headers: { cookie: COOKIE, origin: ORIGIN },
    });
    const malformed = await app.inject({
      method: 'DELETE',
      url: `${ZONES_PATH}/not-a-uuid`,
      headers: { cookie: COOKIE, origin: ORIGIN },
    });
    expect([other.statusCode, malformed.statusCode]).toEqual([404, 404]);
    expect([other.json(), malformed.json()]).toMatchObject([
      { code: 'zone_not_found' },
      { code: 'zone_not_found' },
    ]);
    expect(removed).toEqual(['77777777-0000-4000-8000-0000000000bb']);
  });

  it('needs the Origin check too', async () => {
    const { app } = build();
    const response = await app.inject({
      method: 'DELETE',
      url: `${ZONES_PATH}/${ZONE}`,
      headers: { cookie: COOKIE },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ code: 'origin_refused' });
  });
});
