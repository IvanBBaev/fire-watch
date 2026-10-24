/**
 * `GET /api/v1/history?range=24h|3d|7d` — V2-A1 playback: the archived satellite hotspot
 * detections of the last day, three days or week, as the compact columnar document the
 * web scrubber replays (`core/history/history-frame.ts`).
 *
 * Headers follow the snapshot's reasoning (`snapshot-route.ts`):
 *
 *   * A content-addressed `ETag`: the document depends only on the aligned window and the
 *     rows (`generated_at` is the window's end), so its hash is its identity and a
 *     matching `If-None-Match` is a 304.
 *   * The snapshot's `Cache-Control`: the edge absorbs repeat reads within a window — and
 *     the window only moves every ten minutes — while the browser revalidates.
 *   * `Access-Control-Allow-Origin: *`, GET/HEAD only (ADR-003 CORS).
 *   * A per-IP limit, like every detection route (ADR-003): three cacheable URLs are all
 *     a scrubber needs, so a client asking for many more is not the product.
 *   * An aggregate in-flight cap, and a bounded body: the newest
 *     {@link DEFAULT_MAX_HISTORY_DETECTIONS} detections, flagged `truncated` past that.
 *
 * Anything but exactly one known `range` is refused with 400 `history_range_invalid`, so
 * a cache-buster cannot turn the three cacheable URLs into an origin hit per request.
 */

import { createHash } from 'node:crypto';

import type { FastifyInstance } from 'fastify';

import {
  buildHistoryDocument,
  DEFAULT_MAX_HISTORY_DETECTIONS,
  HISTORY_SCHEMA_VERSION,
  historyWindow,
  parseHistoryQuery,
} from '../../core/history/history-frame.js';
import { createRateLimiter } from '../../core/http/rate-limiter.js';
import type { Clock } from '../../core/ports/clock.js';
import type { HistoryReader } from '../../core/ports/history-reader.js';
import { attributionFor } from '../../core/snapshot/snapshot-builder.js';
import { clientKey } from './client-key.js';
import {
  createProblemHandler,
  ProblemError,
  type CodedProblemSpec,
  type ProblemObserver,
} from './problem.js';
import { SNAPSHOT_CACHE_CONTROL, matchesIfNoneMatch } from './snapshot-route.js';

/** Named because two places must agree on it: the route and the probe hook's exemption. */
export const HISTORY_PATH = '/api/v1/history';

/** Three ranges, a few reloads: generous for the scrubber, tight for a crawler. */
export const DEFAULT_HISTORY_RATE_LIMIT = 30;
export const DEFAULT_HISTORY_RATE_LIMIT_WINDOW_MS = 60_000;

/** A week is the heaviest read this process serves; a short queue, never a pile-up. */
export const DEFAULT_HISTORY_MAX_IN_FLIGHT = 2;

const OVERLOADED_RETRY_AFTER_SECONDS = 1;
const UNAVAILABLE_RETRY_AFTER_SECONDS = 5;

/** The one coded refusal this route owns; exported for the problem-code coverage test. */
export const HISTORY_RANGE_INVALID: CodedProblemSpec = {
  status: 400,
  title: 'Invalid history range',
  detail: 'This route takes exactly one parameter, range, set to 24h, 3d or 7d.',
  code: 'history_range_invalid',
};

export const HISTORY_RATE_LIMITED: Omit<CodedProblemSpec, 'retryAfterSeconds'> = {
  status: 429,
  title: 'Too many requests',
  detail: 'Too many requests from this client; retry after the indicated delay.',
  code: 'rate_limited',
};

export const HISTORY_PROBLEMS: readonly CodedProblemSpec[] = [
  HISTORY_RANGE_INVALID,
  HISTORY_RATE_LIMITED,
];

export interface HistoryRouteDeps {
  readonly reader: HistoryReader;
  readonly clock: Clock;
  readonly onProblem?: ProblemObserver | undefined;
  readonly maxDetections?: number;
  readonly maxInFlight?: number;
  readonly rateLimit?: { readonly limit: number; readonly windowMs: number };
  /** The edge-owned client-IP header; see `HealthServerDeps.clientIpHeader`. */
  readonly clientIpHeader?: string | undefined;
}

export function registerHistoryRoute(app: FastifyInstance, deps: HistoryRouteDeps): void {
  const maxInFlight = deps.maxInFlight ?? DEFAULT_HISTORY_MAX_IN_FLIGHT;
  const maxDetections = deps.maxDetections ?? DEFAULT_MAX_HISTORY_DETECTIONS;
  const limiter = createRateLimiter({
    limit: deps.rateLimit?.limit ?? DEFAULT_HISTORY_RATE_LIMIT,
    windowMs: deps.rateLimit?.windowMs ?? DEFAULT_HISTORY_RATE_LIMIT_WINDOW_MS,
  });
  let inFlight = 0;

  void app.register((scope, _options, done) => {
    scope.setErrorHandler(createProblemHandler(deps.onProblem));
    // On every reply of this scope, refusals included — see the snapshot route.
    scope.addHook('onRequest', (_request, reply, next) => {
      reply.header('access-control-allow-origin', '*');
      next();
    });

    scope.route({
      method: ['GET', 'HEAD'],
      url: HISTORY_PATH,
      handler: async (request, reply) => {
        const decision = limiter.check(clientKey(request, deps.clientIpHeader), deps.clock.now());
        if (!decision.allowed) {
          throw new ProblemError({
            ...HISTORY_RATE_LIMITED,
            retryAfterSeconds: decision.retryAfterSeconds,
          });
        }
        const query = parseHistoryQuery(request.query);
        if (!query.ok) throw new ProblemError(HISTORY_RANGE_INVALID);

        if (inFlight >= maxInFlight) {
          throw new ProblemError({
            status: 503,
            title: 'History temporarily unavailable',
            detail: 'The origin is shedding load; retry after the indicated delay.',
            retryAfterSeconds: OVERLOADED_RETRY_AFTER_SECONDS,
          });
        }

        const window = historyWindow(query.range, deps.clock.now());
        inFlight += 1;
        let rows;
        try {
          // One row past the bound tells "exactly the bound" from "more than the bound".
          rows = await deps.reader.readHistory(window.fromMs, window.toMs, maxDetections + 1);
        } catch (error: unknown) {
          // The driver's message quotes connection strings; it goes no further than the log.
          throw new ProblemError(
            {
              status: 503,
              title: 'History temporarily unavailable',
              detail: 'The detection history could not be read; retry after the indicated delay.',
              retryAfterSeconds: UNAVAILABLE_RETRY_AFTER_SECONDS,
            },
            { cause: error },
          );
        } finally {
          inFlight -= 1;
        }

        const document = buildHistoryDocument({
          window,
          rows,
          maxDetections,
          attribution: attributionFor(window.toMs),
        });
        const body = JSON.stringify(document);
        const etag = historyEtag(body);
        reply.header('etag', etag);
        reply.header('cache-control', SNAPSHOT_CACHE_CONTROL);
        reply.header('x-content-type-options', 'nosniff');
        if (matchesIfNoneMatch(request.headers['if-none-match'], etag)) {
          return reply.code(304).send();
        }
        return reply.type('application/json').send(body);
      },
    });
    done();
  });
}

/** The content address of one serialised history document. */
export function historyEtag(body: string): string {
  const digest = createHash('sha256').update(body).digest('hex').slice(0, 32);
  return `"h${String(HISTORY_SCHEMA_VERSION)}-${digest}"`;
}
