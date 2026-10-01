/**
 * `GET /overlays/lightning/recent.json` — the F18 lightning context layer's serving half
 * (TASKS F18; DATA-SOURCES §F18).
 *
 * Split like the wind route (`wind-overlay-route.ts`): the worker's lightning job fetches
 * and decodes the MTG LI LFL products and writes `overlays/lightning/current.json` with a
 * sha256 sidecar; this route talks to nobody and decodes nothing. It reads the stored
 * document, verifies it, and serves the last six hours of flashes inside the served box.
 *
 * What a response promises:
 *
 *   * **Honest times, in the body.** `covered_through` (the latest window end merged — the
 *     only time up to which "no flash here" is a statement) and `available_at` travel in
 *     the JSON; the legend's "as of" is built from them, never from the fetch time. A 304
 *     therefore cannot re-anchor what the reader is told (the F4 lesson).
 *   * **No frozen empty sky.** Once `covered_through` is older than
 *     `LIGHTNING_MAX_STALENESS_MS` the answer is a 503: an empty map from a stopped job
 *     would read as "no lightning", which is a claim this layer cannot make.
 *   * **Clipped to the served box** (`POLLING_BBOX`), whatever the document holds.
 *   * **`ETag` from the served bytes**, `Cache-Control: public, max-age=60` — products
 *     arrive every ten minutes and flashes age across class boundaries by the minute.
 *   * **The EUMETSAT attribution** (`eumetsat-meteosat`, Data Policy Art. 6.3) in
 *     `attribution`, with the year of the data.
 *   * **Integrity.** Document hashed against its sidecar, one retry, then 503.
 *   * **A per-IP limit** of its own; no query strings.
 */

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import type { FastifyInstance } from 'fastify';

import { CREDITS, renderCredit } from '@fire-watch/contracts';

import { POLLING_BBOX, type BoundingBox } from '../../core/config/polling-bbox.js';
import { createRateLimiter } from '../../core/http/rate-limiter.js';
import {
  LIGHTNING_CURRENT_META_PATH,
  LIGHTNING_CURRENT_PATH,
  parseLightningDocument,
  selectLightning,
  type LightningDocument,
  type LightningOverlayBody,
} from '../../core/lightning/lightning-document.js';
import { epochMsFromIso, type Clock } from '../../core/ports/clock.js';
import { PRODUCT_NAME, type SnapshotAttribution } from '../../core/snapshot/snapshot-builder.js';
import { clientKey } from './client-key.js';
import { createProblemHandler, ProblemError, type ProblemObserver } from './problem.js';
import { matchesIfNoneMatch } from './snapshot-route.js';

/** Named because two places must agree on it: the route and the probe hook's exemption. */
export const LIGHTNING_OVERLAY_PATH = '/overlays/lightning/recent.json';

export const LIGHTNING_OVERLAY_CACHE_CONTROL = 'public, max-age=60';

/** A map refetches every few minutes while the layer is on; sixty a minute is a loop. */
export const DEFAULT_LIGHTNING_RATE_LIMIT = 60;
export const DEFAULT_LIGHTNING_RATE_LIMIT_WINDOW_MS = 60_000;

export const LIGHTNING_CREDIT_ID = 'eumetsat-meteosat';

/** The job runs every five minutes. */
const RETRY_AFTER_SECONDS = 120;

export interface LightningOverlayRouteDeps {
  /** The refresh job's state directory — the root its payload store writes under. */
  readonly stateDir: string;
  readonly clock: Clock;
  /** Defaults to `POLLING_BBOX`; the box the served flashes are clipped to. */
  readonly box?: BoundingBox | undefined;
  readonly onProblem?: ProblemObserver | undefined;
  readonly rateLimit?: { readonly limit: number; readonly windowMs: number } | undefined;
  /** The edge-owned client-IP header; see `HealthServerDeps.clientIpHeader`. */
  readonly clientIpHeader?: string | undefined;
}

export interface LightningOverlayResponse extends LightningOverlayBody {
  readonly attribution: readonly SnapshotAttribution[];
}

export function registerLightningOverlayRoute(
  app: FastifyInstance,
  deps: LightningOverlayRouteDeps,
): void {
  if (!isAbsolute(deps.stateDir)) {
    throw new RangeError(
      `lightning state dir must be an absolute path, got ${JSON.stringify(deps.stateDir)}`,
    );
  }
  const root = resolve(deps.stateDir);
  const box = deps.box ?? POLLING_BBOX.values;
  const limiter = createRateLimiter({
    limit: deps.rateLimit?.limit ?? DEFAULT_LIGHTNING_RATE_LIMIT,
    windowMs: deps.rateLimit?.windowMs ?? DEFAULT_LIGHTNING_RATE_LIMIT_WINDOW_MS,
  });

  void app.register((scope, _options, done) => {
    scope.setErrorHandler(createProblemHandler(deps.onProblem));
    scope.addHook('onRequest', (_request, reply, next) => {
      reply.header('access-control-allow-origin', '*');
      next();
    });

    scope.route({
      method: ['GET', 'HEAD'],
      url: LIGHTNING_OVERLAY_PATH,
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

        const document = await readVerifiedDocument(root);
        const selection = selectLightning(document, now, box);
        if (!selection.ok) {
          throw new ProblemError({
            status: 503,
            title: 'Lightning temporarily unavailable',
            detail:
              selection.reason === 'stale'
                ? 'The latest recorded lightning product is too old to show as current.'
                : 'No lightning product has been recorded yet.',
            retryAfterSeconds: RETRY_AFTER_SECONDS,
          });
        }
        const response: LightningOverlayResponse = {
          ...selection.body,
          attribution: lightningAttribution(selection.body.covered_through),
        };
        const body = JSON.stringify(response);
        const etag = `"l${String(response.schema_version)}-${createHash('sha256')
          .update(body)
          .digest('hex')
          .slice(0, 32)}"`;

        reply.header('etag', etag);
        reply.header('cache-control', LIGHTNING_OVERLAY_CACHE_CONTROL);
        reply.header(
          'last-modified',
          new Date(epochMsFromIso(response.available_at)).toUTCString(),
        );
        reply.header('x-fire-watch-overlay-covered-through', response.covered_through);
        reply.header('x-fire-watch-overlay-available-at', response.available_at);
        reply.header(
          'access-control-expose-headers',
          'etag, last-modified, x-fire-watch-overlay-covered-through, x-fire-watch-overlay-available-at',
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

/** The EUMETSAT credit, rendered with the data's year. */
export function lightningAttribution(coveredThrough: string): readonly SnapshotAttribution[] {
  const credit = CREDITS.find((c) => c.id === LIGHTNING_CREDIT_ID);
  if (credit === undefined) throw new Error(`credit ${LIGHTNING_CREDIT_ID} is not registered`);
  const year = new Date(epochMsFromIso(coveredThrough)).getUTCFullYear();
  return [
    {
      id: credit.id,
      source: credit.source,
      text: renderCredit(credit, { year, productName: PRODUCT_NAME }),
      ...(credit.href === undefined ? {} : { href: credit.href }),
    },
  ];
}

async function readVerifiedDocument(root: string): Promise<LightningDocument> {
  const documentPath = resolve(root, LIGHTNING_CURRENT_PATH);
  const metaPath = resolve(root, LIGHTNING_CURRENT_META_PATH);
  let lastProblem: unknown = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const meta = await readOptional(metaPath);
    const body = await readOptional(documentPath);
    if (meta === null && body === null) {
      throw new ProblemError({
        status: 503,
        title: 'Lightning not yet available',
        detail: 'No lightning product has been recorded yet.',
        retryAfterSeconds: RETRY_AFTER_SECONDS,
      });
    }
    if (meta === null || body === null) {
      lastProblem = new Error('lightning document and sidecar not both present');
      continue;
    }
    const sha256 = sidecarSha(meta);
    if (sha256 === null) {
      lastProblem = new Error('lightning sidecar sha256 is malformed');
      continue;
    }
    if (createHash('sha256').update(body).digest('hex') !== sha256) {
      lastProblem = new Error('lightning document does not match its sidecar sha256');
      continue;
    }
    const document = parseLightningDocument(body.toString('utf8'));
    if (document === null) {
      lastProblem = new Error('lightning document failed validation');
      continue;
    }
    return document;
  }
  throw new ProblemError(
    {
      status: 503,
      title: 'Lightning temporarily unavailable',
      detail: 'The stored lightning document could not be verified.',
      retryAfterSeconds: RETRY_AFTER_SECONDS,
    },
    { cause: lastProblem },
  );
}

function sidecarSha(raw: Buffer): string | null {
  try {
    const parsed = JSON.parse(raw.toString('utf8')) as unknown;
    if (typeof parsed !== 'object' || parsed === null) return null;
    const sha256 = (parsed as Record<string, unknown>)['sha256'];
    return typeof sha256 === 'string' && /^[0-9a-f]{64}$/.test(sha256) ? sha256 : null;
  } catch {
    return null;
  }
}

async function readOptional(path: string): Promise<Buffer | null> {
  try {
    return await readFile(path);
  } catch (error: unknown) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') {
      return null;
    }
    throw error;
  }
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
