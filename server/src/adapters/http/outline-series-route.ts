/**
 * `GET /api/v1/events/:publicId/outline-series` — one event's estimated outline over time
 * (V3-P3): area band, edge uncertainty and centroid after each satellite observation, the
 * series V3-B1 and V3-B2 read. The document's shape is `@fire-watch/contracts`'
 * `OutlineSeriesDocument`; the series itself is `core/outlines/series.ts`.
 *
 * A sub-resource of the event permalink, built on the detections route's read
 * (`EventDetectionsReader`), so it follows the same rules: a public id resolves forever, a
 * merge tombstone answers **200** with `merged_into` and no points, only an id that never
 * existed is a 404. Nothing is stored: migration 032 keeps the latest outline only, so the
 * series is drawn from the live member detections on request.
 *
 * Headers follow the detections route: open CORS, GET/HEAD, the snapshot's
 * `Cache-Control`, a per-IP limit, unknown query parameters refused, and an ETag from the
 * event's `seq` (an attached detection bumps it) plus the outline parameters' version, so
 * a matching `If-None-Match` is a 304 before anything is drawn. Drawing is CPU work, so
 * the in-flight cap is lower than the detections route's.
 */

import type { FastifyInstance } from 'fastify';

import {
  OUTLINE_SERIES_SCHEMA_VERSION,
  type OutlineSeriesDocument,
  type OutlineSeriesPointWire,
} from '@fire-watch/contracts';

import { PUBLIC_ID_RE } from '../../core/clustering/public-id.js';
import type { FireOutlineValues } from '../../core/config/fire-outline.js';
import type { VersionedConfig } from '../../core/config/versioned-config.js';
import { createRateLimiter } from '../../core/http/rate-limiter.js';
import {
  DEFAULT_OUTLINE_SERIES_OPTIONS,
  buildOutlineSeries,
  type OutlineSeries,
  type OutlineSeriesOptions,
  type OutlineSeriesPoint,
} from '../../core/outlines/series.js';
import { isoFromEpochMs, type Clock, type EpochMs } from '../../core/ports/clock.js';
import type { EventDetectionsReader } from '../../core/ports/event-detections-reader.js';
import { clientKey } from './client-key.js';
import { fireOutlineAttribution } from './fire-outline-overlay-route.js';
import { createProblemHandler, ProblemError, type ProblemObserver } from './problem.js';
import { SNAPSHOT_CACHE_CONTROL, matchesIfNoneMatch } from './snapshot-route.js';

/** Named because two places must agree on it: the route and the probe hook's exemption. */
export const OUTLINE_SERIES_PATH = '/api/v1/events/:publicId/outline-series';

/** The detections route's budget: the product's own use is one read per event page. */
export const DEFAULT_OUTLINE_SERIES_RATE_LIMIT = 120;
export const DEFAULT_OUTLINE_SERIES_RATE_LIMIT_WINDOW_MS = 60_000;
/** Each request draws up to `maxPoints` outlines; two at a time keep the loop responsive. */
export const DEFAULT_OUTLINE_SERIES_MAX_IN_FLIGHT = 2;

const OVERLOADED_RETRY_AFTER_SECONDS = 1;
const UNAVAILABLE_RETRY_AFTER_SECONDS = 5;

export interface OutlineSeriesRouteDeps {
  readonly reader: EventDetectionsReader;
  readonly clock: Clock;
  /** The outline loop's parameters: the last point is then the stored outline. */
  readonly params: VersionedConfig<FireOutlineValues>;
  readonly series?: OutlineSeriesOptions;
  readonly maxInFlight?: number;
  readonly onProblem?: ProblemObserver | undefined;
  readonly rateLimit?: { readonly limit: number; readonly windowMs: number };
  readonly clientIpHeader?: string | undefined;
}

export function registerOutlineSeriesRoute(
  app: FastifyInstance,
  deps: OutlineSeriesRouteDeps,
): void {
  const maxInFlight = deps.maxInFlight ?? DEFAULT_OUTLINE_SERIES_MAX_IN_FLIGHT;
  const options = deps.series ?? DEFAULT_OUTLINE_SERIES_OPTIONS;
  const limiter = createRateLimiter({
    limit: deps.rateLimit?.limit ?? DEFAULT_OUTLINE_SERIES_RATE_LIMIT,
    windowMs: deps.rateLimit?.windowMs ?? DEFAULT_OUTLINE_SERIES_RATE_LIMIT_WINDOW_MS,
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
      url: OUTLINE_SERIES_PATH,
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
        refuseQuery(request.query);
        const publicId = (request.params as Record<string, unknown>)['publicId'];
        if (typeof publicId !== 'string' || !PUBLIC_ID_RE.test(publicId)) throw notFound();

        if (inFlight >= maxInFlight) {
          throw new ProblemError({
            status: 503,
            title: 'Outline series temporarily unavailable',
            detail: 'The origin is shedding load; retry after the indicated delay.',
            retryAfterSeconds: OVERLOADED_RETRY_AFTER_SECONDS,
          });
        }

        inFlight += 1;
        try {
          const read = await deps.reader.readEventDetections(
            publicId,
            deps.params.values.maxDetections,
          );
          if (read.kind === 'unknown') throw notFound();
          const etag =
            read.kind === 'merged'
              ? outlineSeriesEtag(deps.params.version, read.seq, read.survivorSeq)
              : outlineSeriesEtag(deps.params.version, read.seq);
          reply.header('etag', etag);
          reply.header('cache-control', SNAPSHOT_CACHE_CONTROL);
          if (matchesIfNoneMatch(request.headers['if-none-match'], etag)) {
            return await reply.code(304).send();
          }
          const series: OutlineSeries =
            read.kind === 'event'
              ? buildOutlineSeries(read.detections, deps.params.values, options)
              : { points: [], thinned: false };
          const document = outlineSeriesDocument({
            eventId: publicId,
            mergedInto: read.kind === 'merged' ? read.survivorPublicId : null,
            paramsVersion: deps.params.version,
            generatedAt: deps.clock.now(),
            truncated: read.kind === 'event' && read.truncated,
            series,
          });
          return await reply.type('application/json').send(document);
        } catch (error: unknown) {
          if (error instanceof ProblemError) throw error;
          throw new ProblemError(
            {
              status: 503,
              title: 'Outline series temporarily unavailable',
              detail: "The event's outline series could not be read; retry later.",
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

export interface OutlineSeriesDocumentInput {
  readonly eventId: string;
  readonly mergedInto: string | null;
  readonly paramsVersion: string;
  readonly generatedAt: EpochMs;
  readonly truncated: boolean;
  readonly series: OutlineSeries;
}

/** The body. Exported for the tests and the web fixtures, which are built with it. */
export function outlineSeriesDocument(input: OutlineSeriesDocumentInput): OutlineSeriesDocument {
  return {
    schema_version: OUTLINE_SERIES_SCHEMA_VERSION,
    kind: 'estimated_outline_series',
    event_id: input.eventId,
    merged_into: input.mergedInto,
    params_version: input.paramsVersion,
    generated_at: isoFromEpochMs(input.generatedAt),
    truncated: input.truncated,
    thinned: input.series.thinned,
    points: input.series.points.map(pointWire),
    attribution: fireOutlineAttribution(input.generatedAt),
  };
}

/** Schema version, outline parameters and the seq(s) the answer depends on. */
export function outlineSeriesEtag(
  paramsVersion: string,
  seq: number,
  survivorSeq?: number,
): string {
  for (const value of survivorSeq === undefined ? [seq] : [seq, survivorSeq]) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new RangeError(`seq must be a non-negative safe integer, got ${String(value)}`);
    }
  }
  const tail = survivorSeq === undefined ? '' : `-${String(survivorSeq)}`;
  return `"s${String(OUTLINE_SERIES_SCHEMA_VERSION)}-${paramsVersion}-${String(seq)}${tail}"`;
}

function pointWire(point: OutlineSeriesPoint): OutlineSeriesPointWire {
  return {
    at: isoFromEpochMs(point.at),
    area_ha: point.areaHa,
    area_low_ha: point.areaLowHa,
    area_high_ha: point.areaHighHa,
    edge_uncertainty_km: point.edgeUncertaintyKm,
    footprints: point.footprints,
    centroid: [point.centroid.lon, point.centroid.lat],
  };
}

function refuseQuery(query: unknown): void {
  if (typeof query !== 'object' || query === null) return;
  if (Object.keys(query).length > 0) {
    throw new ProblemError({
      status: 400,
      title: 'Invalid query',
      detail: 'This route takes no query parameters.',
    });
  }
}

function notFound(): ProblemError {
  return new ProblemError({
    status: 404,
    title: 'Event not found',
    detail: 'No event has ever had this id.',
  });
}
