/**
 * `GET /api/v1/account/export` — the signed-in account downloads everything held about it
 * (TASKS I6; GDPR Art. 15 and 20).
 *
 * Registered by `app/auth-wiring.ts` behind `FIRE_WATCH_AUTH_ENABLED`, and only when the
 * API has a zone keyring: the document carries each zone's opened centre, so without the
 * key there is nothing complete to export.
 *
 * **The account is the session's.** There is no account id in the path or the query, so
 * a request can only ever export the account whose cookie it carries. The route is a GET
 * and changes nothing; C1's Origin hook is mounted as on every account route, and exempts
 * GET, so it guards any method added here later. A cross-site page cannot read the
 * response either, because the answer carries no CORS header.
 *
 * **The answer.** `200` with the `account_export_v1` document as JSON, as an attachment
 * named after the UTC day, `Cache-Control: no-store` so no proxy or browser cache keeps a
 * copy, and `X-Content-Type-Options: nosniff`. The sliding session is re-issued as on the
 * zones routes. A live session cannot belong to an erased or missing account (the
 * session row references the account, and erasure deletes sessions in the same
 * transaction); should the race still land there, the answer is `404` and names nothing.
 *
 * **Rate-limited per account** (DPIA: "rate-limit the export route and mount it with
 * auth"). The export is one read-only snapshot over ten small tables, so it is cheap; the
 * limit is there so a stolen cookie cannot be turned into a scraper, and so a reload loop
 * cannot hold a connection. The check runs after the session (the key is the account,
 * never an address) and before any read; a refusal is `429` with `Retry-After`. The
 * value is the wiring's (`ACCOUNT_EXPORT_RATE_LIMIT`), not a design number.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import type { AccountExportOutcome } from '../../core/account-export/build-account-export.js';
import type { AuthenticatedSession } from '../../core/auth/sign-in.js';
import type { RateLimiter } from '../../core/http/rate-limiter.js';
import { isoFromEpochMs, type Clock, type EpochMs } from '../../core/ports/clock.js';
import { refuseForeignOrigin, setSessionCookie } from './auth-route.js';
import {
  createProblemHandler,
  ProblemError,
  type CodedProblemSpec,
  type ProblemObserver,
} from './problem.js';
import { readSessionCookie } from './session-cookie.js';

export const ACCOUNT_EXPORT_PATH = '/api/v1/account/export';

const NOT_SIGNED_IN: CodedProblemSpec = {
  status: 401,
  title: 'Not signed in',
  detail: 'Sign in to download your data.',
  code: 'not_signed_in',
};

const TOO_MANY_EXPORTS: CodedProblemSpec = {
  status: 429,
  title: 'Too many exports',
  detail: 'You have downloaded your data several times recently. Try again later.',
  code: 'rate_limited',
};

const ACCOUNT_NOT_FOUND: CodedProblemSpec = {
  status: 404,
  title: 'Account not found',
  detail: 'There is no account to export.',
  code: 'account_not_found',
};

/** Every refusal this module writes itself. Exported for the code-coverage test. */
export const ACCOUNT_EXPORT_PROBLEMS: readonly CodedProblemSpec[] = [
  NOT_SIGNED_IN,
  TOO_MANY_EXPORTS,
  ACCOUNT_NOT_FOUND,
];

export interface AccountExportRouteDeps {
  readonly authenticate: (
    sessionToken: string | undefined,
    at: EpochMs,
  ) => Promise<AuthenticatedSession | null>;
  /** `createPgAccountExporter(pool, cipher)`: one read-only snapshot. */
  readonly exportAccount: (accountId: string, at: EpochMs) => Promise<AccountExportOutcome>;
  /** Per account, checked after the session and before the read. None: unlimited. */
  readonly limiter?: RateLimiter | undefined;
  readonly allowedOrigins: readonly string[];
  readonly clock: Clock;
  readonly onProblem?: ProblemObserver | undefined;
}

/** `fire-watch-account-export-2026-09-24.json`: the UTC day, nothing that identifies anyone. */
export function exportFileName(at: EpochMs): string {
  return `fire-watch-account-export-${isoFromEpochMs(at).slice(0, 10)}.json`;
}

export function registerAccountExportRoutes(
  app: FastifyInstance,
  deps: AccountExportRouteDeps,
): void {
  void app.register((scope, _options, done) => {
    scope.setErrorHandler(createProblemHandler(deps.onProblem));
    scope.addHook('onRequest', (request, _reply, next) => {
      refuseForeignOrigin(request, deps.allowedOrigins);
      next();
    });

    scope.get(ACCOUNT_EXPORT_PATH, async (request, reply) => {
      const { accountId, at } = await requireSession(request, reply, deps);
      const decision = deps.limiter?.check(accountId, at);
      if (decision !== undefined && !decision.allowed) {
        throw new ProblemError({
          ...TOO_MANY_EXPORTS,
          retryAfterSeconds: decision.retryAfterSeconds,
        });
      }
      const outcome = await deps.exportAccount(accountId, at);
      if (outcome.status !== 'exported') {
        throw new ProblemError(ACCOUNT_NOT_FOUND);
      }
      return reply
        .code(200)
        .header('content-type', 'application/json; charset=utf-8')
        .header('content-disposition', `attachment; filename="${exportFileName(at)}"`)
        .header('cache-control', 'no-store')
        .header('x-content-type-options', 'nosniff')
        .send(JSON.stringify(outcome.document, null, 2));
    });

    done();
  });
}

/** The session check of `zones-route.ts`, sliding re-issue included. */
async function requireSession(
  request: FastifyRequest,
  reply: FastifyReply,
  deps: Pick<AccountExportRouteDeps, 'authenticate' | 'clock'>,
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
