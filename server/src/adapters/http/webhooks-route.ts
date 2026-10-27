/**
 * An account's signed alert webhooks (TASKS V2-G2; docs/WEBHOOKS.md):
 *
 *   * `GET  /api/v1/webhooks` — the account's endpoints, never their secrets.
 *   * `POST /api/v1/webhooks` — `{ "url": "https://…" }`; registers an endpoint and answers
 *     `201` with it **and its signing secret, shown this once**.
 *   * `DELETE /api/v1/webhooks/:id` — removes it; queued alerts to it are not sent.
 *   * `POST /api/v1/webhooks/:id/rotate-secret` — a new secret, shown this once; the old
 *     one stops signing at once.
 *   * `POST /api/v1/webhooks/:id/test` — one signed `ping`, sent now. A 2xx answer confirms
 *     the endpoint (alerts route only to confirmed endpoints) and re-enables one that was
 *     auto-disabled. Limited per account ({@link WebhooksRouteDeps.pingLimiter}).
 *
 * The session, Origin and ownership rules are the zone routes' (`zones-route.ts`): the
 * account comes from the session cookie alone, every state-changing route passes C1's
 * Origin check, and an endpoint the account does not own is the same `404` as one that
 * does not exist.
 *
 * Nothing here echoes the submitted URL in an error — its path or query may hold the
 * receiver's own token — and the two answers that carry a secret are `no-store`.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import { WEBHOOK_SIGNATURE_HEADER } from '@fire-watch/contracts';

import type { AuthenticatedSession } from '../../core/auth/sign-in.js';
import type { RateLimiter } from '../../core/http/rate-limiter.js';
import { isoFromEpochMs, type Clock, type EpochMs } from '../../core/ports/clock.js';
import type { WebhookEndpointView } from '../../core/ports/webhook-store.js';
import type { WebhookPingResult } from '../webhooks/webhook-pinger.js';
import {
  WebhookRegistrationError,
  type RegisteredWebhook,
  type RotatedWebhookSecret,
} from '../webhooks/webhook-registry.js';
import { INVALID_BODY, refuseForeignOrigin, setSessionCookie } from './auth-route.js';
import {
  createProblemHandler,
  ProblemError,
  type CodedProblemSpec,
  type ProblemObserver,
} from './problem.js';
import { readSessionCookie } from './session-cookie.js';

export const WEBHOOKS_PATH = '/api/v1/webhooks';
export const WEBHOOK_PATH = '/api/v1/webhooks/:id';
export const WEBHOOK_ROTATE_PATH = '/api/v1/webhooks/:id/rotate-secret';
export const WEBHOOK_TEST_PATH = '/api/v1/webhooks/:id/test';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** The URL cap is the registry's (`maxUrlLength`); this only stops a megabyte string. */
const MAX_URL_INPUT = 8_192;

export interface WebhooksRouteDeps {
  readonly authenticate: (
    sessionToken: string | undefined,
    at: EpochMs,
  ) => Promise<AuthenticatedSession | null>;
  /** `createWebhookRegistry(...)`: throws `WebhookRegistrationError` on a refusal. */
  readonly create: (accountId: string, url: string, at: EpochMs) => Promise<RegisteredWebhook>;
  readonly list: (accountId: string) => Promise<readonly WebhookEndpointView[]>;
  readonly remove: (accountId: string, endpointId: string, at: EpochMs) => Promise<boolean>;
  readonly rotateSecret: (
    accountId: string,
    endpointId: string,
    at: EpochMs,
  ) => Promise<RotatedWebhookSecret | null>;
  /** `createWebhookPinger(...).ping`; null when the account owns no such endpoint. */
  readonly ping: (accountId: string, endpointId: string) => Promise<WebhookPingResult | null>;
  /** Test pings per account, checked after the session. None: unlimited. */
  readonly pingLimiter?: RateLimiter | undefined;
  readonly allowedOrigins: readonly string[];
  readonly clock: Clock;
  readonly onProblem?: ProblemObserver | undefined;
}

/** The wire shape of an endpoint. snake_case, as every other public document. */
export interface WebhookEndpointDocument {
  readonly id: string;
  readonly url: string;
  readonly confirmed: boolean;
  readonly created_at: string;
  readonly secret_rotated_at: string;
  readonly disabled_at: string | null;
  readonly disabled_reason: string | null;
  readonly consecutive_failures: number;
  readonly last_success_at: string | null;
  readonly last_failure_at: string | null;
}

export function registerWebhooksRoutes(app: FastifyInstance, deps: WebhooksRouteDeps): void {
  void app.register((scope, _options, done) => {
    scope.setErrorHandler(createProblemHandler(deps.onProblem));
    scope.addHook('onRequest', (request, _reply, next) => {
      refuseForeignOrigin(request, deps.allowedOrigins);
      next();
    });

    scope.get(WEBHOOKS_PATH, async (request, reply) => {
      const { accountId } = await requireSession(request, reply, deps);
      const endpoints = await deps.list(accountId);
      return reply.send({ endpoints: endpoints.map(toDocument) });
    });

    scope.post(WEBHOOKS_PATH, async (request, reply) => {
      const { accountId, at } = await requireSession(request, reply, deps);
      const url = parseCreate(request.body);
      const registered = await mapRegistrationRefusal(deps.create(accountId, url, at));
      return reply
        .code(201)
        .header('cache-control', 'no-store')
        .send({
          endpoint: toDocument(registered.endpoint),
          secret: registered.secret,
          signature_header: WEBHOOK_SIGNATURE_HEADER,
        });
    });

    scope.delete<{ Params: { id: string } }>(WEBHOOK_PATH, async (request, reply) => {
      const { accountId, at } = await requireSession(request, reply, deps);
      const id = ownedId(request.params.id);
      if (!(await deps.remove(accountId, id, at))) throw new ProblemError(ENDPOINT_NOT_FOUND);
      return reply.code(204).send();
    });

    scope.post<{ Params: { id: string } }>(WEBHOOK_ROTATE_PATH, async (request, reply) => {
      const { accountId, at } = await requireSession(request, reply, deps);
      const rotated = await deps.rotateSecret(accountId, ownedId(request.params.id), at);
      if (rotated === null) throw new ProblemError(ENDPOINT_NOT_FOUND);
      return reply
        .header('cache-control', 'no-store')
        .send({ secret: rotated.secret, secret_rotated_at: isoFromEpochMs(rotated.rotatedAtMs) });
    });

    scope.post<{ Params: { id: string } }>(WEBHOOK_TEST_PATH, async (request, reply) => {
      const { accountId, at } = await requireSession(request, reply, deps);
      const id = ownedId(request.params.id);
      const decision = deps.pingLimiter?.check(accountId, at);
      if (decision !== undefined && !decision.allowed) {
        throw new ProblemError({
          ...TOO_MANY_PINGS,
          retryAfterSeconds: decision.retryAfterSeconds,
        });
      }
      const result = await deps.ping(accountId, id);
      if (result === null) throw new ProblemError(ENDPOINT_NOT_FOUND);
      // 200 whatever the receiver answered: the request succeeded, the ping's outcome is data.
      return reply.send({
        delivery_id: result.deliveryId,
        outcome: result.outcome,
        status_code: result.statusCode,
        error: result.error,
        duration_ms: result.durationMs,
        confirmed: result.confirmed,
      });
    });

    done();
  });
}

async function requireSession(
  request: FastifyRequest,
  reply: FastifyReply,
  deps: Pick<WebhooksRouteDeps, 'authenticate' | 'clock'>,
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

/** A malformed id names no endpoint, so it is the same `404` as a foreign one. */
function ownedId(raw: string): string {
  if (!UUID_RE.test(raw)) throw new ProblemError(ENDPOINT_NOT_FOUND);
  return raw;
}

/** Types only; what a valid URL is belongs to the registry (`validateWebhookUrl`). */
function parseCreate(body: unknown): string {
  if (typeof body !== 'object' || body === null) throw new ProblemError(INVALID_BODY);
  const url = (body as Record<string, unknown>)['url'];
  if (typeof url !== 'string' || url.length > MAX_URL_INPUT) throw new ProblemError(INVALID_BODY);
  return url;
}

async function mapRegistrationRefusal<T>(work: Promise<T>): Promise<T> {
  try {
    return await work;
  } catch (error) {
    if (!(error instanceof WebhookRegistrationError)) throw error;
    const spec = error.refusal.kind === 'limit_reached' ? LIMIT_REACHED : URL_INVALID;
    throw new ProblemError(spec, { cause: error });
  }
}

function toDocument(view: WebhookEndpointView): WebhookEndpointDocument {
  const iso = (ms: EpochMs | null): string | null => (ms === null ? null : isoFromEpochMs(ms));
  return {
    id: view.id,
    url: view.url,
    confirmed: view.confirmed,
    created_at: isoFromEpochMs(view.createdAtMs),
    secret_rotated_at: isoFromEpochMs(view.secretRotatedAtMs),
    disabled_at: iso(view.disabledAtMs),
    disabled_reason: view.disabledReason,
    consecutive_failures: view.consecutiveFailures,
    last_success_at: iso(view.lastSuccessAtMs),
    last_failure_at: iso(view.lastFailureAtMs),
  };
}

const NOT_SIGNED_IN: CodedProblemSpec = {
  status: 401,
  title: 'Not signed in',
  detail: 'Sign in to manage webhooks.',
  code: 'not_signed_in',
};

const ENDPOINT_NOT_FOUND: CodedProblemSpec = {
  status: 404,
  title: 'Webhook not found',
  detail: 'There is no such webhook endpoint.',
  code: 'webhook_endpoint_not_found',
};

/**
 * One answer for every URL refusal, so the endpoint is not a probe of what our resolver
 * sees: "is `intranet.corp` private or just missing?" is not ours to answer. The integrator
 * page lists the rules.
 */
const URL_INVALID: CodedProblemSpec = {
  status: 400,
  title: 'Webhook URL not accepted',
  detail:
    'The URL must be https on port 443, without credentials or a fragment, and its host must resolve to public addresses only.',
  code: 'webhook_url_invalid',
};

const LIMIT_REACHED: CodedProblemSpec = {
  status: 409,
  title: 'Too many webhooks',
  detail: 'This account already has the most webhook endpoints allowed. Remove one first.',
  code: 'webhook_limit_reached',
};

const TOO_MANY_PINGS: CodedProblemSpec = {
  status: 429,
  title: 'Too many test pings',
  detail: 'Too many test pings were sent recently. Try again later.',
  code: 'rate_limited',
};

/** Every refusal this module writes. Exported for the code-coverage test. */
export const WEBHOOKS_PROBLEMS: readonly CodedProblemSpec[] = [
  NOT_SIGNED_IN,
  ENDPOINT_NOT_FOUND,
  URL_INVALID,
  LIMIT_REACHED,
  TOO_MANY_PINGS,
];
