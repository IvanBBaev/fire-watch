/**
 * `/api/v1/account/preferences` — the signed-in account's synced preferences (TASKS
 * V2-C5, cross-device sync).
 *
 *   * `GET` — `200 {revision, document}` with `ETag: "<revision>"`. Revision 0 and the
 *     empty document mean nothing was ever stored for this account.
 *   * `PUT` — replace the document. `If-Match` must name the revision the client based
 *     the write on (`"0"` for "nothing stored yet"): `200` with the new state and ETag;
 *     `409 preferences_conflict` when another device wrote first (the client refetches,
 *     merges and tries again); `428 preferences_revision_required` with no usable
 *     `If-Match` — a blind overwrite is exactly what this route exists to prevent;
 *     `422 preferences_invalid` for a body that is not a v1 document.
 *
 * **The account is the session's**, as on every account route: no id in the path or the
 * body. The Origin check is C1's (the GET is exempt). The session cookie slides as on the
 * zone routes, because a sync is the reader using the app.
 *
 * **Bounded before it is parsed.** Fastify's `bodyLimit` on the PUT is a little above
 * the contract's cap, so an oversized body is refused (`413`, the handler's
 * `request_refused`) without being buffered whole; the contract's own size check is the
 * exact one.
 *
 * Every answer is `cache-control: no-store` — it is one person's settings.
 */

import {
  ACCOUNT_PREFERENCES_MAX_BYTES,
  parsePreferencesEtag,
  preferencesEtag,
  type AccountPreferencesState,
} from '@fire-watch/contracts';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import type { AuthenticatedSession } from '../../core/auth/sign-in.js';
import type {
  WriteAccountPreferencesOutcome,
  WriteAccountPreferencesRequest,
} from '../../core/preferences/account-preferences.js';
import { isoFromEpochMs, type Clock, type EpochMs } from '../../core/ports/clock.js';
import { refuseForeignOrigin, setSessionCookie } from './auth-route.js';
import {
  createProblemHandler,
  ProblemError,
  type CodedProblemSpec,
  type ProblemObserver,
} from './problem.js';
import { readSessionCookie } from './session-cookie.js';

export const ACCOUNT_PREFERENCES_PATH = '/api/v1/account/preferences';

/**
 * The PUT's body limit: the document cap plus room for whitespace a client may add. A
 * body between the two is read and then refused by the contract's exact check.
 */
export const ACCOUNT_PREFERENCES_BODY_LIMIT = 2 * ACCOUNT_PREFERENCES_MAX_BYTES;

const NOT_SIGNED_IN: CodedProblemSpec = {
  status: 401,
  title: 'Not signed in',
  detail: 'Sign in to sync your preferences.',
  code: 'not_signed_in',
};

export const PREFERENCES_INVALID: CodedProblemSpec = {
  status: 422,
  title: 'Invalid preferences',
  detail: 'The preferences document is not one this server accepts.',
  code: 'preferences_invalid',
};

export const PREFERENCES_REVISION_REQUIRED: CodedProblemSpec = {
  status: 428,
  title: 'Revision required',
  detail: 'Send If-Match with the revision these preferences were based on.',
  code: 'preferences_revision_required',
};

export const PREFERENCES_CONFLICT: CodedProblemSpec = {
  status: 409,
  title: 'Preferences changed',
  detail: 'The preferences were changed on another device. Read them again and retry.',
  code: 'preferences_conflict',
};

/** Every refusal this module writes itself. Exported for the code-coverage test. */
export const ACCOUNT_PREFERENCES_PROBLEMS: readonly CodedProblemSpec[] = [
  NOT_SIGNED_IN,
  PREFERENCES_INVALID,
  PREFERENCES_REVISION_REQUIRED,
  PREFERENCES_CONFLICT,
];

export interface AccountPreferencesRouteDeps {
  readonly authenticate: (
    sessionToken: string | undefined,
    at: EpochMs,
  ) => Promise<AuthenticatedSession | null>;
  /** `readAccountPreferences` over the store. */
  readonly read: (accountId: string) => Promise<AccountPreferencesState>;
  /** `writeAccountPreferences` over the store. */
  readonly write: (
    request: WriteAccountPreferencesRequest,
    atIso: string,
  ) => Promise<WriteAccountPreferencesOutcome>;
  readonly allowedOrigins: readonly string[];
  readonly clock: Clock;
  readonly onProblem?: ProblemObserver | undefined;
}

export function registerAccountPreferencesRoutes(
  app: FastifyInstance,
  deps: AccountPreferencesRouteDeps,
): void {
  void app.register((scope, _options, done) => {
    scope.setErrorHandler(createProblemHandler(deps.onProblem));
    scope.addHook('onRequest', (request, _reply, next) => {
      refuseForeignOrigin(request, deps.allowedOrigins);
      next();
    });

    scope.get(ACCOUNT_PREFERENCES_PATH, async (request, reply) => {
      const { accountId } = await requireSession(request, reply, deps);
      return sendState(reply, await deps.read(accountId));
    });

    scope.put(
      ACCOUNT_PREFERENCES_PATH,
      { bodyLimit: ACCOUNT_PREFERENCES_BODY_LIMIT },
      async (request, reply) => {
        const { accountId, at } = await requireSession(request, reply, deps);
        const expectedRevision = parsePreferencesEtag(request.headers['if-match']);
        if (expectedRevision === null) throw new ProblemError(PREFERENCES_REVISION_REQUIRED);
        const outcome = await deps.write(
          { accountId, expectedRevision, body: request.body },
          isoFromEpochMs(at),
        );
        switch (outcome.kind) {
          case 'written':
            return sendState(reply, outcome.state);
          case 'invalid':
            throw new ProblemError(PREFERENCES_INVALID);
          case 'conflict':
            throw new ProblemError(PREFERENCES_CONFLICT);
        }
      },
    );

    done();
  });
}

function sendState(reply: FastifyReply, state: AccountPreferencesState): FastifyReply {
  return reply
    .code(200)
    .header('cache-control', 'no-store')
    .header('etag', preferencesEtag(state.revision))
    .send({ revision: state.revision, document: state.document });
}

async function requireSession(
  request: FastifyRequest,
  reply: FastifyReply,
  deps: Pick<AccountPreferencesRouteDeps, 'authenticate' | 'clock'>,
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
