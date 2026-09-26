/**
 * RFC 7807 — the one shape every refusal on the public API takes (ADR-003 A1.3).
 *
 * A1.3 pins four things, and this module is where each of them is enforced once:
 *
 *   * **One handler.** No route emits an ad-hoc error body. A route that wants a specific
 *     status throws a {@link ProblemError}; everything else it lets escape, and the handler
 *     built by {@link createProblemHandler} turns both into the same document.
 *   * **The members.** `type` (`about:blank` — nothing here has a page to document it yet),
 *     `title`, `status`, `detail`, `instance`, plus `correlation_id`, which is also handed
 *     to the log line so an operator can go from a user's screenshot to the stack trace,
 *     and — where the route gives one — `code`, the machine-readable refusal a client
 *     switches on (`PROBLEM_CODES` in `@fire-watch/contracts`; the title is prose and may
 *     be reworded). Every account-surface route gives one ({@link CodedProblemSpec}); the
 *     two fallbacks below always do.
 *   * **`detail` is public text.** Titles and details come only from literals in this
 *     package, never from an error's message: a driver quotes connection strings, a fetch
 *     quotes the upstream URL, and either would be a credential in a 503 body.
 *   * **`instance` is the route pattern**, not the request URL — the URL is text the sender
 *     wrote, and reflecting it is how a problem body becomes a phishing canvas.
 *
 * Refusals are never cacheable: an edge that kept a 503 for thirty seconds would extend an
 * outage by exactly that long after the origin recovered.
 */

import { randomUUID } from 'node:crypto';
import type { ProblemCode } from '@fire-watch/contracts';
import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';

export const PROBLEM_CONTENT_TYPE = 'application/problem+json';

/** What a route decides; the handler adds the members it alone can fill in. */
export interface ProblemSpec {
  readonly status: number;
  readonly title: string;
  readonly detail: string;
  /**
   * The `code` extension member. Optional here because the public data routes are
   * status-driven (A1.3) and carry none; the account surface types its refusals as
   * {@link CodedProblemSpec}, where it is required.
   */
  readonly code?: ProblemCode;
  /** Sent as `Retry-After` — the one header a client is allowed to key its behaviour off. */
  readonly retryAfterSeconds?: number;
}

/** A refusal with its machine-readable code — every account-surface route's kind. */
export type CodedProblemSpec = ProblemSpec & { readonly code: ProblemCode };

/** The wire document. `correlation_id` is the extension member A1.3 asks for. */
export interface ProblemDocument {
  readonly type: 'about:blank';
  readonly title: string;
  readonly status: number;
  readonly detail: string;
  readonly instance: string;
  readonly correlation_id: string;
  /** Present exactly when the spec carried one. */
  readonly code?: ProblemCode;
}

/**
 * Thrown by a route that knows which refusal it wants. `cause` carries the underlying
 * failure for the log line only; nothing from it reaches the body.
 */
export class ProblemError extends Error {
  readonly problem: ProblemSpec;

  constructor(problem: ProblemSpec, options?: { readonly cause?: unknown }) {
    super(problem.title, options);
    this.name = 'ProblemError';
    this.problem = problem;
  }
}

/** What the log line gets — the same correlation id the client was shown. */
export interface ProblemLogEntry {
  readonly correlationId: string;
  readonly status: number;
  readonly instance: string;
  /** The original failure, for the operator. The caller's logger redacts it. */
  readonly error: unknown;
}

export type ProblemObserver = (entry: ProblemLogEntry) => void;

/**
 * A client fault keeps its own 4xx status — a 5xx-alerting monitor must not page for
 * something a caller did — but the words are ours, not Fastify's, whose messages quote
 * the offending input.
 */
const CLIENT_FAULT: Omit<CodedProblemSpec, 'status'> = {
  title: 'Request refused',
  detail: 'The request could not be processed as sent.',
  code: 'request_refused',
};

const INTERNAL: CodedProblemSpec = {
  status: 500,
  title: 'Internal error',
  detail: 'The request could not be completed.',
  code: 'internal_error',
};

/** The handler's own refusals, exported so the code-coverage test can see them. */
export const FALLBACK_PROBLEMS: readonly CodedProblemSpec[] = [
  { ...CLIENT_FAULT, status: 400 },
  INTERNAL,
];

/**
 * The single error handler. Register it on the scope whose routes speak problem+json;
 * the probe surface keeps its own, older vocabulary (OPERATIONS §2.2), and the two must
 * not be merged until that contract is versioned.
 */
export function createProblemHandler(
  observe: ProblemObserver | undefined,
): (error: FastifyError, request: FastifyRequest, reply: FastifyReply) => FastifyReply {
  return (error, request, reply) => {
    const spec = specFor(error);
    const correlationId = randomUUID();
    // The matched pattern; a request that matched nothing does not reach this handler.
    const instance = request.routeOptions.url ?? '';
    observe?.({ correlationId, status: spec.status, instance, error });
    return sendProblem(reply, spec, { correlationId, instance });
  };
}

/** Writes a problem document. Exposed for the rare reply that is not an error path. */
export function sendProblem(
  reply: FastifyReply,
  spec: ProblemSpec,
  identity: { readonly correlationId: string; readonly instance: string },
): FastifyReply {
  const document: ProblemDocument = {
    type: 'about:blank',
    title: spec.title,
    status: spec.status,
    detail: spec.detail,
    instance: identity.instance,
    correlation_id: identity.correlationId,
    ...(spec.code === undefined ? {} : { code: spec.code }),
  };
  reply.header('cache-control', 'no-store');
  reply.header('cdn-cache-control', 'no-store');
  reply.header('cloudflare-cdn-cache-control', 'no-store');
  if (spec.retryAfterSeconds !== undefined) {
    reply.header('retry-after', String(spec.retryAfterSeconds));
  }
  return reply.code(spec.status).type(PROBLEM_CONTENT_TYPE).send(document);
}

/**
 * Takes `unknown` in spirit: Fastify types the argument as `FastifyError`, but a route can
 * throw anything, so the status code is read structurally and nothing else is trusted.
 */
function specFor(error: unknown): ProblemSpec {
  if (error instanceof ProblemError) return error.problem;
  const statusCode =
    typeof error === 'object' && error !== null && 'statusCode' in error
      ? (error as { statusCode?: unknown }).statusCode
      : undefined;
  if (typeof statusCode === 'number' && statusCode >= 400 && statusCode < 500) {
    return { ...CLIENT_FAULT, status: statusCode };
  }
  return INTERNAL;
}
