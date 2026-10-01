/**
 * `GET /api/v1/passes/<cell>` — when the fire-detecting satellites last looked at, and will
 * next look at, one grid cell (TASKS F15; DATA-SOURCES §F15).
 *
 * The route reads the orbital elements the TLE refresh stored (verified against their
 * sidecars, `core/passes/tle-store.ts`), builds the pass document for the current ten-minute
 * bucket (`core/passes/passes-document.ts`) and serves it as canonical JSON. It talks to
 * no upstream: a request can never be the one that makes CelesTrak see traffic.
 *
 * What a response promises:
 *
 *   * **Privacy by the grid.** The only location input is a cell id on a fixed 0.5° grid
 *     inside the polling box, in its one canonical spelling; anything else is a 404. A cell
 *     is ~55 × 40 km, so a request says no more about a reader than "somewhere in this
 *     district", and every reader in it shares one cached copy. The web asks with the
 *     map centre or a selected fire's cell — never with the reader's own position.
 *   * **Honest inputs.** `predicted: true`, each platform's element epoch and age, and
 *     `stale`/`missing` labels are in the body. Stale elements are served labelled, not
 *     hidden. A 503 only when no platform at all has elements (a fresh deployment).
 *   * **Content-addressed caching.** The body is a pure function of cell, bucket and stored
 *     elements, so the `ETag` is its sha256 and `If-None-Match` earns a 304. Unlike the
 *     overlay route's "true age" headers, nothing here dates the response rather than the
 *     body: a revalidated copy still carries its own `computed_for` and element epochs, so
 *     a 304 cannot re-anchor a staleness clock (the F4 failure). `max-age` runs to the end
 *     of the bucket, so every cache flips to the next window together.
 *   * **No query strings**, as on every public route.
 *
 * `GET /overlays/passes/swaths.json` ({@link PASS_SWATHS_PATH}) is the map half: one GeoJSON
 * document for the whole polling box with each platform's swath footprints and ground
 * tracks from six hours back to twelve ahead (`core/passes/swaths-document.ts`). It names
 * no place, so it says nothing about a reader at all; it is content-addressed and
 * bucket-aligned exactly like the per-cell document, from the same stored elements. It
 * lives under `/overlays/` because it is drawn as a map overlay and the dev proxy already
 * forwards that prefix to the API.
 *
 * **Cloud per pass (F17).** Each pass carries the ECMWF cloud *forecast* at its culmination,
 * from the document the weather job derives (`core/weather/cloud-cover.ts`). Its hash is
 * part of the cache key, so a new forecast run changes the body and the ETag within the
 * bucket. A missing, unreadable or malformed cloud document never fails the route: the
 * passes are served with `cloud: null` — cloud is context for a pass, not a precondition.
 *
 * An unverifiable stored copy is reported to the operator **when the set of problems
 * changes**, not on every request: the same refusal served to every cell of a busy map
 * would otherwise be one log line per request for as long as it lasts. The feed-status row
 * `celestrak:elements` (written by the refresh) is what keeps it visible after that.
 */

import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';

import { POLLING_BBOX } from '../../core/config/polling-bbox.js';
import { canonicalJson } from '../../core/determinism/canonical-json.js';
import { PASS_BUCKET_MS, parseCellId, passBucketStart } from '../../core/passes/pass-grid.js';
import { buildPassesDocument } from '../../core/passes/passes-document.js';
import { buildSwathsDocument } from '../../core/passes/swaths-document.js';
import { loadStoredElements, type StoredElements } from '../../core/passes/tle-store.js';
import type { Clock } from '../../core/ports/clock.js';
import type { PayloadReader } from '../../core/ports/payload-reader.js';
import {
  CLOUD_CURRENT_PATH,
  parseCloudDocument,
  type CloudDocument,
} from '../../core/weather/cloud-cover.js';
import { createProblemHandler, ProblemError, type ProblemObserver } from './problem.js';
import { matchesIfNoneMatch } from './snapshot-route.js';

/** Named because two places must agree on it: the route and the probe hook's exemption. */
export const PASSES_PATH = '/api/v1/passes/:cell';

/** The whole-box swath overlay; named for the same reason as {@link PASSES_PATH}. */
export const PASS_SWATHS_PATH = '/overlays/passes/swaths.json';

/** Swath bodies kept: one box, so only the current bucket and a straggler matter. */
const SWATHS_CACHE_ENTRIES = 4;

/** Bodies kept per (cell, bucket, elements); a whole polling box is ~200 cells. */
export const PASSES_CACHE_ENTRIES = 256;

/** Never shorter than this, so a request in a bucket's last second is still cacheable. */
const MIN_MAX_AGE_SECONDS = 30;

/** A fresh deployment gets elements on the worker's first cycle; nothing sooner helps. */
const RETRY_AFTER_SECONDS = 300;

export interface PassesRouteDeps {
  /** Reads what the TLE refresh stored — the same root its payload store writes under. */
  readonly reader: PayloadReader;
  readonly clock: Clock;
  /** Receives every refusal's correlation id and each unverifiable stored copy. */
  readonly onProblem?: ProblemObserver | undefined;
  /** Called when the set of refused stored copies changes (not on every request). */
  readonly onElementsProblem?: ((problems: readonly string[]) => void) | undefined;
}

interface CachedBody {
  readonly body: string;
  readonly etag: string;
}

export function registerPassesRoute(app: FastifyInstance, deps: PassesRouteDeps): void {
  const cache = new Map<string, CachedBody>();
  const swathsCache = new Map<string, CachedBody>();
  let reportedProblems = '';
  let cloudMemo: { readonly hash: string; readonly document: CloudDocument | null } | null = null;
  const readCloud = async (): Promise<{ hash: string; document: CloudDocument | null }> => {
    let text: string | null;
    try {
      text = await deps.reader.readText(CLOUD_CURRENT_PATH);
    } catch {
      text = null;
    }
    if (text === null) return { hash: 'none', document: null };
    const hash = createHash('sha256').update(text).digest('hex');
    if (cloudMemo?.hash !== hash) cloudMemo = { hash, document: parseCloudDocument(text) };
    return cloudMemo;
  };
  const readElements = async (): Promise<StoredElements> => {
    const stored = await loadStoredElements(deps.reader);
    const key = stored.problems.join('\n');
    if (key !== reportedProblems) {
      reportedProblems = key;
      if (stored.problems.length > 0) deps.onElementsProblem?.(stored.problems);
    }
    if (stored.elements.every((entry) => entry.record === null)) {
      throw new ProblemError({
        status: 503,
        title: 'Passes not yet available',
        detail: 'No orbital elements have been fetched yet.',
        retryAfterSeconds: RETRY_AFTER_SECONDS,
      });
    }
    return stored;
  };

  void app.register((scope, _options, done) => {
    scope.setErrorHandler(createProblemHandler(deps.onProblem));
    scope.addHook('onRequest', (_request, reply, next) => {
      reply.header('access-control-allow-origin', '*');
      next();
    });

    scope.route<{ Params: { cell: string } }>({
      method: ['GET', 'HEAD'],
      url: PASSES_PATH,
      handler: async (request, reply) => {
        refuseQuery(request.query);
        const cell = parseCellId(request.params.cell);
        if (cell === null) {
          throw new ProblemError({
            status: 404,
            title: 'Unknown cell',
            detail: 'Passes are published only for cells of the fixed grid inside the served area.',
          });
        }
        const now = deps.clock.now();
        const bucket = passBucketStart(now);
        const stored = await readElements();
        const cloud = await readCloud();

        const key = `${cell.id}|${String(bucket)}|${stored.digest}|${cloud.hash}`;
        let cached = cache.get(key);
        if (cached === undefined) {
          const body = canonicalJson(
            buildPassesDocument(cell, bucket, stored.elements, cloud.document),
          );
          cached = { body, etag: `"${createHash('sha256').update(body).digest('hex')}"` };
          remember(cache, key, cached, PASSES_CACHE_ENTRIES);
        } else {
          // Refresh recency: a Map iterates in insertion order, so re-inserting is the LRU.
          cache.delete(key);
          cache.set(key, cached);
        }

        const maxAge = Math.max(
          MIN_MAX_AGE_SECONDS,
          Math.ceil((bucket + PASS_BUCKET_MS - now) / 1000),
        );
        reply.header('cache-control', `public, max-age=${String(maxAge)}`);
        reply.header('etag', cached.etag);
        reply.header('access-control-expose-headers', 'etag');
        reply.header('x-content-type-options', 'nosniff');
        if (matchesIfNoneMatch(request.headers['if-none-match'], cached.etag)) {
          return reply.code(304).send();
        }
        return reply.type('application/json; charset=utf-8').send(cached.body);
      },
    });

    scope.route({
      method: ['GET', 'HEAD'],
      url: PASS_SWATHS_PATH,
      handler: async (request, reply) => {
        refuseQuery(request.query);
        const now = deps.clock.now();
        const bucket = passBucketStart(now);
        const stored = await readElements();
        const key = `${String(bucket)}|${stored.digest}`;
        let cached = swathsCache.get(key);
        if (cached === undefined) {
          const body = canonicalJson(
            buildSwathsDocument(POLLING_BBOX.values, bucket, stored.elements),
          );
          cached = { body, etag: `"${createHash('sha256').update(body).digest('hex')}"` };
          remember(swathsCache, key, cached, SWATHS_CACHE_ENTRIES);
        }
        const maxAge = Math.max(
          MIN_MAX_AGE_SECONDS,
          Math.ceil((bucket + PASS_BUCKET_MS - now) / 1000),
        );
        reply.header('cache-control', `public, max-age=${String(maxAge)}`);
        reply.header('etag', cached.etag);
        reply.header('access-control-expose-headers', 'etag');
        reply.header('x-content-type-options', 'nosniff');
        if (matchesIfNoneMatch(request.headers['if-none-match'], cached.etag)) {
          return reply.code(304).send();
        }
        return reply.type('application/geo+json; charset=utf-8').send(cached.body);
      },
    });
    done();
  });
}

function remember(
  cache: Map<string, CachedBody>,
  key: string,
  value: CachedBody,
  capacity: number,
): void {
  cache.set(key, value);
  while (cache.size > capacity) {
    const oldest = cache.keys().next();
    if (oldest.done === true) break;
    cache.delete(oldest.value);
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
