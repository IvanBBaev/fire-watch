import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { AuthRefusal, type StartedSession } from '../../core/auth/sign-in.js';
import { VirtualClock } from '../../core/ports/clock.js';
import {
  AUTH_CONTINUE_PATH,
  AUTH_LINK_PATH,
  AUTH_LOGOUT_PATH,
  registerAuthRoutes,
  type SignInFlows,
} from './auth-route.js';
import type { ProblemLogEntry } from './problem.js';
import { SESSION_COOKIE_NAME } from './session-cookie.js';

const ORIGIN = 'https://fire-watch.example';
const CLOCK = new VirtualClock('2026-08-20T05:20:00Z');
const SESSION_TOKEN = 'S'.repeat(43);

interface Calls {
  link: { email: string; userAgent: string | undefined }[];
  cont: { token: string }[];
  signOut: (string | undefined)[];
}

function build(overrides: Partial<SignInFlows> = {}) {
  const calls: Calls = { link: [], cont: [], signOut: [] };
  const problems: ProblemLogEntry[] = [];
  const flows: SignInFlows = {
    requestLink: (request) => {
      calls.link.push(request);
      return Promise.resolve();
    },
    continueLink: (request, at) => {
      calls.cont.push({ token: request.token });
      const started: StartedSession = {
        sessionToken: SESSION_TOKEN,
        sessionId: 'sid',
        accountId: 'aid',
        accountCreated: true,
        expiresAt: at + 30 * 86_400_000,
      };
      return Promise.resolve(started);
    },
    signOut: (token) => {
      calls.signOut.push(token);
      return Promise.resolve();
    },
    ...overrides,
  };
  const app = Fastify({ logger: false });
  registerAuthRoutes(app, {
    flows,
    allowedOrigins: [ORIGIN],
    clock: CLOCK,
    onProblem: (entry) => problems.push(entry),
  });
  apps.push(app);
  return { app, calls, problems };
}

const apps: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe('Origin validation (C1)', () => {
  it.each([undefined, 'null', 'https://evil.example'])(
    'refuses Origin %j with 403 before any flow runs',
    async (origin) => {
      const { app, calls } = build();
      const response = await app.inject({
        method: 'POST',
        url: AUTH_LINK_PATH,
        headers: origin === undefined ? {} : { origin },
        payload: { email: 'a@example.bg' },
      });
      expect(response.statusCode).toBe(403);
      expect(response.json()).toMatchObject({ code: 'origin_refused' });
      expect(response.headers['content-type']).toMatch(/^application\/problem\+json/);
      expect(calls.link).toHaveLength(0);
    },
  );
});

describe(`POST ${AUTH_LINK_PATH}`, () => {
  it('answers 202 and passes the address and UA through', async () => {
    const { app, calls } = build();
    const response = await app.inject({
      method: 'POST',
      url: AUTH_LINK_PATH,
      headers: { origin: ORIGIN, 'user-agent': 'UA' },
      payload: { email: 'a@example.bg' },
    });
    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual({ status: 'sent' });
    expect(calls.link).toEqual([{ email: 'a@example.bg', userAgent: 'UA' }]);
  });

  it('maps the rate limit to 429 with Retry-After, and never echoes the address', async () => {
    const { app, problems } = build({
      requestLink: () => Promise.reject(new AuthRefusal('rate_limited', 600)),
    });
    const response = await app.inject({
      method: 'POST',
      url: AUTH_LINK_PATH,
      headers: { origin: ORIGIN },
      payload: { email: 'secret-person@example.bg' },
    });
    expect(response.statusCode).toBe(429);
    expect(response.json()).toMatchObject({ code: 'rate_limited' });
    expect(response.headers['retry-after']).toBe('600');
    expect(response.body).not.toContain('secret-person');
    expect(JSON.stringify(problems.map((p) => String(p.error)))).not.toContain('secret-person');
  });

  it('maps an invalid address to 400', async () => {
    const { app } = build({ requestLink: () => Promise.reject(new AuthRefusal('invalid_email')) });
    const response = await app.inject({
      method: 'POST',
      url: AUTH_LINK_PATH,
      headers: { origin: ORIGIN },
      payload: { email: 'nope' },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ title: 'Invalid address', code: 'invalid_email' });
  });

  it.each([{}, { email: 42 }, { email: 'a'.repeat(321) }])(
    'refuses body %j with 400',
    async (payload) => {
      const { app, calls } = build();
      const response = await app.inject({
        method: 'POST',
        url: AUTH_LINK_PATH,
        headers: { origin: ORIGIN },
        payload,
      });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ code: 'invalid_body' });
      expect(calls.link).toHaveLength(0);
    },
  );

  it('a flow failure that is not a refusal is a 500 with no detail from it', async () => {
    const { app } = build({
      requestLink: () => Promise.reject(new Error('smtp://user:pw@host down')),
    });
    const response = await app.inject({
      method: 'POST',
      url: AUTH_LINK_PATH,
      headers: { origin: ORIGIN },
      payload: { email: 'a@example.bg' },
    });
    expect(response.statusCode).toBe(500);
    expect(response.json()).toMatchObject({ code: 'internal_error' });
    expect(response.body).not.toContain('pw@host');
  });
});

describe(`POST ${AUTH_CONTINUE_PATH}`, () => {
  it('sets the session cookie with every C1 attribute and says whether the account is new', async () => {
    const { app, calls } = build();
    const response = await app.inject({
      method: 'POST',
      url: AUTH_CONTINUE_PATH,
      headers: { origin: ORIGIN },
      payload: { token: 'T'.repeat(43) },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ account_created: true });
    expect(response.headers['set-cookie']).toBe(
      `${SESSION_COOKIE_NAME}=${SESSION_TOKEN}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=2592000`,
    );
    expect(response.body).not.toContain(SESSION_TOKEN);
    expect(calls.cont).toEqual([{ token: 'T'.repeat(43) }]);
  });

  it.each([
    ['unknown', 'Link not valid', 'link_invalid'],
    ['expired', 'Link expired', 'link_expired'],
    ['used', 'Link already used', 'link_used'],
    ['superseded', 'Link replaced', 'link_superseded'],
    ['other_browser', 'Different browser', 'link_other_browser'],
  ] as const)(
    'maps %s to a 400 titled %j with code %j and sets no cookie',
    async (refusal, title, code) => {
      const { app } = build({ continueLink: () => Promise.reject(new AuthRefusal(refusal)) });
      const response = await app.inject({
        method: 'POST',
        url: AUTH_CONTINUE_PATH,
        headers: { origin: ORIGIN },
        payload: { token: 'T'.repeat(43) },
      });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ title, code });
      expect(response.headers['set-cookie']).toBeUndefined();
    },
  );

  it('is not reachable by GET — a mail scanner prefetch consumes nothing', async () => {
    const { app, calls } = build();
    const response = await app.inject({
      method: 'GET',
      url: `${AUTH_CONTINUE_PATH}?token=${'T'.repeat(43)}`,
    });
    expect(response.statusCode).toBe(404);
    expect(calls.cont).toHaveLength(0);
  });
});

describe(`POST ${AUTH_LOGOUT_PATH}`, () => {
  it('revokes the cookie’s session and clears the cookie', async () => {
    const { app, calls } = build();
    const response = await app.inject({
      method: 'POST',
      url: AUTH_LOGOUT_PATH,
      headers: { origin: ORIGIN, cookie: `${SESSION_COOKIE_NAME}=${SESSION_TOKEN}` },
    });
    expect(response.statusCode).toBe(204);
    expect(calls.signOut).toEqual([SESSION_TOKEN]);
    expect(response.headers['set-cookie']).toMatch(
      new RegExp(`^${SESSION_COOKIE_NAME}=; .*Max-Age=0$`),
    );
  });

  it('is idempotent without a cookie', async () => {
    const { app, calls } = build();
    const response = await app.inject({
      method: 'POST',
      url: AUTH_LOGOUT_PATH,
      headers: { origin: ORIGIN },
    });
    expect(response.statusCode).toBe(204);
    expect(calls.signOut).toEqual([undefined]);
  });
});
