import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { ChannelOptInRefusal } from '../../core/channels/channel-opt-in.js';
import type { TelegramStart } from '../../core/channels/telegram-start.js';
import { VirtualClock } from '../../core/ports/clock.js';
import {
  CHANNEL_EMAIL_CONFIRM_PATH,
  CHANNEL_EMAIL_PATH,
  CHANNEL_TELEGRAM_LINK_PATH,
  CHANNEL_TELEGRAM_WEBHOOK_PATH,
  registerChannelOptInRoutes,
  TELEGRAM_SECRET_HEADER,
  type ChannelOptInFlows,
  type ChannelOptInRouteDeps,
} from './channel-opt-in-route.js';
import type { ProblemLogEntry } from './problem.js';
import { SESSION_COOKIE_NAME } from './session-cookie.js';

const ORIGIN = 'https://fire-watch.example';
const CLOCK = new VirtualClock('2026-09-23T08:00:00Z');
const SESSION = 'S'.repeat(43);
const COOKIE = `${SESSION_COOKIE_NAME}=${SESSION}`;
const ACCOUNT = '13131313-0000-4000-8000-000000000001';
const CHANNEL = '13131313-0000-4000-8000-0000000000a1';
const HOUR = 3_600_000;
const SECRET = 'webhook-secret-for-tests';

const apps: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

function build(
  flowOverrides: Partial<ChannelOptInFlows> = {},
  depOverrides: Partial<ChannelOptInRouteDeps> = {},
) {
  const starts: TelegramStart[] = [];
  const problems: ProblemLogEntry[] = [];
  const flows: ChannelOptInFlows = {
    requestEmail: (_request, at) =>
      Promise.resolve({ status: 'pending', subscriptionId: CHANNEL, expiresAt: at + 48 * HOUR }),
    confirmEmail: () => Promise.resolve({ subscriptionId: CHANNEL }),
    requestTelegramLink: (_request, at) =>
      Promise.resolve({ token: 'T'.repeat(43), expiresAt: at + HOUR }),
    handleTelegramStart: (start) => {
      starts.push(start);
      return Promise.resolve(undefined);
    },
    unlink: (request) => Promise.resolve(request.subscriptionId === CHANNEL),
    ...flowOverrides,
  };
  const deps: ChannelOptInRouteDeps = {
    flows,
    authenticate: (token, at) =>
      Promise.resolve(
        token === SESSION ? { sessionId: 'sid', accountId: ACCOUNT, expiresAt: at + HOUR } : null,
      ),
    telegramBotUsername: 'FireWatchTestBot',
    telegramWebhookSecret: SECRET,
    allowedOrigins: [ORIGIN],
    clock: CLOCK,
    onProblem: (entry) => problems.push(entry),
    ...depOverrides,
  };
  const app = Fastify({ logger: false });
  registerChannelOptInRoutes(app, deps);
  apps.push(app);
  return { app, starts, problems };
}

const browser = { origin: ORIGIN, cookie: COOKIE };

describe(`POST ${CHANNEL_EMAIL_PATH}`, () => {
  it('202 with the pending channel and its expiry', async () => {
    const { app } = build();
    const response = await app.inject({
      method: 'POST',
      url: CHANNEL_EMAIL_PATH,
      headers: browser,
      payload: { email: 'person@example.org' },
    });
    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual({
      status: 'pending',
      channel_id: CHANNEL,
      expires_at: '2026-09-25T08:00:00Z',
    });
  });

  it('200 when the address is already confirmed', async () => {
    const { app } = build({
      requestEmail: () => Promise.resolve({ status: 'already_confirmed', subscriptionId: CHANNEL }),
    });
    const response = await app.inject({
      method: 'POST',
      url: CHANNEL_EMAIL_PATH,
      headers: browser,
      payload: { email: 'person@example.org' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'confirmed', channel_id: CHANNEL });
  });

  it('401 without a session, 403 from a foreign origin', async () => {
    const { app } = build();
    const noSession = await app.inject({
      method: 'POST',
      url: CHANNEL_EMAIL_PATH,
      headers: { origin: ORIGIN },
      payload: { email: 'person@example.org' },
    });
    expect(noSession.statusCode).toBe(401);
    expect(noSession.json()).toMatchObject({ code: 'not_signed_in' });
    const foreign = await app.inject({
      method: 'POST',
      url: CHANNEL_EMAIL_PATH,
      headers: { origin: 'https://evil.example', cookie: COOKIE },
      payload: { email: 'person@example.org' },
    });
    expect(foreign.statusCode).toBe(403);
    expect(foreign.json()).toMatchObject({ code: 'origin_refused' });
  });

  it('429 with Retry-After when the address is rate limited', async () => {
    const { app } = build({
      requestEmail: () => Promise.reject(new ChannelOptInRefusal('rate_limited', 3600)),
    });
    const response = await app.inject({
      method: 'POST',
      url: CHANNEL_EMAIL_PATH,
      headers: browser,
      payload: { email: 'person@example.org' },
    });
    expect(response.statusCode).toBe(429);
    expect(response.json()).toMatchObject({ code: 'rate_limited' });
    expect(response.headers['retry-after']).toBe('3600');
  });
});

describe(`POST ${CHANNEL_EMAIL_CONFIRM_PATH}`, () => {
  it('confirms with the token alone', async () => {
    const { app } = build();
    const response = await app.inject({
      method: 'POST',
      url: CHANNEL_EMAIL_CONFIRM_PATH,
      headers: { origin: ORIGIN },
      payload: { token: 'T'.repeat(43) },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'confirmed', channel_id: CHANNEL });
  });

  it('is never a GET, so a mail scanner’s prefetch confirms nothing', async () => {
    const { app } = build();
    const response = await app.inject({
      method: 'GET',
      url: `${CHANNEL_EMAIL_CONFIRM_PATH}?token=${'T'.repeat(43)}`,
    });
    expect(response.statusCode).toBe(404);
  });

  it.each([
    ['used', 'Link already used', 'link_used'],
    ['expired', 'Link expired', 'link_expired'],
    ['revoked', 'Channel removed', 'channel_removed'],
    ['account_deleted', 'Link not valid', 'link_invalid'],
    ['wrong_channel', 'Link not valid', 'link_invalid'],
  ] as const)('maps `%s` to a 400 titled %s with code %s', async (refusal, title, code) => {
    const { app } = build({ confirmEmail: () => Promise.reject(new ChannelOptInRefusal(refusal)) });
    const response = await app.inject({
      method: 'POST',
      url: CHANNEL_EMAIL_CONFIRM_PATH,
      headers: { origin: ORIGIN },
      payload: { token: 'T'.repeat(43) },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ title, code });
  });
});

describe(`POST ${CHANNEL_TELEGRAM_LINK_PATH}`, () => {
  it('201 with the t.me deep link', async () => {
    const { app } = build();
    const response = await app.inject({
      method: 'POST',
      url: CHANNEL_TELEGRAM_LINK_PATH,
      headers: browser,
    });
    expect(response.statusCode).toBe(201);
    expect(response.json()).toEqual({
      link: `https://t.me/FireWatchTestBot?start=${'T'.repeat(43)}`,
      expires_at: '2026-09-23T09:00:00Z',
    });
  });

  it('503 without calling the flow while no bot identity is set', async () => {
    let called = false;
    const { app } = build(
      {
        requestTelegramLink: () => {
          called = true;
          return Promise.reject(new Error('unreachable'));
        },
      },
      { telegramBotUsername: null },
    );
    const response = await app.inject({
      method: 'POST',
      url: CHANNEL_TELEGRAM_LINK_PATH,
      headers: browser,
    });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ code: 'channel_unavailable' });
    expect(called).toBe(false);
  });

  it('503 when the Telegram rule is unarmed', async () => {
    const { app } = build({
      requestTelegramLink: () => Promise.reject(new ChannelOptInRefusal('unarmed')),
    });
    const response = await app.inject({
      method: 'POST',
      url: CHANNEL_TELEGRAM_LINK_PATH,
      headers: browser,
    });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ code: 'channel_unavailable' });
  });

  it('refuses to register with a bot username Telegram would not accept', () => {
    expect(() => build({}, { telegramBotUsername: 'not a bot' })).toThrow(/bot username/);
  });
});

describe(`POST ${CHANNEL_TELEGRAM_WEBHOOK_PATH}`, () => {
  const update = {
    update_id: 1,
    message: {
      message_id: 2,
      date: 0,
      text: `/start ${'T'.repeat(43)}`,
      chat: { id: 424242, type: 'private', username: 'someone', first_name: 'Some' },
      from: { id: 424242, is_bot: false, username: 'someone', first_name: 'Some' },
    },
  };

  it('hands the flow only the chat id and the token', async () => {
    const { app, starts } = build();
    const response = await app.inject({
      method: 'POST',
      url: CHANNEL_TELEGRAM_WEBHOOK_PATH,
      headers: { [TELEGRAM_SECRET_HEADER]: SECRET },
      payload: update,
    });
    expect(response.statusCode).toBe(200);
    expect(starts).toEqual([{ chatId: '424242', token: 'T'.repeat(43) }]);
  });

  it('answers 200 and does nothing for an update that is not a /start', async () => {
    const { app, starts } = build();
    const response = await app.inject({
      method: 'POST',
      url: CHANNEL_TELEGRAM_WEBHOOK_PATH,
      headers: { [TELEGRAM_SECRET_HEADER]: SECRET },
      payload: { update_id: 3 },
    });
    expect(response.statusCode).toBe(200);
    expect(starts).toEqual([]);
  });

  it('401 on a wrong or missing secret, without an Origin being needed', async () => {
    const { app, starts } = build();
    const wrong = await app.inject({
      method: 'POST',
      url: CHANNEL_TELEGRAM_WEBHOOK_PATH,
      headers: { [TELEGRAM_SECRET_HEADER]: 'guess' },
      payload: update,
    });
    const missing = await app.inject({
      method: 'POST',
      url: CHANNEL_TELEGRAM_WEBHOOK_PATH,
      payload: update,
    });
    expect([wrong.statusCode, missing.statusCode]).toEqual([401, 401]);
    expect([wrong.json(), missing.json()]).toMatchObject([
      { code: 'webhook_unauthenticated' },
      { code: 'webhook_unauthenticated' },
    ]);
    expect(starts).toEqual([]);
  });

  it('404 while no webhook secret is configured', async () => {
    const { app } = build({}, { telegramWebhookSecret: null });
    const response = await app.inject({
      method: 'POST',
      url: CHANNEL_TELEGRAM_WEBHOOK_PATH,
      headers: { [TELEGRAM_SECRET_HEADER]: SECRET },
      payload: update,
    });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ code: 'webhook_not_found' });
  });
});

describe('DELETE /api/v1/channels/:id', () => {
  it('204 for the account’s own channel', async () => {
    const { app } = build();
    const response = await app.inject({
      method: 'DELETE',
      url: `/api/v1/channels/${CHANNEL}`,
      headers: browser,
    });
    expect(response.statusCode).toBe(204);
  });

  it('404 for an unknown id and for one that is not a uuid', async () => {
    const { app } = build();
    const unknown = await app.inject({
      method: 'DELETE',
      url: '/api/v1/channels/13131313-0000-4000-8000-0000000000ff',
      headers: browser,
    });
    const malformed = await app.inject({
      method: 'DELETE',
      url: '/api/v1/channels/not-a-uuid',
      headers: browser,
    });
    expect([unknown.statusCode, malformed.statusCode]).toEqual([404, 404]);
    expect([unknown.json(), malformed.json()]).toMatchObject([
      { code: 'channel_not_found' },
      { code: 'channel_not_found' },
    ]);
  });
});
