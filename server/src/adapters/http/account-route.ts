/**
 * `/api/v1/account` — the signed-in account itself.
 *
 *   * `GET` — "am I signed in?" for the web app: `200 {signed_in, session_expires_at}` with
 *     the sliding cookie re-issued, or `401` (and a clearing cookie for a dead one). It
 *     answers nothing about the person — no address, no account id: the page needs to
 *     know whether to show the account screen, and a response body is one more place a
 *     browser extension or a shared screen can read an address from. Sign-out is
 *     `POST /api/v1/auth/logout` (`auth-route.ts`).
 *   * `DELETE` — the signed-in account erases itself (TASKS I4; ADR-004 D8, A1.3, A1.9).
 *
 * **The account is the session's.** There is no account id in the path or the body, so a
 * request can only ever erase the account whose cookie it carries. The Origin check is
 * C1's, as on every other state-changing route, so a cross-site form cannot trigger it.
 *
 * **One call, one transaction.** `erase` is `createPgAccountEraser(...)`: cancel and
 * pseudonymize the outbox, delete zones, subscriptions, sessions and link requests,
 * tombstone the account and write the ledger, or do none of it. The answer is `204` with a
 * clearing cookie — the session the request came in on no longer exists.
 *
 * A second request racing the first (a double click) waits on the account lock and then
 * finds the account already erased; it gets the same `204`, so the answer does not depend
 * on which of the two won. A grace period or a confirmation step before erasure is a UX
 * decision that is still open; this route erases immediately.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import type { AuthenticatedSession } from '../../core/auth/sign-in.js';
import type { ErasureOutcome } from '../../core/erasure/erase-account.js';
import { isoFromEpochMs, type Clock, type EpochMs } from '../../core/ports/clock.js';
import { refuseForeignOrigin, setSessionCookie } from './auth-route.js';
import {
  createProblemHandler,
  ProblemError,
  type CodedProblemSpec,
  type ProblemObserver,
} from './problem.js';
import { readSessionCookie } from './session-cookie.js';

export const ACCOUNT_PATH = '/api/v1/account';

const NOT_SIGNED_IN: CodedProblemSpec = {
  status: 401,
  title: 'Not signed in',
  detail: 'Sign in to see your account.',
  code: 'not_signed_in',
};

const NOT_SIGNED_IN_TO_DELETE: CodedProblemSpec = {
  status: 401,
  title: 'Not signed in',
  detail: 'Sign in to delete your account.',
  code: 'not_signed_in',
};

/** Every refusal this module writes itself. Exported for the code-coverage test. */
export const ACCOUNT_PROBLEMS: readonly CodedProblemSpec[] = [
  NOT_SIGNED_IN,
  NOT_SIGNED_IN_TO_DELETE,
];

export interface AccountRouteDeps {
  readonly authenticate: (
    sessionToken: string | undefined,
    at: EpochMs,
  ) => Promise<AuthenticatedSession | null>;
  /** `createPgAccountEraser(pool)`: the whole erasure in one transaction. */
  readonly erase: (accountId: string, at: EpochMs) => Promise<ErasureOutcome>;
  readonly allowedOrigins: readonly string[];
  readonly clock: Clock;
  readonly onProblem?: ProblemObserver | undefined;
}

export function registerAccountRoutes(app: FastifyInstance, deps: AccountRouteDeps): void {
  void app.register((scope, _options, done) => {
    scope.setErrorHandler(createProblemHandler(deps.onProblem));
    scope.addHook('onRequest', (request, _reply, next) => {
      refuseForeignOrigin(request, deps.allowedOrigins);
      next();
    });

    scope.get(ACCOUNT_PATH, async (request, reply) => {
      const at = deps.clock.now();
      const token = readSessionCookie(request.headers.cookie);
      const session = await deps.authenticate(token, at);
      if (session === null || token === undefined) {
        if (token !== undefined) setSessionCookie(reply, null, at);
        throw new ProblemError(NOT_SIGNED_IN);
      }
      setSessionCookie(reply, { token, expiresAt: session.expiresAt }, at);
      return reply
        .code(200)
        .header('cache-control', 'no-store')
        .send({ signed_in: true, session_expires_at: isoFromEpochMs(session.expiresAt) });
    });

    scope.delete(ACCOUNT_PATH, async (request, reply) => {
      const { accountId, at } = await requireSession(request, reply, deps);
      // `missing` cannot follow a live session (the session row references the account),
      // and `already_erased` is the losing side of a race; both leave nothing to erase.
      await deps.erase(accountId, at);
      setSessionCookie(reply, null, at);
      return reply.code(204).send();
    });

    done();
  });
}

/**
 * The session check of `zones-route.ts`, without the sliding re-issue: the cookie is about
 * to be cleared, so extending it first would only be undone.
 */
async function requireSession(
  request: FastifyRequest,
  reply: FastifyReply,
  deps: Pick<AccountRouteDeps, 'authenticate' | 'clock'>,
): Promise<{ readonly accountId: string; readonly at: EpochMs }> {
  const at = deps.clock.now();
  const token = readSessionCookie(request.headers.cookie);
  const session = await deps.authenticate(token, at);
  if (session === null || token === undefined) {
    if (token !== undefined) setSessionCookie(reply, null, at);
    throw new ProblemError(NOT_SIGNED_IN_TO_DELETE);
  }
  return { accountId: session.accountId, at };
}
