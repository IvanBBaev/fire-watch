/**
 * `GET /overlays/wind/latest.json` — the F14 wind context layer's serving half (TASKS F14;
 * DATA-SOURCES §D2).
 *
 * Split like the EFFIS proxy (`effis-overlay-route.ts`): the worker's weather job decodes
 * the ECMWF fields and writes `weather/wind/current.json` with a sha256 sidecar; this route
 * talks to nobody and decodes nothing. It reads the stored document, verifies it, and
 * serves the one forecast step nearest the request's `now`.
 *
 * What a response promises:
 *
 *   * **Honest times, in the body.** `run_at` (the IFS run), `valid_at` (the hour the
 *     arrows are *for*) and `available_at` (when the inputs could first be known) travel
 *     in the JSON, and the legend labels from them, never from the fetch time. That is
 *     why this route, unlike the EFFIS one, can answer a conditional request: a 304 hands
 *     back a body whose times are still its own, so no revalidation can re-anchor what the
 *     reader is told (the F4 failure was a *clock* taken from response headers). The same
 *     times are mirrored in `X-Fire-Watch-Overlay-*` headers for tooling.
 *   * **A bounded step distance.** When even the nearest recorded step is more than
 *     `wind_overlay_v1.maxStepDistanceHours` from now — the worker has been down for a day
 *     — the answer is a 503, not yesterday's wind with a time label nobody reads.
 *   * **`ETag` from the served bytes** (a step switch changes the body, so the tag), and
 *     `Cache-Control: public, max-age=600`: the forecast moves in 6 h steps and the job in
 *     1 h cycles, so a ten-minute edge TTL costs nothing in truth and absorbs the reads.
 *   * **The ECMWF attribution, whole.** The five components `ecmwfComponents()` names, in
 *     order, in `attribution` — a consumer of this JSON owes them exactly as the map does.
 *   * **Integrity.** The document is hashed against its sidecar; a mismatch is retried
 *     once (the job renames document, then sidecar) and then refused with a 503.
 *   * **A per-IP limit** of its own. The body is small and edge-cached, so the limit is
 *     generous — a map fetches it once per toggle and per refresh — and exists so a
 *     cache-busting loop against the origin is refused cheaply. No query strings.
 */

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import type { FastifyInstance } from 'fastify';

import { ecmwfComponents, renderCredit } from '@fire-watch/contracts';

import type { VersionedConfig } from '../../core/config/versioned-config.js';
import { WIND_OVERLAY, type WindOverlayValues } from '../../core/config/wind-overlay.js';
import { createRateLimiter } from '../../core/http/rate-limiter.js';
import { epochMsFromIso, type Clock } from '../../core/ports/clock.js';
import { PRODUCT_NAME, type SnapshotAttribution } from '../../core/snapshot/snapshot-builder.js';
import {
  WIND_CURRENT_META_PATH,
  WIND_CURRENT_PATH,
  parseWindDocument,
  selectWindStep,
  type WindDocument,
  type WindOverlayBody,
} from '../../core/weather/wind-overlay.js';
import { clientKey } from './client-key.js';
import { createProblemHandler, ProblemError, type ProblemObserver } from './problem.js';
import { matchesIfNoneMatch } from './snapshot-route.js';

/** Named because two places must agree on it: the route and the probe hook's exemption. */
export const WIND_OVERLAY_PATH = '/overlays/wind/latest.json';

export const WIND_OVERLAY_CACHE_CONTROL = 'public, max-age=600';

/** A map fetches once per toggle and per refresh; sixty a minute is a loop, not a reader. */
export const DEFAULT_WIND_RATE_LIMIT = 60;
export const DEFAULT_WIND_RATE_LIMIT_WINDOW_MS = 60_000;

/** The job runs hourly; nothing a retry could find changes faster than this. */
const RETRY_AFTER_SECONDS = 300;

export interface WindOverlayRouteDeps {
  /** The refresh job's state directory — the root its payload store writes under. */
  readonly stateDir: string;
  readonly clock: Clock;
  /** Defaults to `WIND_OVERLAY`; must be the config the worker derives under. */
  readonly overlayConfig?: VersionedConfig<WindOverlayValues> | undefined;
  readonly onProblem?: ProblemObserver | undefined;
  readonly rateLimit?: { readonly limit: number; readonly windowMs: number } | undefined;
  /** The edge-owned client-IP header; see `HealthServerDeps.clientIpHeader`. */
  readonly clientIpHeader?: string | undefined;
}

/** The wire body: one step of the stored document, plus the ECMWF attribution unit. */
export interface WindOverlayResponse extends WindOverlayBody {
  readonly attribution: readonly SnapshotAttribution[];
}

export function registerWindOverlayRoute(app: FastifyInstance, deps: WindOverlayRouteDeps): void {
  if (!isAbsolute(deps.stateDir)) {
    throw new RangeError(
      `wind state dir must be an absolute path, got ${JSON.stringify(deps.stateDir)}`,
    );
  }
  const root = resolve(deps.stateDir);
  const values = (deps.overlayConfig ?? WIND_OVERLAY).values;
  const limiter = createRateLimiter({
    limit: deps.rateLimit?.limit ?? DEFAULT_WIND_RATE_LIMIT,
    windowMs: deps.rateLimit?.windowMs ?? DEFAULT_WIND_RATE_LIMIT_WINDOW_MS,
  });

  void app.register((scope, _options, done) => {
    scope.setErrorHandler(createProblemHandler(deps.onProblem));
    scope.addHook('onRequest', (_request, reply, next) => {
      reply.header('access-control-allow-origin', '*');
      next();
    });

    scope.route({
      method: ['GET', 'HEAD'],
      url: WIND_OVERLAY_PATH,
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
        const selection = selectWindStep(document, now, values);
        if (!selection.ok) {
          throw new ProblemError({
            status: 503,
            title: 'Wind temporarily unavailable',
            detail: 'No recorded forecast step is close enough to the current time.',
            retryAfterSeconds: RETRY_AFTER_SECONDS,
          });
        }
        const response: WindOverlayResponse = {
          ...selection.body,
          attribution: ecmwfAttribution(selection.body.run_at),
        };
        const body = JSON.stringify(response);
        const etag = `"w${String(response.schema_version)}-${createHash('sha256')
          .update(body)
          .digest('hex')
          .slice(0, 32)}"`;

        reply.header('etag', etag);
        reply.header('cache-control', WIND_OVERLAY_CACHE_CONTROL);
        reply.header(
          'last-modified',
          new Date(epochMsFromIso(response.available_at)).toUTCString(),
        );
        reply.header('x-fire-watch-overlay-run-at', response.run_at);
        reply.header('x-fire-watch-overlay-valid-at', response.valid_at);
        reply.header('x-fire-watch-overlay-available-at', response.available_at);
        reply.header(
          'access-control-expose-headers',
          'etag, last-modified, x-fire-watch-overlay-run-at, x-fire-watch-overlay-valid-at, x-fire-watch-overlay-available-at',
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

/** The five ECMWF components, rendered with the data's year (the run's). */
export function ecmwfAttribution(runAt: string): readonly SnapshotAttribution[] {
  const context = {
    year: new Date(epochMsFromIso(runAt)).getUTCFullYear(),
    productName: PRODUCT_NAME,
  };
  return ecmwfComponents().map((credit) => ({
    id: credit.id,
    source: credit.source,
    text: renderCredit(credit, context),
    ...(credit.href === undefined ? {} : { href: credit.href }),
  }));
}

async function readVerifiedDocument(root: string): Promise<WindDocument> {
  const documentPath = resolve(root, WIND_CURRENT_PATH);
  const metaPath = resolve(root, WIND_CURRENT_META_PATH);
  let lastProblem: unknown = null;
  // Two reads at most, as on the EFFIS route: one mismatch is a reader that caught the
  // job between its two renames; two in a row is a store that is actually inconsistent.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const meta = await readOptional(metaPath);
    const body = await readOptional(documentPath);
    if (meta === null && body === null) {
      throw new ProblemError({
        status: 503,
        title: 'Wind not yet available',
        detail: 'No wind forecast has been derived yet.',
        retryAfterSeconds: RETRY_AFTER_SECONDS,
      });
    }
    if (meta === null || body === null) {
      lastProblem = new Error('wind document and sidecar not both present');
      continue;
    }
    const sha256 = sidecarSha(meta);
    if (sha256 === null) {
      lastProblem = new Error('wind sidecar sha256 is malformed');
      continue;
    }
    if (createHash('sha256').update(body).digest('hex') !== sha256) {
      lastProblem = new Error('wind document does not match its sidecar sha256');
      continue;
    }
    const document = parseWindDocument(body.toString('utf8'));
    if (document === null) {
      lastProblem = new Error('wind document failed validation');
      continue;
    }
    return document;
  }
  throw new ProblemError(
    {
      status: 503,
      title: 'Wind temporarily unavailable',
      detail: 'The stored wind forecast could not be verified.',
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
