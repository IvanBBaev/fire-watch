/**
 * `GET /api/v1/events/:publicId/lightning-context` — MTG-LI flashes near one event in the
 * hours before its first detection (TASKS F18; DATA-SOURCES §F18).
 *
 * **Context, never cause** (GLOSSARY §5.2). The body carries a count and a distance and
 * nothing that reads as an inference; the copy that renders it says LI misses some flashes.
 *
 * Three statuses, so "no lightning data" can never be read as "no lightning":
 *
 *   * `complete` — the window was fully covered by merged LI products: `flash_count`
 *     (possibly 0) and `nearest_km` (when any) describe the data;
 *   * `pending` — not answered yet, and the window is still inside the worker's nine-hour
 *     document, so an answer can still come;
 *   * `no_data` — the window was not covered (an outage, no credentials) or has aged out
 *     unanswered. No count is sent.
 *
 * A merged-away id answers with the survivor's context (the survivor holds the earliest
 * first detection); an id no event ever had is a 404. Headers follow the detections
 * route: the snapshot's `Cache-Control`, open CORS, a per-IP limit, an in-flight cap, an
 * ETag over what the answer depends on, and no query parameters.
 */

import type { FastifyInstance } from 'fastify';

import { PUBLIC_ID_RE } from '../../core/clustering/public-id.js';
import { LIGHTNING_CONTEXT } from '../../core/config/lightning-context.js';
import { createRateLimiter } from '../../core/http/rate-limiter.js';
import { LIGHTNING_DOCUMENT_RETENTION_MS } from '../../core/lightning/lightning-document.js';
import { isoFromEpochMs, type Clock } from '../../core/ports/clock.js';
import type {
  LightningContextRead,
  LightningContextReader,
} from '../../core/ports/lightning-context-store.js';
import type { SnapshotAttribution } from '../../core/snapshot/snapshot-builder.js';
import { clientKey } from './client-key.js';
import {
  DEFAULT_DETECTIONS_RATE_LIMIT,
  DEFAULT_DETECTIONS_RATE_LIMIT_WINDOW_MS,
  DEFAULT_MAX_IN_FLIGHT,
} from './event-detections-route.js';
import { lightningAttribution } from './lightning-overlay-route.js';
import { createProblemHandler, ProblemError, type ProblemObserver } from './problem.js';
import { SNAPSHOT_CACHE_CONTROL, matchesIfNoneMatch } from './snapshot-route.js';

export const EVENT_LIGHTNING_CONTEXT_PATH = '/api/v1/events/:publicId/lightning-context';

/** The web client's `lightningContextUrlTemplate` for this route; `{id}` is the public id. */
export const EVENT_LIGHTNING_CONTEXT_URL_TEMPLATE = '/api/v1/events/{id}/lightning-context';

export const EVENT_LIGHTNING_CONTEXT_SCHEMA_VERSION = 1;

const HOUR_MS = 3_600_000;
const OVERLOADED_RETRY_AFTER_SECONDS = 1;
const UNAVAILABLE_RETRY_AFTER_SECONDS = 5;

export interface EventLightningContextRouteDeps {
  readonly reader: LightningContextReader;
  readonly clock: Clock;
  readonly onProblem?: ProblemObserver | undefined;
  readonly maxInFlight?: number;
  readonly rateLimit?: { readonly limit: number; readonly windowMs: number };
  readonly clientIpHeader?: string | undefined;
}

export type EventLightningContextStatus = 'complete' | 'pending' | 'no_data';

export interface EventLightningContextDocument {
  readonly schema_version: number;
  readonly event_id: string;
  readonly status: EventLightningContextStatus;
  readonly radius_km: number;
  readonly window_hours: number;
  readonly window_from: string;
  readonly window_to: string;
  /** Present exactly when `complete`. */
  readonly flash_count?: number;
  /** Present only when at least one flash was counted. */
  readonly nearest_km?: number;
  readonly generated_at: string;
  /** The EUMETSAT credit when a count is shown; empty otherwise. */
  readonly attribution: readonly SnapshotAttribution[];
}

/** The answer for a read, as of `now`. Exported for the tests and the fixtures. */
export function lightningContextDocument(
  publicId: string,
  read: Extract<LightningContextRead, { kind: 'event' }>,
  now: number,
): EventLightningContextDocument {
  const row = read.row;
  if (row !== null && row.status === 'complete' && row.flashCount !== null) {
    return {
      schema_version: EVENT_LIGHTNING_CONTEXT_SCHEMA_VERSION,
      event_id: publicId,
      status: 'complete',
      radius_km: row.radiusKm,
      window_hours: Math.round((row.windowTo - row.windowFrom) / HOUR_MS),
      window_from: isoFromEpochMs(row.windowFrom),
      window_to: isoFromEpochMs(row.windowTo),
      flash_count: row.flashCount,
      ...(row.nearestKm === null ? {} : { nearest_km: row.nearestKm }),
      generated_at: isoFromEpochMs(now),
      attribution: lightningAttribution(isoFromEpochMs(row.windowTo)),
    };
  }
  const { radiusKm, windowHours } = LIGHTNING_CONTEXT.values;
  const windowTo = row?.windowTo ?? read.firstDetectedAt;
  const windowFrom = row?.windowFrom ?? windowTo - windowHours * HOUR_MS;
  const stillPossible = row === null && windowFrom > now - LIGHTNING_DOCUMENT_RETENTION_MS;
  return {
    schema_version: EVENT_LIGHTNING_CONTEXT_SCHEMA_VERSION,
    event_id: publicId,
    status: stillPossible ? 'pending' : 'no_data',
    radius_km: row?.radiusKm ?? radiusKm,
    window_hours: Math.round((windowTo - windowFrom) / HOUR_MS),
    window_from: isoFromEpochMs(windowFrom),
    window_to: isoFromEpochMs(windowTo),
    generated_at: isoFromEpochMs(now),
    attribution: [],
  };
}

/** What the answer depends on: the stored row (or its absence) and, while absent, the hour. */
export function lightningContextEtag(
  read: Extract<LightningContextRead, { kind: 'event' }>,
  status: EventLightningContextStatus,
): string {
  const v = String(EVENT_LIGHTNING_CONTEXT_SCHEMA_VERSION);
  if (read.row === null) return `"l${v}-${status}-${String(read.firstDetectedAt)}"`;
  return `"l${v}-${read.row.status}-${String(read.row.computedAt)}"`;
}

export function registerEventLightningContextRoute(
  app: FastifyInstance,
  deps: EventLightningContextRouteDeps,
): void {
  const maxInFlight = deps.maxInFlight ?? DEFAULT_MAX_IN_FLIGHT;
  const limiter = createRateLimiter({
    limit: deps.rateLimit?.limit ?? DEFAULT_DETECTIONS_RATE_LIMIT,
    windowMs: deps.rateLimit?.windowMs ?? DEFAULT_DETECTIONS_RATE_LIMIT_WINDOW_MS,
  });
  let inFlight = 0;

  void app.register((scope, _options, done) => {
    scope.setErrorHandler(createProblemHandler(deps.onProblem));
    scope.addHook('onRequest', (_request, reply, next) => {
      reply.header('access-control-allow-origin', '*');
      next();
    });

    scope.route({
      method: ['GET', 'HEAD'],
      url: EVENT_LIGHTNING_CONTEXT_PATH,
      handler: async (request, reply) => {
        const decision = limiter.check(clientKey(request, deps.clientIpHeader), deps.clock.now());
        if (!decision.allowed) {
          throw new ProblemError({
            status: 429,
            title: 'Too many requests',
            detail: 'Too many requests from this client; retry after the indicated delay.',
            code: 'rate_limited',
            retryAfterSeconds: decision.retryAfterSeconds,
          });
        }
        const query = request.query;
        if (typeof query === 'object' && query !== null && Object.keys(query).length > 0) {
          throw new ProblemError({
            status: 400,
            title: 'Invalid query',
            detail: 'This route takes no query parameters.',
          });
        }
        const publicId = (request.params as Record<string, unknown>)['publicId'];
        if (typeof publicId !== 'string' || !PUBLIC_ID_RE.test(publicId)) throw notFound();
        if (inFlight >= maxInFlight) {
          throw new ProblemError({
            status: 503,
            title: 'Lightning context temporarily unavailable',
            detail: 'The origin is shedding load; retry after the indicated delay.',
            retryAfterSeconds: OVERLOADED_RETRY_AFTER_SECONDS,
          });
        }

        inFlight += 1;
        try {
          const read = await deps.reader.readLightningContext(publicId);
          if (read.kind === 'unknown') throw notFound();
          const document = lightningContextDocument(publicId, read, deps.clock.now());
          const etag = lightningContextEtag(read, document.status);
          reply.header('etag', etag);
          reply.header('cache-control', SNAPSHOT_CACHE_CONTROL);
          if (matchesIfNoneMatch(request.headers['if-none-match'], etag)) {
            return await reply.code(304).send();
          }
          return await reply.type('application/json').send(document);
        } catch (error: unknown) {
          if (error instanceof ProblemError) throw error;
          throw new ProblemError(
            {
              status: 503,
              title: 'Lightning context temporarily unavailable',
              detail: "The event's lightning context could not be read; retry later.",
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

function notFound(): ProblemError {
  return new ProblemError({
    status: 404,
    title: 'Event not found',
    detail: 'No event has ever had this id.',
  });
}
