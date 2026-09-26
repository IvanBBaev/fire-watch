/**
 * `GET /snapshot.json` — T1, the read path everyone gets by default (ADR-003 D1, A1.3,
 * A1.4 as amended by A15).
 *
 * The route is an edge-cache artefact first and an API second, and every header it sets
 * follows from that:
 *
 *   * `ETag` is derived from the registry's global max `seq`, nothing else. The seq
 *     discipline (migration 004) guarantees that any change to the active *set* — an
 *     event entering, leaving, merging, being invalidated — bumps that mark, so an
 *     unchanged tag means an unchanged set, and a matching `If-None-Match` is a 304 before
 *     a byte of GeoJSON is built. R1: an event leaving the set always changes the tag.
 *   * `Cache-Control: public, max-age=0, s-maxage=30, stale-while-revalidate=60` — the D1
 *     rule for the shared cache, verbatim, with `max-age=0` so a browser revalidates on
 *     every poll instead of serving its own stale copy. (The web client sends
 *     `If-None-Match`, which the Fetch standard turns into a cache bypass anyway; the
 *     directive is for consumers that do not.)
 *   * No per-IP throttle (A1.3): the cache rule is the protection, and throttling the
 *     default tier during the spike it exists for would defeat it. What the origin does
 *     keep is an aggregate in-flight cap, so a cold cache and a burst cannot stack
 *     requests behind the pool — everything past the cap is a `503 + Retry-After`, which
 *     A1.2 clients treat as the cue to fall back to T2.
 *   * `Access-Control-Allow-Origin: *`, GET/HEAD only, no credentials: the data is public
 *     and third-party embeds are a product goal. Constant, so no `Vary: Origin`.
 *   * `?updated_after_seq=N` returns only rows above the cursor, flagged `partial`, under
 *     the *global* mark — so the tag a cursor client stores is the same tag a full client
 *     stores and the next poll's 304 arithmetic is identical. Any other query parameter
 *     is refused: the set of URLs an edge may cache is the path times one integer, and a
 *     cache-busting `?_=…` from a careless consumer must not become an origin hit per
 *     request.
 *
 * Refusals are RFC 7807 via {@link createProblemHandler}, registered on this route's own
 * encapsulated scope so the probe surface's older, fixed-vocabulary bodies stay untouched.
 * The route never builds an error body itself.
 */

import type { FastifyInstance } from 'fastify';

import type { Clock } from '../../core/ports/clock.js';
import type { SnapshotReader } from '../../core/ports/snapshot-reader.js';
import { buildSnapshot, snapshotEtag } from '../../core/snapshot/snapshot-builder.js';
import { createProblemHandler, ProblemError, type ProblemObserver } from './problem.js';

/** Named because two places must agree on it: the route and the probe hook's exemption. */
export const SNAPSHOT_PATH = '/snapshot.json';

/** The one query parameter the route understands (ADR-003 D1). */
export const CURSOR_PARAM = 'updated_after_seq';

/** ADR-003 D1's shared-cache rule, plus the browser directive the module comment explains. */
export const SNAPSHOT_CACHE_CONTROL = 'public, max-age=0, s-maxage=30, stale-while-revalidate=60';

/**
 * Concurrent requests allowed to hold, or wait for, a database connection. Above the
 * pool's size on purpose: a short queue absorbs the jitter of a cache refresh, while a
 * long one is how a slow query turns into a socket pile-up.
 */
export const DEFAULT_MAX_IN_FLIGHT = 8;

/** Long enough for a stampede to thin out, short enough that a client stays on T1. */
const OVERLOADED_RETRY_AFTER_SECONDS = 1;

/** A database that cannot answer needs more than a second; five is one poll jitter. */
const UNAVAILABLE_RETRY_AFTER_SECONDS = 5;

export interface SnapshotRouteDeps {
  readonly reader: SnapshotReader;
  readonly clock: Clock;
  /** The registry rows the `sources[]` member reports, in this order. */
  readonly sources: readonly string[];
  /** Receives every refusal's correlation id; the caller owns the log line. */
  readonly onProblem?: ProblemObserver | undefined;
  readonly maxInFlight?: number;
}

export function registerSnapshotRoute(app: FastifyInstance, deps: SnapshotRouteDeps): void {
  const maxInFlight = deps.maxInFlight ?? DEFAULT_MAX_IN_FLIGHT;
  let inFlight = 0;

  void app.register((scope, _options, done) => {
    scope.setErrorHandler(createProblemHandler(deps.onProblem));
    // On every reply of this scope, refusals included: a browser that cannot read a 503's
    // `Retry-After` because the CORS header went missing sees a network error instead of
    // the status it was supposed to key off.
    scope.addHook('onRequest', (_request, reply, next) => {
      reply.header('access-control-allow-origin', '*');
      next();
    });

    scope.route({
      method: ['GET', 'HEAD'],
      url: SNAPSHOT_PATH,
      handler: async (request, reply) => {
        const afterSeq = cursorFrom(request.query);

        if (inFlight >= maxInFlight) {
          throw new ProblemError({
            status: 503,
            title: 'Snapshot temporarily unavailable',
            detail: 'The origin is shedding load; retry after the indicated delay.',
            retryAfterSeconds: OVERLOADED_RETRY_AFTER_SECONDS,
          });
        }

        inFlight += 1;
        try {
          const read = await deps.reader.readActiveSet(afterSeq);
          const etag = snapshotEtag(read.maxSeq);
          reply.header('etag', etag);
          reply.header('cache-control', SNAPSHOT_CACHE_CONTROL);
          if (matchesIfNoneMatch(request.headers['if-none-match'], etag)) {
            // Before the sources query: a 304 is the common case for a polling client,
            // and the point of it is to cost as little as the tag comparison.
            return await reply.code(304).send();
          }
          const sources = await deps.reader.readSourceObservations(deps.sources);
          const document = buildSnapshot({
            read,
            sources,
            generatedAtMs: deps.clock.now(),
            afterSeq,
          });
          return await reply.type('application/json').send(document);
        } catch (error: unknown) {
          if (error instanceof ProblemError) throw error;
          // The driver's message quotes connection strings; nothing from it goes further
          // than the log line, and the client learns only that it should wait.
          throw new ProblemError(
            {
              status: 503,
              title: 'Snapshot temporarily unavailable',
              detail: 'The active-event set could not be read; retry after the indicated delay.',
              retryAfterSeconds: UNAVAILABLE_RETRY_AFTER_SECONDS,
            },
            { cause: error },
          );
        } finally {
          inFlight -= 1;
        }
      },
    });
    done();
  });
}

/**
 * The cursor, or 0 when absent. Anything that is not exactly one non-negative safe
 * integer under the one known name is a 400: the reader would reject a bad cursor too,
 * but that would be a 503 wearing a client fault's clothes.
 */
function cursorFrom(query: unknown): number {
  if (typeof query !== 'object' || query === null) return 0;
  let afterSeq = 0;
  for (const [name, value] of Object.entries(query as Record<string, unknown>)) {
    if (name !== CURSOR_PARAM) throw badCursor(`unknown query parameter`);
    if (typeof value !== 'string' || !/^\d{1,16}$/.test(value)) {
      throw badCursor(`${CURSOR_PARAM} must be a single non-negative integer`);
    }
    afterSeq = Number(value);
    if (!Number.isSafeInteger(afterSeq)) throw badCursor(`${CURSOR_PARAM} is out of range`);
  }
  return afterSeq;
}

function badCursor(detail: string): ProblemError {
  return new ProblemError({ status: 400, title: 'Invalid query', detail });
}

/**
 * RFC 9110 §13.1.2: weak comparison, so `W/"v1-42"` matches `"v1-42"`; a list matches if
 * any member does; `*` matches whatever exists. The header is text the sender wrote, so
 * it is parsed and compared, never echoed.
 */
function matchesIfNoneMatch(header: string | string[] | undefined, etag: string): boolean {
  if (header === undefined) return false;
  const raw = Array.isArray(header) ? header.join(',') : header;
  const opaque = etag.replace(/^W\//, '');
  return raw.split(',').some((candidate) => {
    const trimmed = candidate.trim();
    return trimmed === '*' || trimmed.replace(/^W\//, '') === opaque;
  });
}
