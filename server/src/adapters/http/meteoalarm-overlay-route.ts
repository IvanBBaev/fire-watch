/**
 * `GET /overlays/meteoalarm/warnings.json` — the V2-B3 official-warnings relay's serving
 * half (DATA-SOURCES-EXTENDED §J11).
 *
 * Split like the wind overlay (`wind-overlay-route.ts`): the worker's MeteoAlarm loop polls
 * the national Atom feeds and writes `meteoalarm/current.json` with a sha256 sidecar; this
 * route talks to nobody. It reads the stored document, verifies it, and serves the
 * forest-fire and high-temperature warnings still in force at the request's `now`.
 *
 * What a response promises:
 *
 *   * **Honest times, in the body.** `generated_at` (the last poll) and each country's
 *     `checked_at` travel in the JSON, and the panel labels from them, never from the fetch
 *     time — so a 304 cannot re-anchor what the reader is told.
 *   * **Bounded staleness.** A document older than `METEOALARM_MAX_STALENESS_MS` is a 503,
 *     never an empty list: "no warnings" must only ever mean "none in force".
 *   * **`ETag` from the served bytes**, and `Cache-Control: public, max-age=300`: the job
 *     polls every 15 minutes, so a five-minute edge TTL costs little and absorbs the reads.
 *   * **The MeteoAlarm credit** in `attribution`, rendered with the generation year.
 *   * **Integrity.** The document is hashed against its sidecar; a mismatch is retried once
 *     (the job renames document, then sidecar) and then refused with a 503.
 *   * **A per-IP limit** of its own, and no query strings.
 */

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import type { FastifyInstance } from 'fastify';

import { CREDITS, renderCredit } from '@fire-watch/contracts';

import { createRateLimiter } from '../../core/http/rate-limiter.js';
import {
  METEOALARM_CURRENT_META_PATH,
  METEOALARM_CURRENT_PATH,
  parseMeteoalarmDocument,
  selectActiveWarnings,
  type MeteoalarmDocument,
  type MeteoalarmOverlayBody,
} from '../../core/meteoalarm/meteoalarm-document.js';
import { epochMsFromIso, type Clock } from '../../core/ports/clock.js';
import { PRODUCT_NAME, type SnapshotAttribution } from '../../core/snapshot/snapshot-builder.js';
import { clientKey } from './client-key.js';
import { createProblemHandler, ProblemError, type ProblemObserver } from './problem.js';
import { matchesIfNoneMatch } from './snapshot-route.js';

/** Named because two places must agree on it: the route and the probe hook's exemption. */
export const METEOALARM_OVERLAY_PATH = '/overlays/meteoalarm/warnings.json';

export const METEOALARM_OVERLAY_CACHE_CONTROL = 'public, max-age=300';

/** The panel fetches once per open and per refresh; sixty a minute is a loop. */
export const DEFAULT_METEOALARM_RATE_LIMIT = 60;
export const DEFAULT_METEOALARM_RATE_LIMIT_WINDOW_MS = 60_000;

/** The job polls every 15 minutes; nothing a retry could find changes faster than this. */
const RETRY_AFTER_SECONDS = 300;

export interface MeteoalarmOverlayRouteDeps {
  /** The refresh job's state directory — the root its payload store writes under. */
  readonly stateDir: string;
  readonly clock: Clock;
  readonly onProblem?: ProblemObserver | undefined;
  readonly rateLimit?: { readonly limit: number; readonly windowMs: number } | undefined;
  /** The edge-owned client-IP header; see `HealthServerDeps.clientIpHeader`. */
  readonly clientIpHeader?: string | undefined;
}

/** The wire body: the active warnings plus the MeteoAlarm credit. */
export interface MeteoalarmOverlayResponse extends MeteoalarmOverlayBody {
  readonly attribution: readonly SnapshotAttribution[];
}

export function registerMeteoalarmOverlayRoute(
  app: FastifyInstance,
  deps: MeteoalarmOverlayRouteDeps,
): void {
  if (!isAbsolute(deps.stateDir)) {
    throw new RangeError(
      `meteoalarm state dir must be an absolute path, got ${JSON.stringify(deps.stateDir)}`,
    );
  }
  const root = resolve(deps.stateDir);
  const limiter = createRateLimiter({
    limit: deps.rateLimit?.limit ?? DEFAULT_METEOALARM_RATE_LIMIT,
    windowMs: deps.rateLimit?.windowMs ?? DEFAULT_METEOALARM_RATE_LIMIT_WINDOW_MS,
  });

  void app.register((scope, _options, done) => {
    scope.setErrorHandler(createProblemHandler(deps.onProblem));
    scope.addHook('onRequest', (_request, reply, next) => {
      reply.header('access-control-allow-origin', '*');
      next();
    });

    scope.route({
      method: ['GET', 'HEAD'],
      url: METEOALARM_OVERLAY_PATH,
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
        const selection = selectActiveWarnings(document, now);
        if (!selection.ok) {
          throw new ProblemError({
            status: 503,
            title: 'Warnings temporarily unavailable',
            detail: 'The official warning feeds have not been read recently.',
            retryAfterSeconds: RETRY_AFTER_SECONDS,
          });
        }
        const response: MeteoalarmOverlayResponse = {
          ...selection.body,
          attribution: meteoalarmAttribution(selection.body.generated_at),
        };
        const body = JSON.stringify(response);
        const etag = `"ma${String(response.schema_version)}-${createHash('sha256')
          .update(body)
          .digest('hex')
          .slice(0, 32)}"`;

        reply.header('etag', etag);
        reply.header('cache-control', METEOALARM_OVERLAY_CACHE_CONTROL);
        reply.header(
          'last-modified',
          new Date(epochMsFromIso(response.generated_at)).toUTCString(),
        );
        reply.header('x-fire-watch-overlay-generated-at', response.generated_at);
        reply.header(
          'access-control-expose-headers',
          'etag, last-modified, x-fire-watch-overlay-generated-at',
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

/** The MeteoAlarm credit, rendered with the document's year. */
export function meteoalarmAttribution(generatedAt: string): readonly SnapshotAttribution[] {
  const credit = CREDITS.find((candidate) => candidate.id === 'meteoalarm');
  if (credit === undefined) throw new Error('the meteoalarm credit is missing from CREDITS');
  const context = {
    year: new Date(epochMsFromIso(generatedAt)).getUTCFullYear(),
    productName: PRODUCT_NAME,
  };
  return [
    {
      id: credit.id,
      source: credit.source,
      text: renderCredit(credit, context),
      ...(credit.href === undefined ? {} : { href: credit.href }),
    },
  ];
}

async function readVerifiedDocument(root: string): Promise<MeteoalarmDocument> {
  const documentPath = resolve(root, METEOALARM_CURRENT_PATH);
  const metaPath = resolve(root, METEOALARM_CURRENT_META_PATH);
  let lastProblem: unknown = null;
  // Two reads at most: one mismatch is a reader that caught the job between its two
  // renames; two in a row is a store that is actually inconsistent.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const meta = await readOptional(metaPath);
    const body = await readOptional(documentPath);
    if (meta === null && body === null) {
      throw new ProblemError({
        status: 503,
        title: 'Warnings not yet available',
        detail: 'The official warning feeds have not been read yet.',
        retryAfterSeconds: RETRY_AFTER_SECONDS,
      });
    }
    if (meta === null || body === null) {
      lastProblem = new Error('meteoalarm document and sidecar not both present');
      continue;
    }
    const sha256 = sidecarSha(meta);
    if (sha256 === null) {
      lastProblem = new Error('meteoalarm sidecar sha256 is malformed');
      continue;
    }
    if (createHash('sha256').update(body).digest('hex') !== sha256) {
      lastProblem = new Error('meteoalarm document does not match its sidecar sha256');
      continue;
    }
    const document = parseMeteoalarmDocument(body.toString('utf8'));
    if (document === null) {
      lastProblem = new Error('meteoalarm document failed validation');
      continue;
    }
    return document;
  }
  throw new ProblemError(
    {
      status: 503,
      title: 'Warnings temporarily unavailable',
      detail: 'The stored warnings could not be verified.',
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
