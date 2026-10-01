/**
 * `GET /api/v1/events/:publicId/detections` — the member detections of one event, as the
 * GeoJSON the web client's detection layer and detail panel already parse (the fixture
 * files under `web/public/fixtures/detections/` are the same shape).
 *
 * A sub-resource of the event permalink, so it follows the permalink's rules (ADR-002 I1,
 * D3): a public id resolves forever. A merge tombstone answers **200** with `merged_into`
 * naming the final survivor and no features — never a 404, and never the survivor's
 * detections under the tombstone's id, which a cache would then keep serving under a URL
 * that no longer describes them. Only an id that never existed is a 404.
 *
 * Headers follow the snapshot's reasoning (`snapshot-route.ts`), with one difference:
 *
 *   * `ETag` from the event's own `seq` (a tombstone's: its seq and the survivor's). An
 *     attached detection bumps the event's seq (migration 004), so an unchanged tag means
 *     an unchanged member list and a matching `If-None-Match` is a 304 before the member
 *     query runs.
 *   * The same `Cache-Control` as the snapshot: the edge absorbs repeat reads, the
 *     browser revalidates.
 *   * `Access-Control-Allow-Origin: *`, GET/HEAD only (ADR-003 CORS).
 *   * **A per-IP limit**, which the snapshot deliberately has not: every distinct event id
 *     is its own cache key, so a script walking ids is an origin query per request, and
 *     ADR-003 puts detection routes under "materially harder per-IP limits". It is set
 *     for the product's own use — a map at footprint zoom fetches each event in frame
 *     once and caches it — not for bulk export. `429 + Retry-After`, problem+json.
 *   * An aggregate in-flight cap, as on the snapshot, and a bounded body: the newest
 *     {@link DEFAULT_MAX_DETECTIONS} members, flagged `truncated` when there are more.
 *
 * Unknown query parameters are refused (400), so a cache-buster cannot turn one cacheable
 * URL into an origin hit per request.
 */

import type { FastifyInstance } from 'fastify';

import { PUBLIC_ID_RE } from '../../core/clustering/public-id.js';
import { createRateLimiter } from '../../core/http/rate-limiter.js';
import { isoFromEpochMs, type Clock } from '../../core/ports/clock.js';
import type {
  EventDetectionRow,
  EventDetectionsReader,
} from '../../core/ports/event-detections-reader.js';
import { attributionFor, type SnapshotAttribution } from '../../core/snapshot/snapshot-builder.js';
import { clientKey } from './client-key.js';
import { createProblemHandler, ProblemError, type ProblemObserver } from './problem.js';
import { SNAPSHOT_CACHE_CONTROL, matchesIfNoneMatch } from './snapshot-route.js';

/** Named because two places must agree on it: the route and the probe hook's exemption. */
export const EVENT_DETECTIONS_PATH = '/api/v1/events/:publicId/detections';

/** The web client's `detectionsUrlTemplate` for this route; `{id}` is the public id. */
export const EVENT_DETECTIONS_URL_TEMPLATE = '/api/v1/events/{id}/detections';

/** Bumped when the document's shape changes incompatibly; part of the ETag. */
export const EVENT_DETECTIONS_SCHEMA_VERSION = 1;

/**
 * The body bound. A large multi-day fire runs to hundreds of VIIRS pixels; a thousand
 * points is about 200 KB of JSON, and the newest ones are the ones a reader wants.
 */
export const DEFAULT_MAX_DETECTIONS = 1000;

/** See the module comment: a map pans through a few dozen events; a crawler walks all. */
export const DEFAULT_DETECTIONS_RATE_LIMIT = 120;
export const DEFAULT_DETECTIONS_RATE_LIMIT_WINDOW_MS = 60_000;

/** Same reasoning as the snapshot's cap: a short queue, never a socket pile-up. */
export const DEFAULT_MAX_IN_FLIGHT = 4;

const OVERLOADED_RETRY_AFTER_SECONDS = 1;
const UNAVAILABLE_RETRY_AFTER_SECONDS = 5;

export interface EventDetectionsRouteDeps {
  readonly reader: EventDetectionsReader;
  readonly clock: Clock;
  readonly onProblem?: ProblemObserver | undefined;
  readonly maxDetections?: number;
  readonly maxInFlight?: number;
  readonly rateLimit?: { readonly limit: number; readonly windowMs: number };
  /** The edge-owned client-IP header; see `HealthServerDeps.clientIpHeader`. */
  readonly clientIpHeader?: string | undefined;
}

export interface DetectionFeature {
  readonly type: 'Feature';
  readonly geometry: { readonly type: 'Point'; readonly coordinates: readonly [number, number] };
  readonly properties: {
    readonly uid: string;
    readonly observed_at: string;
    readonly source_id: string;
    readonly confidence: EventDetectionRow['confidence'];
    readonly scan_km?: number;
    readonly track_km?: number;
    readonly frp_mw?: number;
  };
}

export interface EventDetectionsDocument {
  readonly type: 'FeatureCollection';
  readonly schema_version: number;
  /** The id the request named. For a tombstone, not the survivor's. */
  readonly event_id: string;
  /** The final survivor's public id for a merge tombstone, `null` otherwise. */
  readonly merged_into: string | null;
  readonly generated_at: string;
  /** True when older members were left out to keep the body bounded. */
  readonly truncated: boolean;
  readonly features: readonly DetectionFeature[];
  readonly attribution: readonly SnapshotAttribution[];
}

export function registerEventDetectionsRoute(
  app: FastifyInstance,
  deps: EventDetectionsRouteDeps,
): void {
  const maxInFlight = deps.maxInFlight ?? DEFAULT_MAX_IN_FLIGHT;
  const maxDetections = deps.maxDetections ?? DEFAULT_MAX_DETECTIONS;
  const limiter = createRateLimiter({
    limit: deps.rateLimit?.limit ?? DEFAULT_DETECTIONS_RATE_LIMIT,
    windowMs: deps.rateLimit?.windowMs ?? DEFAULT_DETECTIONS_RATE_LIMIT_WINDOW_MS,
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
      url: EVENT_DETECTIONS_PATH,
      handler: async (request, reply) => {
        // Charged before anything else, so malformed and unknown ids cost the same as
        // real ones: a walk over the id space is exactly what the limit is for.
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
        if (typeof publicId !== 'string' || !PUBLIC_ID_RE.test(publicId)) {
          // Cannot name an event, so it is one no event ever had: the database is not asked.
          throw notFound();
        }

        if (inFlight >= maxInFlight) {
          throw new ProblemError({
            status: 503,
            title: 'Detections temporarily unavailable',
            detail: 'The origin is shedding load; retry after the indicated delay.',
            retryAfterSeconds: OVERLOADED_RETRY_AFTER_SECONDS,
          });
        }

        inFlight += 1;
        try {
          const read = await deps.reader.readEventDetections(publicId, maxDetections);
          if (read.kind === 'unknown') throw notFound();
          const etag =
            read.kind === 'merged'
              ? eventDetectionsEtag(read.seq, read.survivorSeq)
              : eventDetectionsEtag(read.seq);
          reply.header('etag', etag);
          reply.header('cache-control', SNAPSHOT_CACHE_CONTROL);
          if (matchesIfNoneMatch(request.headers['if-none-match'], etag)) {
            return await reply.code(304).send();
          }
          const generatedAtMs = deps.clock.now();
          const document: EventDetectionsDocument = {
            type: 'FeatureCollection',
            schema_version: EVENT_DETECTIONS_SCHEMA_VERSION,
            event_id: publicId,
            merged_into: read.kind === 'merged' ? read.survivorPublicId : null,
            generated_at: isoFromEpochMs(generatedAtMs),
            truncated: read.kind === 'event' && read.truncated,
            features: read.kind === 'event' ? read.detections.map(detectionFeature) : [],
            attribution: attributionFor(generatedAtMs),
          };
          return await reply.type('application/json').send(document);
        } catch (error: unknown) {
          if (error instanceof ProblemError) throw error;
          // The driver's message quotes connection strings; it goes no further than the log.
          throw new ProblemError(
            {
              status: 503,
              title: 'Detections temporarily unavailable',
              detail: "The event's detections could not be read; retry after the indicated delay.",
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
 * The validator: schema version and the seq(s) the answer depends on. A tombstone's answer
 * names the final survivor, which changes if the survivor is merged in turn — that bumps
 * the survivor's seq, so both are in the tag.
 */
export function eventDetectionsEtag(seq: number, survivorSeq?: number): string {
  for (const value of survivorSeq === undefined ? [seq] : [seq, survivorSeq]) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new RangeError(`seq must be a non-negative safe integer, got ${String(value)}`);
    }
  }
  const tail = survivorSeq === undefined ? '' : `-${String(survivorSeq)}`;
  return `"d${String(EVENT_DETECTIONS_SCHEMA_VERSION)}-${String(seq)}${tail}"`;
}

/** One stored member as a GeoJSON point. Absent measurements are omitted, never `null`. */
export function detectionFeature(row: EventDetectionRow): DetectionFeature {
  return {
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [row.lon, row.lat] },
    properties: {
      uid: row.uid,
      observed_at: isoFromEpochMs(row.observedAt),
      source_id: row.sourceId,
      confidence: row.confidence,
      ...(row.scanKm === null ? {} : { scan_km: row.scanKm }),
      ...(row.trackKm === null ? {} : { track_km: row.trackKm }),
      ...(row.frpMw === null ? {} : { frp_mw: row.frpMw }),
    },
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
