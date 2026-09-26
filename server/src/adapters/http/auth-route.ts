/**
 * `POST /api/v1/auth/{link,continue,logout}` — first-party sign-in (TASKS I1; 05 §5.4.1
 * C1–C2). Magic link only; OAuth (Google/Apple) is specified by C2 but not built — its
 * client registration and account-linking rules are founder decisions (see the I1 report).
 *
 * **All three are POSTs, and all three check `Origin`.** C1's CSRF defence is
 * `SameSite=Lax` *plus* Origin validation on state-changing routes: Lax still sends the
 * cookie on a top-level cross-site POST in some browsers' "Lax+POST" grace window, and a
 * login-CSRF (signing a victim into the attacker's account) needs no cookie at all. A
 * request with no `Origin`, or `Origin: null`, is refused — every browser that runs the web
 * app sends one on a POST, and a non-browser caller has no business signing anyone in.
 *
 * **"Continue" is a POST, never the link's GET.** C2 requires the landing page to ask for
 * an explicit "Continue": mail scanners prefetch every URL in a message, and a GET that
 * consumed the link would sign the scanner in and burn the user's link. The web landing
 * page reads the token (from the URL fragment, recommended) and POSTs it here.
 *
 * **What the link endpoint reveals.** A well-formed address gets `202` whether or not an
 * account exists; the one other answer is `429`, which counts requests, not accounts.
 *
 * Nothing here logs an address or a token: refusals are literals, and the problem
 * observer receives an `AuthRefusal` whose message is its code alone.
 *
 * **Every refusal carries a `code`** (`PROBLEM_CODES` in `@fire-watch/contracts`): the web
 * client switches on it, never on the English title. The core's `AuthRefusalCode` is an
 * internal vocabulary; {@link AUTH_REFUSALS} is where it is translated to the wire's.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import { isAllowedOrigin } from '../../core/auth/auth-policy.js';
import { AuthRefusal, type AuthRefusalCode, type StartedSession } from '../../core/auth/sign-in.js';
import type { Clock, EpochMs } from '../../core/ports/clock.js';
import {
  createProblemHandler,
  ProblemError,
  type CodedProblemSpec,
  type ProblemObserver,
} from './problem.js';
import { clearedSessionCookie, readSessionCookie, sessionCookie } from './session-cookie.js';

export const AUTH_LINK_PATH = '/api/v1/auth/link';
export const AUTH_CONTINUE_PATH = '/api/v1/auth/continue';
export const AUTH_LOGOUT_PATH = '/api/v1/auth/logout';

/** RFC 5321's path limit. Longer is refused before the core sees it. */
const MAX_EMAIL_INPUT = 320;
/** Generous for a 43-character token; the tokens adapter does the exact check. */
const MAX_TOKEN_INPUT = 128;

/** C1's refusal, shared by every account-surface route. */
export const ORIGIN_REFUSED: CodedProblemSpec = {
  status: 403,
  title: 'Origin refused',
  detail: 'This request must come from the Fire Watch web app.',
  code: 'origin_refused',
};

/** A body that is not the JSON object a route expects; shared with the other routes. */
export const INVALID_BODY: CodedProblemSpec = {
  status: 400,
  title: 'Invalid request body',
  detail: 'The request body is missing a required field or has one of the wrong type.',
  code: 'invalid_body',
};

/** The flows as the route needs them; `createPgSignInFlows` satisfies it. */
export interface SignInFlows {
  requestLink(
    request: { readonly email: string; readonly userAgent: string | undefined },
    at: EpochMs,
  ): Promise<void>;
  continueLink(
    request: { readonly token: string; readonly userAgent: string | undefined },
    at: EpochMs,
  ): Promise<StartedSession>;
  signOut(sessionToken: string | undefined, at: EpochMs): Promise<void>;
}

export interface AuthRouteDeps {
  readonly flows: SignInFlows;
  /** Exact origins (scheme://host[:port]) the web app is served from. */
  readonly allowedOrigins: readonly string[];
  readonly clock: Clock;
  readonly onProblem?: ProblemObserver | undefined;
}

export function registerAuthRoutes(app: FastifyInstance, deps: AuthRouteDeps): void {
  void app.register((scope, _options, done) => {
    scope.setErrorHandler(createProblemHandler(deps.onProblem));
    scope.addHook('onRequest', (request, _reply, next) => {
      refuseForeignOrigin(request, deps.allowedOrigins);
      next();
    });

    scope.post(AUTH_LINK_PATH, async (request, reply) => {
      const email = stringMember(request.body, 'email', MAX_EMAIL_INPUT);
      await mapRefusal(
        deps.flows.requestLink(
          { email, userAgent: request.headers['user-agent'] },
          deps.clock.now(),
        ),
      );
      return reply.code(202).send({ status: 'sent' });
    });

    scope.post(AUTH_CONTINUE_PATH, async (request, reply) => {
      const token = stringMember(request.body, 'token', MAX_TOKEN_INPUT);
      const at = deps.clock.now();
      const started = await mapRefusal(
        deps.flows.continueLink({ token, userAgent: request.headers['user-agent'] }, at),
      );
      reply.header('set-cookie', sessionCookie(started.sessionToken, started.expiresAt, at));
      // `account_created` lets the web app open onboarding; the ids stay server-side.
      return reply.code(200).send({ account_created: started.accountCreated });
    });

    scope.post(AUTH_LOGOUT_PATH, async (request, reply) => {
      await deps.flows.signOut(readSessionCookie(request.headers.cookie), deps.clock.now());
      reply.header('set-cookie', clearedSessionCookie());
      return reply.code(204).send();
    });

    done();
  });
}

/**
 * C1's Origin validation, shared with the zones routes. Throws a 403 problem; called from
 * an `onRequest` hook, so the refusal lands before any body is parsed.
 */
export function refuseForeignOrigin(
  request: FastifyRequest,
  allowedOrigins: readonly string[],
): void {
  if (request.method === 'GET' || request.method === 'HEAD') return;
  // Typed `string | undefined` by Node: a repeated Origin header is not a thing browsers send.
  if (isAllowedOrigin(request.headers.origin, allowedOrigins)) return;
  throw new ProblemError(ORIGIN_REFUSED);
}

/** A string member of a JSON object body, or a 400. The value is never echoed back. */
export function stringMember(body: unknown, name: string, maxLength: number): string {
  const value =
    typeof body === 'object' && body !== null ? (body as Record<string, unknown>)[name] : undefined;
  if (typeof value !== 'string' || value.length > maxLength) {
    throw new ProblemError(INVALID_BODY);
  }
  return value;
}

/** The core's refusals as the wire states them. Exported for the code-coverage test. */
export const AUTH_REFUSALS: Readonly<
  Record<AuthRefusalCode, Omit<CodedProblemSpec, 'retryAfterSeconds'>>
> = {
  invalid_email: {
    status: 400,
    title: 'Invalid address',
    detail: 'That is not a valid e-mail address.',
    code: 'invalid_email',
  },
  rate_limited: {
    status: 429,
    title: 'Too many sign-in links',
    detail: 'Too many sign-in links were requested for this address. Try again later.',
    code: 'rate_limited',
  },
  unknown: {
    status: 400,
    title: 'Link not valid',
    detail: 'This sign-in link is not valid. Request a new one.',
    code: 'link_invalid',
  },
  expired: {
    status: 400,
    title: 'Link expired',
    detail: 'This sign-in link has expired. Request a new one.',
    code: 'link_expired',
  },
  used: {
    status: 400,
    title: 'Link already used',
    detail: 'This sign-in link was already used. Request a new one.',
    code: 'link_used',
  },
  superseded: {
    status: 400,
    title: 'Link replaced',
    detail: 'A newer sign-in link was sent to this address. Use the most recent one.',
    code: 'link_superseded',
  },
  other_browser: {
    status: 400,
    title: 'Different browser',
    detail: 'Open this sign-in link in the same browser you requested it from.',
    code: 'link_other_browser',
  },
};

async function mapRefusal<T>(work: Promise<T>): Promise<T> {
  try {
    return await work;
  } catch (error) {
    if (!(error instanceof AuthRefusal)) throw error;
    const spec = AUTH_REFUSALS[error.code];
    throw new ProblemError(
      error.retryAfterSeconds === undefined
        ? spec
        : { ...spec, retryAfterSeconds: error.retryAfterSeconds },
      { cause: error },
    );
  }
}

/** Re-issues or clears the session cookie; shared with the zones routes. */
export function setSessionCookie(
  reply: FastifyReply,
  session: { readonly token: string; readonly expiresAt: EpochMs } | null,
  at: EpochMs,
): void {
  reply.header(
    'set-cookie',
    session === null ? clearedSessionCookie() : sessionCookie(session.token, session.expiresAt, at),
  );
}
