/**
 * `GET /overlays/cems/activations.json` — the Copernicus EMS activation badge's serving half
 * (TASKS V2-E3; DATA-SOURCES §V2-E3).
 *
 * Split like the lightning route (`lightning-overlay-route.ts`): the worker's CEMS job reads
 * the Rapid Mapping activation list and writes `overlays/cems/current.json` with a sha256
 * sidecar; this route talks to nobody. It reads the stored document, verifies it, and
 * serves it with the Copernicus credit.
 *
 * What a response promises:
 *
 *   * **Honest time, in the body.** `available_at` is when the server last read the
 *     activation list; a 304 cannot re-anchor it (the F4 lesson).
 *   * **No frozen "no activation".** Once `available_at` is older than
 *     `CEMS_MAX_STALENESS_MS` the answer is a 503: a badge missing because the job stopped
 *     would read as "Copernicus was not activated for this fire".
 *   * **`ETag` from the served bytes**, `Cache-Control: public, max-age=300` — the list is
 *     read hourly and an activation is news on the scale of hours.
 *   * **The Copernicus EMS credit** (`copernicus-ems`) in `attribution`, with the year of
 *     the list read.
 *   * **Integrity.** Document hashed against its sidecar, one retry, then 503.
 *   * **A per-IP limit** of its own; no query strings.
 */

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import type { FastifyInstance } from 'fastify';

import { CREDITS, renderCredit, type CemsOverlayBody } from '@fire-watch/contracts';

import {
  CEMS_CURRENT_META_PATH,
  CEMS_CURRENT_PATH,
  parseCemsDocument,
  selectCems,
} from '../../core/cems/cems-document.js';
import { createRateLimiter } from '../../core/http/rate-limiter.js';
import { epochMsFromIso, type Clock } from '../../core/ports/clock.js';
import { PRODUCT_NAME, type SnapshotAttribution } from '../../core/snapshot/snapshot-builder.js';
import { clientKey } from './client-key.js';
import { createProblemHandler, ProblemError, type ProblemObserver } from './problem.js';
import { matchesIfNoneMatch } from './snapshot-route.js';

/** Named because two places must agree on it: the route and the probe hook's exemption. */
export const CEMS_OVERLAY_PATH = '/overlays/cems/activations.json';

export const CEMS_OVERLAY_CACHE_CONTROL = 'public, max-age=300';

/** An event page fetches it once per visit; sixty a minute from one client is a loop. */
export const DEFAULT_CEMS_RATE_LIMIT = 60;
export const DEFAULT_CEMS_RATE_LIMIT_WINDOW_MS = 60_000;

export const CEMS_CREDIT_ID = 'copernicus-ems';

/** The job runs hourly. */
const RETRY_AFTER_SECONDS = 900;

export interface CemsOverlayRouteDeps {
  /** The refresh job's state directory — the root its payload store writes under. */
  readonly stateDir: string;
  readonly clock: Clock;
  readonly onProblem?: ProblemObserver | undefined;
  readonly rateLimit?: { readonly limit: number; readonly windowMs: number } | undefined;
  /** The edge-owned client-IP header; see `HealthServerDeps.clientIpHeader`. */
  readonly clientIpHeader?: string | undefined;
}

export interface CemsOverlayResponse extends CemsOverlayBody {
  readonly attribution: readonly SnapshotAttribution[];
}

export function registerCemsOverlayRoute(app: FastifyInstance, deps: CemsOverlayRouteDeps): void {
  if (!isAbsolute(deps.stateDir)) {
    throw new RangeError(
      `CEMS state dir must be an absolute path, got ${JSON.stringify(deps.stateDir)}`,
    );
  }
  const root = resolve(deps.stateDir);
  const limiter = createRateLimiter({
    limit: deps.rateLimit?.limit ?? DEFAULT_CEMS_RATE_LIMIT,
    windowMs: deps.rateLimit?.windowMs ?? DEFAULT_CEMS_RATE_LIMIT_WINDOW_MS,
  });

  void app.register((scope, _options, done) => {
    scope.setErrorHandler(createProblemHandler(deps.onProblem));
    scope.addHook('onRequest', (_request, reply, next) => {
      reply.header('access-control-allow-origin', '*');
      next();
    });

    scope.route({
      method: ['GET', 'HEAD'],
      url: CEMS_OVERLAY_PATH,
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
        const selection = selectCems(document, now);
        if (!selection.ok) {
          throw new ProblemError({
            status: 503,
            title: 'Copernicus EMS activations temporarily unavailable',
            detail: 'The latest recorded activation list is too old to show as current.',
            retryAfterSeconds: RETRY_AFTER_SECONDS,
          });
        }
        const response: CemsOverlayResponse = {
          ...selection.body,
          attribution: cemsAttribution(selection.body.available_at),
        };
        const body = JSON.stringify(response);
        const etag = `"c${String(response.schema_version)}-${createHash('sha256')
          .update(body)
          .digest('hex')
          .slice(0, 32)}"`;

        reply.header('etag', etag);
        reply.header('cache-control', CEMS_OVERLAY_CACHE_CONTROL);
        reply.header(
          'last-modified',
          new Date(epochMsFromIso(response.available_at)).toUTCString(),
        );
        reply.header('x-fire-watch-overlay-available-at', response.available_at);
        reply.header(
          'access-control-expose-headers',
          'etag, last-modified, x-fire-watch-overlay-available-at',
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

/** The Copernicus EMS credit, rendered with the year of the list read. */
export function cemsAttribution(availableAt: string): readonly SnapshotAttribution[] {
  const credit = CREDITS.find((c) => c.id === CEMS_CREDIT_ID);
  if (credit === undefined) throw new Error(`credit ${CEMS_CREDIT_ID} is not registered`);
  const year = new Date(epochMsFromIso(availableAt)).getUTCFullYear();
  return [
    {
      id: credit.id,
      source: credit.source,
      text: renderCredit(credit, { year, productName: PRODUCT_NAME }),
      ...(credit.href === undefined ? {} : { href: credit.href }),
    },
  ];
}

async function readVerifiedDocument(root: string): Promise<CemsOverlayBody> {
  const documentPath = resolve(root, CEMS_CURRENT_PATH);
  const metaPath = resolve(root, CEMS_CURRENT_META_PATH);
  let lastProblem: unknown = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const meta = await readOptional(metaPath);
    const body = await readOptional(documentPath);
    if (meta === null && body === null) {
      throw new ProblemError({
        status: 503,
        title: 'Copernicus EMS activations not yet available',
        detail: 'No activation list has been recorded yet.',
        retryAfterSeconds: RETRY_AFTER_SECONDS,
      });
    }
    if (meta === null || body === null) {
      lastProblem = new Error('CEMS document and sidecar not both present');
      continue;
    }
    const sha256 = sidecarSha(meta);
    if (sha256 === null) {
      lastProblem = new Error('CEMS sidecar sha256 is malformed');
      continue;
    }
    if (createHash('sha256').update(body).digest('hex') !== sha256) {
      lastProblem = new Error('CEMS document does not match its sidecar sha256');
      continue;
    }
    const document = parseCemsDocument(body.toString('utf8'));
    if (document === null) {
      lastProblem = new Error('CEMS document failed validation');
      continue;
    }
    return document;
  }
  throw new ProblemError(
    {
      status: 503,
      title: 'Copernicus EMS activations temporarily unavailable',
      detail: 'The stored activation list could not be verified.',
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
