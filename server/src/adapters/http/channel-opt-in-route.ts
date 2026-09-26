/**
 * Channel double opt-in over HTTP (TASKS I3; ADR-004 D8; 05 §5.3.3, §5.5.3).
 *
 * **Registered, but not armed.** `app/auth-wiring.ts` mounts these behind
 * `FIRE_WATCH_AUTH_ENABLED` with the delivery half left out: the confirmation mailer and
 * the Telegram Bot API have no implementation (sender, landing URL, confirmation copy,
 * bot identity, webhook secret are founder decisions). Until they exist the wiring passes
 * flows whose `requestEmail` refuses `unarmed` before touching the database, a `null` bot
 * username and a `null` webhook secret — so asking for a channel answers `503`, the
 * webhook is a `404`, and confirm and unlink work against whatever rows exist (none, in
 * practice). Arming a channel is a change to the wiring, not to this file.
 *
 *   * `POST /api/v1/channels/email` (session) — ask for a confirmation mail to an address.
 *   * `POST /api/v1/channels/email/confirm` — the landing page POSTs the token from the
 *     mail on an explicit click; never a GET, so a mail scanner's prefetch confirms nothing.
 *     No session needed: the token alone names its channel, and the channel becomes
 *     dispatchable only through this call.
 *   * `POST /api/v1/channels/telegram/link` (session) — a deep link the person opens in
 *     Telegram; linking is started from the bot side (05 §5.5.3).
 *   * `POST /api/v1/channels/telegram/webhook` — Telegram's update delivery. Not a browser
 *     route, so no Origin check; instead Telegram's `X-Telegram-Bot-Api-Secret-Token` is
 *     compared in constant time. Always `200` once authenticated, so Telegram never
 *     retries a `/start` it already delivered. Only the chat id and the token are read
 *     from the update (`parseTelegramStart`).
 *   * `DELETE /api/v1/channels/:id` (session) — unlink; scrubs the endpoint.
 *
 * Nothing here logs an address, a chat id or a token.
 */

import { timingSafeEqual } from 'node:crypto';

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import type { AuthenticatedSession } from '../../core/auth/sign-in.js';
import {
  ChannelOptInRefusal,
  type ChannelOptInRefusalCode,
  type EmailChannelRequestResult,
} from '../../core/channels/channel-opt-in.js';
import { parseTelegramStart, type TelegramStart } from '../../core/channels/telegram-start.js';
import { isoFromEpochMs, type Clock, type EpochMs } from '../../core/ports/clock.js';
import { refuseForeignOrigin, setSessionCookie, stringMember } from './auth-route.js';
import {
  createProblemHandler,
  ProblemError,
  type ProblemObserver,
  type CodedProblemSpec,
} from './problem.js';
import { readSessionCookie } from './session-cookie.js';

export const CHANNEL_EMAIL_PATH = '/api/v1/channels/email';
export const CHANNEL_EMAIL_CONFIRM_PATH = '/api/v1/channels/email/confirm';
export const CHANNEL_TELEGRAM_LINK_PATH = '/api/v1/channels/telegram/link';
export const CHANNEL_TELEGRAM_WEBHOOK_PATH = '/api/v1/channels/telegram/webhook';
export const CHANNEL_PATH = '/api/v1/channels/:id';

export const TELEGRAM_SECRET_HEADER = 'x-telegram-bot-api-secret-token';

const MAX_EMAIL_INPUT = 320;
const MAX_TOKEN_INPUT = 128;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** Telegram's own bot-username rule: 5–32 of [A-Za-z0-9_], ending in "bot". */
const BOT_USERNAME_RE = /^[A-Za-z][A-Za-z0-9_]{2,29}[Bb][Oo][Tt]$/;

/** The flows as the route needs them; `createPgChannelOptInFlows` satisfies it. */
export interface ChannelOptInFlows {
  requestEmail(
    request: { readonly accountId: string; readonly email: string },
    at: EpochMs,
  ): Promise<EmailChannelRequestResult>;
  confirmEmail(
    request: { readonly token: string },
    at: EpochMs,
  ): Promise<{ readonly subscriptionId: string }>;
  requestTelegramLink(
    request: { readonly accountId: string },
    at: EpochMs,
  ): Promise<{ readonly token: string; readonly expiresAt: EpochMs }>;
  handleTelegramStart(start: TelegramStart, at: EpochMs): Promise<unknown>;
  unlink(
    request: { readonly accountId: string; readonly subscriptionId: string },
    at: EpochMs,
  ): Promise<boolean>;
}

export interface ChannelOptInRouteDeps {
  readonly flows: ChannelOptInFlows;
  readonly authenticate: (
    sessionToken: string | undefined,
    at: EpochMs,
  ) => Promise<AuthenticatedSession | null>;
  /**
   * The bot's username, for `https://t.me/<bot>?start=<token>`. **Founder decision**;
   * `null` (the shipped value) answers the link route `503` before any row is written.
   */
  readonly telegramBotUsername: string | null;
  /**
   * The secret set with `setWebhook(secret_token=…)`. **Founder decision** (webhook vs
   * polling); `null` answers the webhook `404`, as if it did not exist.
   */
  readonly telegramWebhookSecret: string | null;
  readonly allowedOrigins: readonly string[];
  readonly clock: Clock;
  readonly onProblem?: ProblemObserver | undefined;
}

export function registerChannelOptInRoutes(
  app: FastifyInstance,
  deps: ChannelOptInRouteDeps,
): void {
  const botUsername = deps.telegramBotUsername;
  if (botUsername !== null && !BOT_USERNAME_RE.test(botUsername)) {
    throw new Error('telegramBotUsername is not a valid Telegram bot username');
  }

  // The browser routes: C1's Origin check on every state change.
  void app.register((scope, _options, done) => {
    scope.setErrorHandler(createProblemHandler(deps.onProblem));
    scope.addHook('onRequest', (request, _reply, next) => {
      refuseForeignOrigin(request, deps.allowedOrigins);
      next();
    });

    scope.post(CHANNEL_EMAIL_PATH, async (request, reply) => {
      const { accountId, at } = await requireSession(request, reply, deps);
      const email = stringMember(request.body, 'email', MAX_EMAIL_INPUT);
      const result = await mapRefusal(deps.flows.requestEmail({ accountId, email }, at));
      return result.status === 'pending'
        ? reply.code(202).send({
            status: 'pending',
            channel_id: result.subscriptionId,
            expires_at: isoFromEpochMs(result.expiresAt),
          })
        : reply.code(200).send({ status: 'confirmed', channel_id: result.subscriptionId });
    });

    scope.post(CHANNEL_EMAIL_CONFIRM_PATH, async (request, reply) => {
      const token = stringMember(request.body, 'token', MAX_TOKEN_INPUT);
      const confirmed = await mapRefusal(deps.flows.confirmEmail({ token }, deps.clock.now()));
      return reply.code(200).send({ status: 'confirmed', channel_id: confirmed.subscriptionId });
    });

    scope.post(CHANNEL_TELEGRAM_LINK_PATH, async (request, reply) => {
      const { accountId, at } = await requireSession(request, reply, deps);
      if (botUsername === null) throw new ProblemError(CHANNEL_REFUSALS.unarmed);
      const issued = await mapRefusal(deps.flows.requestTelegramLink({ accountId }, at));
      return reply.code(201).send({
        link: `https://t.me/${botUsername}?start=${issued.token}`,
        expires_at: isoFromEpochMs(issued.expiresAt),
      });
    });

    scope.delete<{ Params: { id: string } }>(CHANNEL_PATH, async (request, reply) => {
      const { accountId, at } = await requireSession(request, reply, deps);
      const subscriptionId = request.params.id;
      if (
        !UUID_RE.test(subscriptionId) ||
        !(await deps.flows.unlink({ accountId, subscriptionId }, at))
      ) {
        throw new ProblemError(CHANNEL_NOT_FOUND);
      }
      return reply.code(204).send();
    });

    done();
  });

  // Telegram's webhook: authenticated by its secret header, not by Origin.
  void app.register((scope, _options, done) => {
    scope.setErrorHandler(createProblemHandler(deps.onProblem));
    scope.post(CHANNEL_TELEGRAM_WEBHOOK_PATH, async (request, reply) => {
      const secret = deps.telegramWebhookSecret;
      if (secret === null) {
        throw new ProblemError(WEBHOOK_NOT_FOUND);
      }
      if (!secretMatches(request.headers[TELEGRAM_SECRET_HEADER], secret)) {
        throw new ProblemError(WEBHOOK_UNAUTHENTICATED);
      }
      const parsed = parseTelegramStart(request.body);
      if (parsed.kind === 'start') {
        await deps.flows.handleTelegramStart(parsed.start, deps.clock.now());
      }
      return reply.code(200).send({});
    });
    done();
  });
}

async function requireSession(
  request: FastifyRequest,
  reply: FastifyReply,
  deps: Pick<ChannelOptInRouteDeps, 'authenticate' | 'clock'>,
): Promise<{ readonly accountId: string; readonly at: EpochMs }> {
  const at = deps.clock.now();
  const token = readSessionCookie(request.headers.cookie);
  const session = await deps.authenticate(token, at);
  if (session === null || token === undefined) {
    if (token !== undefined) setSessionCookie(reply, null, at);
    throw new ProblemError(NOT_SIGNED_IN);
  }
  setSessionCookie(reply, { token, expiresAt: session.expiresAt }, at);
  return { accountId: session.accountId, at };
}

function secretMatches(presented: string | string[] | undefined, secret: string): boolean {
  if (typeof presented !== 'string') return false;
  const a = Buffer.from(presented);
  const b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}

const NOT_SIGNED_IN: CodedProblemSpec = {
  status: 401,
  title: 'Not signed in',
  detail: 'Sign in to manage alert channels.',
  code: 'not_signed_in',
};

const CHANNEL_NOT_FOUND: CodedProblemSpec = {
  status: 404,
  title: 'Channel not found',
  detail: 'There is no such alert channel.',
  code: 'channel_not_found',
};

const WEBHOOK_NOT_FOUND: CodedProblemSpec = {
  status: 404,
  title: 'Not found',
  detail: 'No such route.',
  code: 'webhook_not_found',
};

const WEBHOOK_UNAUTHENTICATED: CodedProblemSpec = {
  status: 401,
  title: 'Not authenticated',
  detail: 'This route only accepts Telegram updates.',
  code: 'webhook_unauthenticated',
};

/** Every refusal this module writes itself, beyond {@link CHANNEL_REFUSALS}. */
export const CHANNEL_PROBLEMS: readonly CodedProblemSpec[] = [
  NOT_SIGNED_IN,
  CHANNEL_NOT_FOUND,
  WEBHOOK_NOT_FOUND,
  WEBHOOK_UNAUTHENTICATED,
];

const LINK_NOT_VALID: Omit<CodedProblemSpec, 'retryAfterSeconds'> = {
  status: 400,
  title: 'Link not valid',
  detail: 'This confirmation link is not valid. Request a new one.',
  code: 'link_invalid',
};

/** The core's refusals as the wire states them. Exported for the code-coverage test. */
export const CHANNEL_REFUSALS: Readonly<
  Record<ChannelOptInRefusalCode, Omit<CodedProblemSpec, 'retryAfterSeconds'>>
> = {
  invalid_email: {
    status: 400,
    title: 'Invalid address',
    detail: 'That is not a valid e-mail address.',
    code: 'invalid_email',
  },
  unarmed: {
    status: 503,
    title: 'Channel not available',
    detail: 'This alert channel is not available yet.',
    code: 'channel_unavailable',
  },
  rate_limited: {
    status: 429,
    title: 'Too many confirmation messages',
    detail: 'Too many confirmation messages were requested. Try again later.',
    code: 'rate_limited',
  },
  unknown: LINK_NOT_VALID,
  // A token for another channel is, to the person holding it, simply not valid here.
  wrong_channel: LINK_NOT_VALID,
  // Same answer as `unknown`: a deleted account's link must not confirm that it existed.
  account_deleted: LINK_NOT_VALID,
  expired: {
    status: 400,
    title: 'Link expired',
    detail: 'This confirmation link has expired. Request a new one.',
    code: 'link_expired',
  },
  used: {
    status: 400,
    title: 'Link already used',
    detail: 'This confirmation link was already used.',
    code: 'link_used',
  },
  superseded: {
    status: 400,
    title: 'Link replaced',
    detail: 'A newer confirmation link was sent. Use the most recent one.',
    code: 'link_superseded',
  },
  revoked: {
    status: 400,
    title: 'Channel removed',
    detail: 'This alert channel was removed. Add it again to receive alerts there.',
    code: 'channel_removed',
  },
};

async function mapRefusal<T>(work: Promise<T>): Promise<T> {
  try {
    return await work;
  } catch (error) {
    if (!(error instanceof ChannelOptInRefusal)) throw error;
    const spec = CHANNEL_REFUSALS[error.code];
    throw new ProblemError(
      error.retryAfterSeconds === undefined
        ? spec
        : { ...spec, retryAfterSeconds: error.retryAfterSeconds },
      { cause: error },
    );
  }
}
