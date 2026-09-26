import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import type { FetchLike } from '../adapters/alerts/channels/provider-http.js';
import { ACCOUNT_EXPORT_PATH } from '../adapters/http/account-export-route.js';
import { ACCOUNT_PATH } from '../adapters/http/account-route.js';
import { AUTH_LINK_PATH, AUTH_LOGOUT_PATH, type SignInFlows } from '../adapters/http/auth-route.js';
import {
  CHANNEL_EMAIL_CONFIRM_PATH,
  CHANNEL_EMAIL_PATH,
  CHANNEL_TELEGRAM_LINK_PATH,
  CHANNEL_TELEGRAM_WEBHOOK_PATH,
  type ChannelOptInFlows,
} from '../adapters/http/channel-opt-in-route.js';
import { SESSION_COOKIE_NAME } from '../adapters/http/session-cookie.js';
import { ZONES_PATH } from '../adapters/http/zones-route.js';
import { signInLinkUrl } from '../adapters/mail/ses-auth-mailer.js';
import type { AuthenticatedSession } from '../core/auth/sign-in.js';
import type { AuthMailer } from '../core/ports/auth-stores.js';
import type { ZoneCentreCipher } from '../core/ports/zone-centre-cipher.js';
import {
  ACCOUNT_EXPORT_RATE_LIMIT,
  unarmedChannelFlows,
  wireAuthRoutes,
  type AccountSurface,
  type ZoneSurface,
} from './auth-wiring.js';
import { loadConfig, type AuthConfig, type Environment } from './config.js';
import { problemLogRecord } from './health-wiring.js';
import { createProcessLog } from './logging.js';

const TOKEN = 'Zq9_Zq9-Zq9_Zq9-Zq9_Zq9-Zq9_Zq9-Zq9_Zq9-Zq9';
const ADDRESS = 'reader@example.invalid';
const ORIGIN = 'https://app.example.invalid';
const LANDING = `${ORIGIN}/sign-in`;
const LINK = signInLinkUrl(LANDING, TOKEN);

const ENABLED_ENV: Environment = {
  DATABASE_URL: 'postgres://fire:watch@localhost:5432/fire_watch',
  FIRMS_MAP_KEY: '0123456789abcdef0123456789abcdef',
  FIRE_WATCH_AUTH_ENABLED: 'true',
  FIRE_WATCH_AUTH_MAIL_FROM: 'sign-in@auth.example.invalid',
  FIRE_WATCH_AUTH_MAIL_DOMAIN: 'auth.example.invalid',
  FIRE_WATCH_AUTH_LANDING_URL: LANDING,
  FIRE_WATCH_AUTH_ALLOWED_ORIGINS: ORIGIN,
  FIRE_WATCH_SES_REGION: 'eu-central-1',
  FIRE_WATCH_SES_ACCESS_KEY_ID: 'AKIAIOSFODNN7EXAMPLE',
  FIRE_WATCH_SES_SECRET_ACCESS_KEY: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
  FIRE_WATCH_SES_FROM_ADDRESS: 'alerts@alerts.example.invalid',
};

/** Flows that do what `requestSignInLink` does with the mailer: send, and let it throw. */
function mailingFlows(mailer: AuthMailer): SignInFlows {
  return {
    requestLink: async (request) => {
      await mailer.sendSignInLink({
        to: request.email,
        token: TOKEN,
        expiresAtIso: '2026-09-25T12:15:00.000Z',
      });
    },
    continueLink: () => Promise.reject(new Error('not under test')),
    signOut: () => Promise.resolve(),
  };
}

const SESSION_TOKEN = 'Se5_Se5-Se5_Se5-Se5_Se5-Se5_Se5-Se5_Se5-Se5';
const SESSION_COOKIE = `${SESSION_COOKIE_NAME}=${SESSION_TOKEN}`;
const ACCOUNT_ID = '00000000-0000-4000-8000-000000000001';
const ZONE_NAME = 'Grandmother house by the river';
const ZONE_LAT = 42.123456;
const ZONE_LON = 23.654321;

function notUnderTest(): Promise<never> {
  return Promise.reject(new Error('not under test'));
}

/** Every call a route makes into the surface, by name. */
type Calls = string[];

/** Resolves only {@link SESSION_TOKEN}, like the session table would. */
function authenticateFor(calls: Calls) {
  return (token: string | undefined): Promise<AuthenticatedSession | null> => {
    calls.push('authenticate');
    return Promise.resolve(
      token === SESSION_TOKEN
        ? { sessionId: 's', accountId: ACCOUNT_ID, expiresAt: Date.parse('2026-10-25T00:00:00Z') }
        : null,
    );
  };
}

function channelsFor(calls: Calls): ChannelOptInFlows {
  return {
    requestEmail: () => (calls.push('channels.requestEmail'), notUnderTest()),
    confirmEmail: () => (calls.push('channels.confirmEmail'), notUnderTest()),
    requestTelegramLink: () => (calls.push('channels.requestTelegramLink'), notUnderTest()),
    handleTelegramStart: () => (calls.push('channels.handleTelegramStart'), notUnderTest()),
    unlink: () => (calls.push('channels.unlink'), notUnderTest()),
  };
}

function zonesFor(calls: Calls, overrides: Partial<ZoneSurface> = {}): ZoneSurface {
  return {
    create: () => (calls.push('zones.create'), notUnderTest()),
    list: () => (calls.push('zones.list'), Promise.resolve([])),
    remove: () => (calls.push('zones.remove'), Promise.resolve(true)),
    exportAccount: () => (
      calls.push('exportAccount'),
      Promise.resolve({ status: 'erased' as const })
    ),
    ...overrides,
  };
}

/** A surface recording every call; the sign-in half mails through the real SES mailer. */
function recordingSurface(
  calls: Calls,
  overrides: Partial<AccountSurface> = {},
): (mailer: AuthMailer, cipher: ZoneCentreCipher | null) => AccountSurface {
  return (mailer) => ({
    signIn: mailingFlows(mailer),
    authenticate: authenticateFor(calls),
    erase: () => (calls.push('erase'), notUnderTest()),
    channels: channelsFor(calls),
    zones: zonesFor(calls),
    ...overrides,
  });
}

function surfaceOf(mailer: AuthMailer, cipher: ZoneCentreCipher | null): AccountSurface {
  return recordingSurface([])(mailer, cipher);
}

/** A test keyring: 32 zero bytes. The routes never see it; only whether it exists. */
const KEYRING = { active: { id: 'test-1', key: new Uint8Array(32) }, retired: [] };

function capturingLog(env: Environment) {
  const lines: string[] = [];
  const log = createProcessLog({
    env,
    writeOut: (text) => lines.push(text),
    writeErr: (text) => lines.push(text),
  });
  return { lines, log };
}

const apps: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

function app(): FastifyInstance {
  const instance = Fastify({ logger: false });
  apps.push(instance);
  return instance;
}

function wiringConfig(auth: AuthConfig) {
  return { auth, databaseUrl: 'postgres://x', databaseRole: 'r', applicationName: 'test' };
}

describe('wireAuthRoutes (I1)', () => {
  it('registers nothing by default: the link route is a 404', async () => {
    const config = loadConfig({
      DATABASE_URL: ENABLED_ENV['DATABASE_URL'],
      FIRMS_MAP_KEY: ENABLED_ENV['FIRMS_MAP_KEY'],
    });
    expect(config.auth).toEqual({ enabled: false });

    const server = app();
    const wiring = wireAuthRoutes(server, config, {
      onProblem: () => undefined,
      createSurface: surfaceOf,
    });
    expect(wiring.enabled).toBe(false);
    const response = await server.inject({
      method: 'POST',
      url: AUTH_LINK_PATH,
      headers: { origin: ORIGIN },
      payload: { email: ADDRESS },
    });
    expect(response.statusCode).toBe(404);
  });

  it('sends the link when enabled and configured', async () => {
    const config = loadConfig(ENABLED_ENV);
    const sent: string[] = [];
    const fetch: FetchLike = (_input, init) => {
      sent.push(init?.body as string);
      return Promise.resolve(new Response('{"MessageId":"m"}', { status: 200 }));
    };
    const { lines, log } = capturingLog(ENABLED_ENV);
    const server = app();
    const wiring = wireAuthRoutes(server, config, {
      onProblem: (entry) => log.note(problemLogRecord(entry, log)),
      fetch,
      createSurface: surfaceOf,
    });
    expect(wiring.enabled).toBe(true);

    const response = await server.inject({
      method: 'POST',
      url: AUTH_LINK_PATH,
      headers: { origin: ORIGIN },
      payload: { email: ADDRESS },
    });
    expect(response.statusCode).toBe(202);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain(LINK);
    expect(lines).toEqual([]);
  });

  it('never writes the token, the link or the address to a log line when SES fails', async () => {
    const config = loadConfig(ENABLED_ENV);
    // A provider that echoes the whole request back, header and body, as some do.
    const fetch: FetchLike = (_input, init) =>
      Promise.resolve(
        new Response(
          JSON.stringify({ __type: 'MessageRejected', message: `bad: ${init?.body as string}` }),
          { status: 400, headers: { 'x-amzn-errortype': 'MessageRejected' } },
        ),
      );
    const { lines, log } = capturingLog(ENABLED_ENV);
    const server = app();
    wireAuthRoutes(server, config, {
      onProblem: (entry) => log.note(problemLogRecord(entry, log)),
      fetch,
      createSurface: surfaceOf,
    });

    const response = await server.inject({
      method: 'POST',
      url: AUTH_LINK_PATH,
      headers: { origin: ORIGIN },
      payload: { email: ADDRESS },
    });
    expect(response.statusCode).toBe(500);
    expect(lines.length).toBeGreaterThan(0);
    const logged = lines.join('');
    expect(logged).toContain('sign-in mail not sent: ses returned 400 MessageRejected');
    for (const secret of [TOKEN, LINK, ADDRESS, 'reader%40example.invalid']) {
      expect(logged).not.toContain(secret);
    }
    expect(response.body).not.toContain(TOKEN);
    expect(response.body).not.toContain(ADDRESS);
  });

  it('refuses a foreign origin before the mailer is reached', async () => {
    const config = loadConfig(ENABLED_ENV);
    let calls = 0;
    const fetch: FetchLike = () => {
      calls += 1;
      return Promise.resolve(new Response('{}', { status: 200 }));
    };
    const server = app();
    wireAuthRoutes(server, config, {
      onProblem: () => undefined,
      fetch,
      createSurface: surfaceOf,
    });
    const response = await server.inject({
      method: 'POST',
      url: AUTH_LINK_PATH,
      headers: { origin: 'https://elsewhere.example.invalid' },
      payload: { email: ADDRESS },
    });
    expect(response.statusCode).toBe(403);
    expect(calls).toBe(0);
  });

  it('wires nothing for a disabled config even when handed flows', () => {
    const wiring = wireAuthRoutes(app(), wiringConfig({ enabled: false }), {
      onProblem: () => undefined,
      createSurface: surfaceOf,
    });
    expect(wiring.enabled).toBe(false);
  });
});

const ZONE_ID = '00000000-0000-4000-8000-0000000000aa';
const CHANNEL_ID = '00000000-0000-4000-8000-0000000000bb';
const CONFIRM_TOKEN = 'Cf7_Cf7-Cf7_Cf7-Cf7_Cf7-Cf7_Cf7-Cf7_Cf7-Cf7';
const ZONE_BODY = { name: ZONE_NAME, lat: ZONE_LAT, lon: ZONE_LON };

/** Every account route this wiring owns, as the browser would call it. */
const ACCOUNT_ROUTES = [
  { method: 'GET', url: ACCOUNT_PATH },
  { method: 'DELETE', url: ACCOUNT_PATH },
  { method: 'POST', url: AUTH_LOGOUT_PATH },
  { method: 'GET', url: ZONES_PATH },
  { method: 'POST', url: ZONES_PATH, payload: ZONE_BODY },
  { method: 'DELETE', url: `${ZONES_PATH}/${ZONE_ID}` },
  { method: 'GET', url: ACCOUNT_EXPORT_PATH },
  { method: 'POST', url: CHANNEL_EMAIL_PATH, payload: { email: ADDRESS } },
  { method: 'POST', url: CHANNEL_EMAIL_CONFIRM_PATH, payload: { token: CONFIRM_TOKEN } },
  { method: 'POST', url: CHANNEL_TELEGRAM_LINK_PATH },
  { method: 'POST', url: CHANNEL_TELEGRAM_WEBHOOK_PATH, payload: {} },
  { method: 'DELETE', url: `/api/v1/channels/${CHANNEL_ID}` },
] as const;

type Route = (typeof ACCOUNT_ROUTES)[number];

function call(server: FastifyInstance, route: Route, headers: Record<string, string>) {
  return server.inject({
    method: route.method,
    url: route.url,
    headers,
    ...('payload' in route ? { payload: route.payload } : {}),
  });
}

describe('wireAuthRoutes — the account routes (I2, I3, I4, I6)', () => {
  it.each(ACCOUNT_ROUTES)('flag off: $method $url is a 404', async (route) => {
    const config = loadConfig({
      DATABASE_URL: ENABLED_ENV['DATABASE_URL'],
      FIRMS_MAP_KEY: ENABLED_ENV['FIRMS_MAP_KEY'],
    });
    const calls: Calls = [];
    const server = app();
    const wiring = wireAuthRoutes(server, config, {
      onProblem: () => undefined,
      zoneKeyring: KEYRING,
      createSurface: recordingSurface(calls),
    });
    expect(wiring).toMatchObject({ enabled: false, zonesEnabled: false });
    const response = await call(server, route, { origin: ORIGIN, cookie: SESSION_COOKIE });
    expect(response.statusCode).toBe(404);
    expect(calls).toEqual([]);
  });

  it('production path without a keyring: zones and export are 404, the rest is guarded', async () => {
    // No `createSurface`: the real Postgres surface, over lazy pools that never connect —
    // a request without a cookie is refused before any query.
    const config = loadConfig(ENABLED_ENV);
    const server = app();
    const wiring = wireAuthRoutes(server, config, { onProblem: () => undefined });
    try {
      expect(wiring).toMatchObject({ enabled: true, zonesEnabled: false });
      const status = async (method: 'GET' | 'POST' | 'DELETE', url: string) =>
        (await server.inject({ method, url, headers: { origin: ORIGIN } })).statusCode;
      expect(await status('GET', ZONES_PATH)).toBe(404);
      expect(await status('POST', ZONES_PATH)).toBe(404);
      expect(await status('GET', ACCOUNT_EXPORT_PATH)).toBe(404);
      expect(await status('GET', ACCOUNT_PATH)).toBe(401);
      expect(await status('DELETE', ACCOUNT_PATH)).toBe(401);
      expect(await status('POST', CHANNEL_EMAIL_PATH)).toBe(401);
      expect(await status('POST', CHANNEL_TELEGRAM_LINK_PATH)).toBe(401);
      expect(await status('POST', CHANNEL_TELEGRAM_WEBHOOK_PATH)).toBe(404);
    } finally {
      await wiring.close();
    }
  });

  it('production path with a keyring registers the zone and export routes behind the session', async () => {
    const config = loadConfig(ENABLED_ENV);
    const server = app();
    const wiring = wireAuthRoutes(server, config, {
      onProblem: () => undefined,
      zoneKeyring: KEYRING,
    });
    try {
      expect(wiring.zonesEnabled).toBe(true);
      for (const url of [ZONES_PATH, ACCOUNT_EXPORT_PATH]) {
        const response = await server.inject({ method: 'GET', url });
        expect(response.statusCode).toBe(401);
      }
    } finally {
      await wiring.close();
    }
  });

  it('never registers zone routes without a keyring, whatever the surface offers', async () => {
    const calls: Calls = [];
    const server = app();
    const wiring = wireAuthRoutes(server, loadConfig(ENABLED_ENV), {
      onProblem: () => undefined,
      createSurface: recordingSurface(calls),
    });
    expect(wiring.zonesEnabled).toBe(false);
    const response = await server.inject({
      method: 'GET',
      url: ZONES_PATH,
      headers: { cookie: SESSION_COOKIE },
    });
    expect(response.statusCode).toBe(404);
    expect(calls).toEqual([]);
  });

  it.each(ACCOUNT_ROUTES.filter((route) => route.method !== 'GET'))(
    'refuses a foreign origin on $method $url before any work',
    async (route) => {
      const calls: Calls = [];
      const server = app();
      wireAuthRoutes(server, loadConfig(ENABLED_ENV), {
        onProblem: () => undefined,
        zoneKeyring: KEYRING,
        createSurface: recordingSurface(calls),
      });
      const response = await call(server, route, {
        origin: 'https://elsewhere.example.invalid',
        cookie: SESSION_COOKIE,
      });
      // The Telegram webhook is the one state change a browser never makes: it is
      // authenticated by its secret header, and with no secret it does not exist.
      expect(response.statusCode).toBe(route.url === CHANNEL_TELEGRAM_WEBHOOK_PATH ? 404 : 403);
      expect(calls).toEqual([]);
    },
  );

  it.each(ACCOUNT_ROUTES.filter((route) => route.url !== CHANNEL_EMAIL_CONFIRM_PATH))(
    'answers $method $url without a session with a 401 and no work (or the logout/webhook contract)',
    async (route) => {
      const calls: Calls = [];
      const server = app();
      wireAuthRoutes(server, loadConfig(ENABLED_ENV), {
        onProblem: () => undefined,
        zoneKeyring: KEYRING,
        createSurface: recordingSurface(calls),
      });
      const response = await call(server, route, {
        origin: ORIGIN,
        cookie: `${SESSION_COOKIE_NAME}=dead`,
      });
      if (route.url === AUTH_LOGOUT_PATH) {
        // Sign-out is idempotent: a dead cookie is cleared, never a 401.
        expect(response.statusCode).toBe(204);
      } else if (route.url === CHANNEL_TELEGRAM_WEBHOOK_PATH) {
        expect(response.statusCode).toBe(404);
      } else {
        expect(response.statusCode).toBe(401);
        expect(calls).toEqual(['authenticate']);
      }
    },
  );

  it('erases through the surface eraser, for the session account only, and clears the cookie', async () => {
    const calls: Calls = [];
    const erased: string[] = [];
    const server = app();
    wireAuthRoutes(server, loadConfig(ENABLED_ENV), {
      onProblem: () => undefined,
      createSurface: recordingSurface(calls, {
        erase: (accountId) => {
          erased.push(accountId);
          return Promise.resolve({ status: 'already_erased' });
        },
      }),
    });
    const response = await server.inject({
      method: 'DELETE',
      url: ACCOUNT_PATH,
      headers: { origin: ORIGIN, cookie: SESSION_COOKIE },
    });
    expect(response.statusCode).toBe(204);
    expect(erased).toEqual([ACCOUNT_ID]);
    expect(response.headers['set-cookie']).toMatch(new RegExp(`^${SESSION_COOKIE_NAME}=;`));
  });

  it('limits exports per account', async () => {
    const calls: Calls = [];
    const server = app();
    wireAuthRoutes(server, loadConfig(ENABLED_ENV), {
      onProblem: () => undefined,
      zoneKeyring: KEYRING,
      createSurface: recordingSurface(calls),
    });
    const statuses: number[] = [];
    let last;
    for (let index = 0; index <= ACCOUNT_EXPORT_RATE_LIMIT.limit; index += 1) {
      last = await server.inject({
        method: 'GET',
        url: ACCOUNT_EXPORT_PATH,
        headers: { cookie: SESSION_COOKIE },
      });
      statuses.push(last.statusCode);
    }
    expect(statuses.at(-1)).toBe(429);
    expect(Number(last?.headers['retry-after'])).toBeGreaterThan(0);
    expect(calls.filter((name) => name === 'exportAccount')).toHaveLength(
      ACCOUNT_EXPORT_RATE_LIMIT.limit,
    );
  });

  it('lists the session account zones', async () => {
    const listed: string[] = [];
    const server = app();
    wireAuthRoutes(server, loadConfig(ENABLED_ENV), {
      onProblem: () => undefined,
      zoneKeyring: KEYRING,
      createSurface: recordingSurface([], {
        zones: zonesFor([], {
          list: (accountId) => (listed.push(accountId), Promise.resolve([])),
        }),
      }),
    });
    const response = await server.inject({
      method: 'GET',
      url: ZONES_PATH,
      headers: { cookie: SESSION_COOKIE },
    });
    expect(response.statusCode).toBe(200);
    expect(listed).toEqual([ACCOUNT_ID]);
  });

  it('asking for a channel is a 503 before the flows are reached: delivery is unwired', async () => {
    const calls: Calls = [];
    const server = app();
    wireAuthRoutes(server, loadConfig(ENABLED_ENV), {
      onProblem: () => undefined,
      createSurface: recordingSurface(calls),
    });
    for (const route of [
      { url: CHANNEL_EMAIL_PATH, payload: { email: ADDRESS } },
      { url: CHANNEL_TELEGRAM_LINK_PATH, payload: {} },
    ]) {
      const response = await server.inject({
        method: 'POST',
        url: route.url,
        headers: { origin: ORIGIN, cookie: SESSION_COOKIE },
        payload: route.payload,
      });
      expect(response.statusCode).toBe(503);
    }
    expect(calls).toEqual(['authenticate', 'authenticate']);
  });

  it('keeps confirm and unlink, which need no provider', async () => {
    const calls: Calls = [];
    const flows = unarmedChannelFlows(channelsFor(calls));
    await expect(flows.confirmEmail({ token: CONFIRM_TOKEN }, 0)).rejects.toThrow();
    await expect(
      flows.unlink({ accountId: ACCOUNT_ID, subscriptionId: CHANNEL_ID }, 0),
    ).rejects.toThrow();
    await expect(flows.requestEmail({ accountId: ACCOUNT_ID, email: ADDRESS }, 0)).rejects.toThrow(
      'unarmed',
    );
    expect(calls).toEqual(['channels.confirmEmail', 'channels.unlink']);
  });

  it('never writes the address, the zone, the tokens or the account id to a log line', async () => {
    const { lines, log } = capturingLog(ENABLED_ENV);
    const server = app();
    const failing = () => Promise.reject(new Error('store unavailable'));
    wireAuthRoutes(server, loadConfig(ENABLED_ENV), {
      onProblem: (entry) => log.note(problemLogRecord(entry, log)),
      zoneKeyring: KEYRING,
      createSurface: recordingSurface([], {
        erase: failing,
        channels: { ...channelsFor([]), confirmEmail: failing, unlink: failing },
        zones: zonesFor([], {
          create: failing,
          list: failing,
          remove: failing,
          exportAccount: failing,
        }),
      }),
    });
    const statuses: number[] = [];
    for (const route of ACCOUNT_ROUTES) {
      for (const cookie of [SESSION_COOKIE, `${SESSION_COOKIE_NAME}=dead`]) {
        statuses.push((await call(server, route, { origin: ORIGIN, cookie })).statusCode);
      }
    }
    // The failures did reach the log — this is not a test of an empty sink.
    expect(statuses.filter((status) => status === 500).length).toBeGreaterThan(0);
    expect(lines.length).toBeGreaterThan(0);
    const logged = lines.join('');
    for (const secret of [
      ADDRESS,
      'reader%40example.invalid',
      ZONE_NAME,
      String(ZONE_LAT),
      String(ZONE_LON),
      SESSION_TOKEN,
      CONFIRM_TOKEN,
      ACCOUNT_ID,
    ]) {
      expect(logged).not.toContain(secret);
    }
  });
});
