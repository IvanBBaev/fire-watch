/**
 * `GET /overlays/outlines/active.json` — estimated fire outlines for the events on the
 * map (V2-A4), drawn by the worker from each event's own VIIRS/MODIS pixel footprints.
 *
 * **An estimate, never a perimeter.** Every feature carries its area as a band
 * (`area_low_ha`..`area_high_ha`) and the largest distance any edge may sit from where it
 * is drawn (`edge_uncertainty_km`). Nothing in the body predicts spread; the copy that
 * renders it says "estimated outline from satellite detections".
 *
 * Size-bounded: at most `maxOutlines` features, largest area first, with `truncated: true`
 * when more were left out. Each ring is already capped by the drawing parameters.
 *
 * Honest about staleness: the worker records a heartbeat each time an outline pass
 * completes. Before the first pass, or once the heartbeat is older than `staleAfterMs`,
 * the route answers 503 rather than serve outlines that no longer follow the detections.
 *
 * Headers follow the lightning overlay: open CORS, a per-IP limit, an in-flight cap, no
 * query parameters, and a content-addressed ETag. The body dates itself (`computed_at`, the
 * pass that last confirmed it), so a fixture or a revalidated copy cannot relabel itself.
 */

import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';

import { CREDITS, renderCredit } from '@fire-watch/contracts';

import { createRateLimiter } from '../../core/http/rate-limiter.js';
import { isoFromEpochMs, type Clock, type EpochMs } from '../../core/ports/clock.js';
import type {
  ActiveFireOutline,
  ActiveFireOutlinesRead,
  FireOutlineReader,
} from '../../core/ports/fire-outline-store.js';
import type { OutlineGeometry } from '../../core/outlines/fire-outline.js';
import { PRODUCT_NAME, type SnapshotAttribution } from '../../core/snapshot/snapshot-builder.js';
import { clientKey } from './client-key.js';
import { DEFAULT_MAX_IN_FLIGHT } from './event-detections-route.js';
import { createProblemHandler, ProblemError, type ProblemObserver } from './problem.js';
import { matchesIfNoneMatch } from './snapshot-route.js';

export const FIRE_OUTLINE_OVERLAY_PATH = '/overlays/outlines/active.json';
export const FIRE_OUTLINE_OVERLAY_SCHEMA_VERSION = 1;
export const FIRE_OUTLINE_OVERLAY_CACHE_CONTROL = 'public, max-age=60';

/** Features per response; the largest outlines win when more events have one. */
export const DEFAULT_MAX_OUTLINES = 200;
/** Fifteen identity cycles: a pass that has not completed in that time is not "current". */
export const DEFAULT_OUTLINE_STALE_AFTER_MS = 15 * 60_000;
export const DEFAULT_OUTLINE_RATE_LIMIT = 60;
export const DEFAULT_OUTLINE_RATE_LIMIT_WINDOW_MS = 60_000;
export const FIRE_OUTLINE_CREDIT_ID = 'firms-acknowledgement';

const RETRY_AFTER_SECONDS = 60;
const OVERLOADED_RETRY_AFTER_SECONDS = 1;

export interface FireOutlineOverlayRouteDeps {
  readonly reader: FireOutlineReader;
  readonly clock: Clock;
  readonly maxOutlines?: number;
  readonly staleAfterMs?: number;
  readonly maxInFlight?: number;
  readonly onProblem?: ProblemObserver | undefined;
  readonly rateLimit?: { readonly limit: number; readonly windowMs: number };
  readonly clientIpHeader?: string | undefined;
}

export interface FireOutlineFeatureProperties {
  readonly event_id: string;
  readonly area_ha: number;
  readonly area_low_ha: number;
  readonly area_high_ha: number;
  readonly edge_uncertainty_km: number;
  readonly footprints: number;
  readonly last_detection_at: string;
}

export interface FireOutlineFeature {
  readonly type: 'Feature';
  readonly id: string;
  readonly geometry: OutlineGeometry;
  readonly properties: FireOutlineFeatureProperties;
}

export interface FireOutlineOverlayResponse {
  readonly type: 'FeatureCollection';
  readonly schema_version: number;
  /** "estimated" — the body never claims to be a perimeter. */
  readonly kind: 'estimated_outline';
  readonly params_version: string;
  /** When the outline pass that confirmed these outlines completed. */
  readonly computed_at: string;
  readonly truncated: boolean;
  readonly features: readonly FireOutlineFeature[];
  readonly attribution: readonly SnapshotAttribution[];
}

/** The body for a read whose pass is current. Exported for the tests and the fixtures. */
export function fireOutlineOverlayBody(
  read: ActiveFireOutlinesRead & { readonly pass: NonNullable<ActiveFireOutlinesRead['pass']> },
): FireOutlineOverlayResponse {
  return {
    type: 'FeatureCollection',
    schema_version: FIRE_OUTLINE_OVERLAY_SCHEMA_VERSION,
    kind: 'estimated_outline',
    params_version: read.pass.paramsVersion,
    computed_at: isoFromEpochMs(read.pass.completedAt),
    truncated: read.truncated,
    features: read.outlines.map(feature),
    attribution: fireOutlineAttribution(read.pass.completedAt),
  };
}

/** The FIRMS acknowledgement: the outlines are drawn from FIRMS detections. */
export function fireOutlineAttribution(at: EpochMs): readonly SnapshotAttribution[] {
  const credit = CREDITS.find((c) => c.id === FIRE_OUTLINE_CREDIT_ID);
  if (credit === undefined) throw new Error(`credit ${FIRE_OUTLINE_CREDIT_ID} is not registered`);
  const year = new Date(at).getUTCFullYear();
  return [
    {
      id: credit.id,
      source: credit.source,
      text: renderCredit(credit, { year, productName: PRODUCT_NAME }),
      ...(credit.href === undefined ? {} : { href: credit.href }),
    },
  ];
}

export function registerFireOutlineOverlayRoute(
  app: FastifyInstance,
  deps: FireOutlineOverlayRouteDeps,
): void {
  const maxOutlines = deps.maxOutlines ?? DEFAULT_MAX_OUTLINES;
  const staleAfterMs = deps.staleAfterMs ?? DEFAULT_OUTLINE_STALE_AFTER_MS;
  const maxInFlight = deps.maxInFlight ?? DEFAULT_MAX_IN_FLIGHT;
  const limiter = createRateLimiter({
    limit: deps.rateLimit?.limit ?? DEFAULT_OUTLINE_RATE_LIMIT,
    windowMs: deps.rateLimit?.windowMs ?? DEFAULT_OUTLINE_RATE_LIMIT_WINDOW_MS,
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
      url: FIRE_OUTLINE_OVERLAY_PATH,
      handler: async (request, reply) => {
        const now = deps.clock.now();
        const decision = limiter.check(clientKey(request, deps.clientIpHeader), now);
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
        if (inFlight >= maxInFlight) {
          throw new ProblemError({
            status: 503,
            title: 'Fire outlines temporarily unavailable',
            detail: 'The origin is shedding load; retry after the indicated delay.',
            retryAfterSeconds: OVERLOADED_RETRY_AFTER_SECONDS,
          });
        }

        inFlight += 1;
        let read: ActiveFireOutlinesRead;
        try {
          read = await deps.reader.readActiveOutlines(maxOutlines);
        } catch (error: unknown) {
          throw new ProblemError(
            {
              status: 503,
              title: 'Fire outlines temporarily unavailable',
              detail: 'The estimated outlines could not be read; retry later.',
              retryAfterSeconds: RETRY_AFTER_SECONDS,
            },
            { cause: error },
          );
        } finally {
          inFlight -= 1;
        }

        const pass = read.pass;
        if (pass === null || now - pass.completedAt > staleAfterMs) {
          throw new ProblemError({
            status: 503,
            title: 'Fire outlines not current',
            detail:
              pass === null
                ? 'No outline pass has completed yet.'
                : 'The latest outline pass is too old to show as current.',
            retryAfterSeconds: RETRY_AFTER_SECONDS,
          });
        }

        const body = JSON.stringify(fireOutlineOverlayBody({ ...read, pass }));
        const etag = `"o${String(FIRE_OUTLINE_OVERLAY_SCHEMA_VERSION)}-${createHash('sha256')
          .update(body)
          .digest('hex')
          .slice(0, 32)}"`;
        const computedAt = isoFromEpochMs(pass.completedAt);

        reply.header('etag', etag);
        reply.header('cache-control', FIRE_OUTLINE_OVERLAY_CACHE_CONTROL);
        reply.header('last-modified', new Date(pass.completedAt).toUTCString());
        reply.header('x-fire-watch-overlay-computed-at', computedAt);
        reply.header(
          'access-control-expose-headers',
          'etag, last-modified, x-fire-watch-overlay-computed-at',
        );
        reply.header('x-content-type-options', 'nosniff');
        if (matchesIfNoneMatch(request.headers['if-none-match'], etag)) {
          return reply.code(304).send();
        }
        return reply.type('application/json; charset=utf-8').send(body);
      },
    });
    done();
  });
}

function feature(outline: ActiveFireOutline): FireOutlineFeature {
  return {
    type: 'Feature',
    id: outline.publicId,
    geometry: outline.geometry,
    properties: {
      event_id: outline.publicId,
      area_ha: outline.areaHa,
      area_low_ha: outline.areaLowHa,
      area_high_ha: outline.areaHighHa,
      edge_uncertainty_km: outline.edgeUncertaintyKm,
      footprints: outline.footprints,
      last_detection_at: isoFromEpochMs(outline.lastDetectionAt),
    },
  };
}

function refuseQuery(query: unknown): void {
  if (typeof query !== 'object' || query === null) return;
  if (Object.keys(query).length === 0) return;
  throw new ProblemError({
    status: 400,
    title: 'Invalid query',
    detail: 'This resource takes no query parameters.',
  });
}
