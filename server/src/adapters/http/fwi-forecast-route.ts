/**
 * `GET /api/v1/fwi-forecast/:lat/:lon` — the relayed GWIS FWI forecast at one point,
 * days 0 … 9 (V2-B1).
 *
 * What a response promises:
 *
 *   * **A snapped point inside the served box.** Coordinates are accepted only in the
 *     one-decimal form (`42.7/23.3`) and only inside `POLLING_BBOX`; anything else is a 400
 *     or a 404 before the upstream is touched. No query strings.
 *   * **A relayed forecast, attributed.** Every day carries its UTC forecast date and the
 *     GWIS value and class; the body carries the GWIS credit. Nothing here is ours.
 *   * **Bounded upstream cost.** The service caches a point for an hour, shares one
 *     in-flight lookup, and spends a global hourly budget; past it the answer is a 503.
 *   * **Its own per-IP limit**, keyed on the edge-owned header.
 *   * **Edge-cacheable** for ten minutes, with an `ETag` from the served bytes.
 */

import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';

import { CREDITS, renderCredit } from '@fire-watch/contracts';

import { POLLING_BBOX, type BoundingBox } from '../../core/config/polling-bbox.js';
import {
  parseSnappedPoint,
  pointInBox,
  type FwiForecastPoint,
  type FwiForecastService,
} from '../../core/effis/fwi-point.js';
import { createRateLimiter } from '../../core/http/rate-limiter.js';
import type { Clock } from '../../core/ports/clock.js';
import { PRODUCT_NAME, type SnapshotAttribution } from '../../core/snapshot/snapshot-builder.js';
import { clientKey } from './client-key.js';
import { createProblemHandler, ProblemError, type ProblemObserver } from './problem.js';
import { matchesIfNoneMatch } from './snapshot-route.js';

/** Named because two places must agree on it: the route and the probe hook's exemption. */
export const FWI_FORECAST_PATH = '/api/v1/fwi-forecast/:lat/:lon';

export const FWI_FORECAST_CACHE_CONTROL = 'public, max-age=600';

/** A reader taps a handful of points; thirty a minute is a script. */
export const DEFAULT_FWI_FORECAST_RATE_LIMIT = 30;
export const DEFAULT_FWI_FORECAST_RATE_LIMIT_WINDOW_MS = 60_000;

export const FWI_FORECAST_CREDIT_ID = 'gwis';

const RETRY_AFTER_SECONDS = 300;

export interface FwiForecastRouteDeps {
  readonly service: FwiForecastService;
  readonly clock: Clock;
  /** Defaults to `POLLING_BBOX`: the only points the lookup answers for. */
  readonly box?: BoundingBox | undefined;
  readonly onProblem?: ProblemObserver | undefined;
  readonly rateLimit?: { readonly limit: number; readonly windowMs: number } | undefined;
  readonly clientIpHeader?: string | undefined;
}

export interface FwiForecastResponse extends FwiForecastPoint {
  readonly source: 'gwis-ecmwf-fwi';
  readonly attribution: readonly SnapshotAttribution[];
}

export function registerFwiForecastRoute(app: FastifyInstance, deps: FwiForecastRouteDeps): void {
  const box = deps.box ?? POLLING_BBOX.values;
  const limiter = createRateLimiter({
    limit: deps.rateLimit?.limit ?? DEFAULT_FWI_FORECAST_RATE_LIMIT,
    windowMs: deps.rateLimit?.windowMs ?? DEFAULT_FWI_FORECAST_RATE_LIMIT_WINDOW_MS,
  });

  void app.register((scope, _options, done) => {
    scope.setErrorHandler(createProblemHandler(deps.onProblem));
    scope.addHook('onRequest', (_request, reply, next) => {
      reply.header('access-control-allow-origin', '*');
      next();
    });

    scope.route<{ Params: { lat: string; lon: string } }>({
      method: ['GET', 'HEAD'],
      url: FWI_FORECAST_PATH,
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

        const point = parseSnappedPoint(request.params.lat, request.params.lon);
        if (point === null) {
          throw new ProblemError({
            status: 400,
            title: 'Invalid point',
            detail: 'Latitude and longitude must be decimal degrees with exactly one decimal.',
          });
        }
        if (!pointInBox(point, box)) {
          throw new ProblemError({
            status: 404,
            title: 'Outside the covered area',
            detail: 'The FWI forecast is relayed only for points inside the covered area.',
          });
        }

        const lookup = await deps.service.lookup(point);
        if (!lookup.ok) {
          throw new ProblemError({
            status: 503,
            title: 'FWI forecast temporarily unavailable',
            detail:
              lookup.reason === 'budget_exhausted'
                ? 'The forecast lookup is at capacity; retry later.'
                : 'The upstream forecast service did not answer.',
            retryAfterSeconds: RETRY_AFTER_SECONDS,
          });
        }
        const response: FwiForecastResponse = {
          ...lookup.body,
          source: 'gwis-ecmwf-fwi',
          attribution: fwiForecastAttribution(lookup.body.base_date),
        };
        const body = JSON.stringify(response);
        const etag = `"fwi${String(response.schema_version)}-${createHash('sha256')
          .update(body)
          .digest('hex')
          .slice(0, 32)}"`;
        reply.header('etag', etag);
        reply.header('cache-control', FWI_FORECAST_CACHE_CONTROL);
        reply.header('access-control-expose-headers', 'etag');
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

/** The GWIS credit, rendered with the forecast's year. */
export function fwiForecastAttribution(baseDate: string): readonly SnapshotAttribution[] {
  const credit = CREDITS.find((c) => c.id === FWI_FORECAST_CREDIT_ID);
  if (credit === undefined) throw new Error(`credit ${FWI_FORECAST_CREDIT_ID} is not registered`);
  const year = Number(baseDate.slice(0, 4));
  return [
    {
      id: credit.id,
      source: credit.source,
      text: renderCredit(credit, { year, productName: PRODUCT_NAME }),
      ...(credit.href === undefined ? {} : { href: credit.href }),
    },
  ];
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
