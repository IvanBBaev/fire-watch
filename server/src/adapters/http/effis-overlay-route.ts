/**
 * `GET /overlays/effis/<layer>.<ext>` — the EFFIS overlay proxy's serving half (TASKS G4;
 * ADR-001 A1.2, amended by A2.2).
 *
 * The proxy is split in two on purpose. The refresh job (`core/effis/effis-refresh.ts`)
 * talks to EFFIS, runs the content-sanity classifier and moves `current.<ext>` only for a
 * body judged good. This route talks to nobody: it serves the file the job already judged,
 * so a request can never be the one that lets a 200-with-an-error-image into the cache,
 * and A2.2's "no image decoding in the proxy path" holds by construction.
 *
 * What a response promises:
 *
 *   * **The last good copy, with its true age.** `Last-Modified` and
 *     `X-Fire-Watch-Overlay-Available-At` are the upstream availability instant the job
 *     recorded, never the time of this request. There is no `Age` header and no
 *     conditional handling: the origin always answers 200 with the whole body, so no
 *     revalidation can re-anchor a staleness clock (the CDN-304 failure fixed in F4).
 *   * **`Cache-Control: public, max-age=600`** — A1.2's 10–15 min edge TTL, at its lower
 *     bound. Serve-stale-on-error is the origin's own behaviour (a failed or rejected
 *     refresh never moves `current`), so no `stale-if-error` is asserted here; whether
 *     the edge should add one is an open decision, not a number to guess.
 *   * **A2.2 pass-through.** When no good copy has ever been stored, the newest *suspect*
 *     body (blank, flat, under the floor — never a rejected one) is served with
 *     `max-age=60` and `X-Fire-Watch-Overlay-State: suspect`, so it ages out within a
 *     minute of the first good refresh.
 *   * **Integrity.** The payload is hashed and compared with its sidecar's `sha256`. The
 *     job renames the payload and then the sidecar, so a reader can catch the pair
 *     mid-flip; it retries once, then refuses with a 503 rather than serve a body under
 *     another body's date.
 *   * **Nothing about the upstream.** No EFFIS URL, query, header or sidecar member other
 *     than the date reaches the response; a refusal is a problem document with literal
 *     text only (`problem.ts`). Paths come from the layer config, never from the request:
 *     the URL parameter is only ever compared against the configured file names.
 *   * **No query strings**, as on every public route: `?_=…` must not become an origin
 *     hit per request. No per-IP throttle: the cache rule is the protection, and the
 *     probe hook exempts `EFFIS_OVERLAY_PATH` by name.
 */

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import type { FastifyInstance } from 'fastify';

import {
  EFFIS_LAYERS,
  type EffisLayerSpec,
  type EffisLayersValues,
} from '../../core/config/effis-layers.js';
import type { VersionedConfig } from '../../core/config/versioned-config.js';
import {
  effisCurrentMetaPath,
  effisCurrentPath,
  effisSuspectLatestMetaPath,
  effisSuspectLatestPath,
} from '../../core/effis/effis-refresh.js';
import { createProblemHandler, ProblemError, type ProblemObserver } from './problem.js';

/** Named because two places must agree on it: the route and the probe hook's exemption. */
export const EFFIS_OVERLAY_PATH = '/overlays/effis/:file';

/** A1.2: 10–15 min edge TTL — the lower bound, so a new refresh shows within ten minutes. */
export const EFFIS_OVERLAY_CACHE_CONTROL = 'public, max-age=600';

/** A2.2: a suspect body passed through is cached for at most 60 s. */
export const EFFIS_OVERLAY_SUSPECT_CACHE_CONTROL = 'public, max-age=60';

/** When a refusal says "try again": the pass-through TTL — nothing changes faster. */
const RETRY_AFTER_SECONDS = 60;

export type EffisOverlayState = 'current' | 'suspect';

export interface EffisOverlayRouteDeps {
  /** The refresh job's state directory — the root its payload store writes under. */
  readonly stateDir: string;
  /** Defaults to `EFFIS_LAYERS`; must be the config the refresh job runs under. */
  readonly layers?: VersionedConfig<EffisLayersValues> | undefined;
  /** Receives every refusal's correlation id; the caller owns the log line. */
  readonly onProblem?: ProblemObserver | undefined;
}

export function registerEffisOverlayRoute(app: FastifyInstance, deps: EffisOverlayRouteDeps): void {
  if (!isAbsolute(deps.stateDir)) {
    throw new RangeError(
      `overlay state dir must be an absolute path, got ${JSON.stringify(deps.stateDir)}`,
    );
  }
  const root = resolve(deps.stateDir);
  const byFile = new Map<string, EffisLayerSpec>(
    (deps.layers ?? EFFIS_LAYERS).values.layers.map((spec) => [
      `${spec.id}.${spec.extension}`,
      spec,
    ]),
  );

  void app.register((scope, _options, done) => {
    scope.setErrorHandler(createProblemHandler(deps.onProblem));
    scope.addHook('onRequest', (_request, reply, next) => {
      reply.header('access-control-allow-origin', '*');
      next();
    });

    scope.route<{ Params: { file: string } }>({
      method: ['GET', 'HEAD'],
      url: EFFIS_OVERLAY_PATH,
      handler: async (request, reply) => {
        refuseQuery(request.query);
        const spec = byFile.get(request.params.file);
        if (spec === undefined) {
          throw new ProblemError({
            status: 404,
            title: 'Unknown overlay',
            detail: 'No overlay is published under this name.',
          });
        }
        const copy = await readServableCopy(root, spec);
        reply.header(
          'cache-control',
          copy.state === 'current'
            ? EFFIS_OVERLAY_CACHE_CONTROL
            : EFFIS_OVERLAY_SUSPECT_CACHE_CONTROL,
        );
        reply.header('last-modified', new Date(copy.availableAtMs).toUTCString());
        reply.header('x-fire-watch-overlay-state', copy.state);
        reply.header('x-fire-watch-overlay-available-at', copy.availableAt);
        reply.header(
          'access-control-expose-headers',
          'last-modified, x-fire-watch-overlay-state, x-fire-watch-overlay-available-at',
        );
        reply.header('x-content-type-options', 'nosniff');
        return reply.type(spec.requestFormat).send(copy.body);
      },
    });
    done();
  });
}

interface ServableCopy {
  readonly state: EffisOverlayState;
  readonly body: Buffer;
  readonly availableAt: string;
  readonly availableAtMs: number;
}

/** The good copy if there is one, else the A2.2 pass-through, else a 503. */
async function readServableCopy(root: string, spec: EffisLayerSpec): Promise<ServableCopy> {
  const current = await readVerified(root, spec, 'current');
  if (current !== 'absent') return current;
  const suspect = await readVerified(root, spec, 'suspect');
  if (suspect !== 'absent') return suspect;
  throw new ProblemError({
    status: 503,
    title: 'Overlay not yet available',
    detail: 'No copy of this overlay has been fetched yet.',
    retryAfterSeconds: RETRY_AFTER_SECONDS,
  });
}

async function readVerified(
  root: string,
  spec: EffisLayerSpec,
  state: EffisOverlayState,
): Promise<ServableCopy | 'absent'> {
  const payloadPath = resolve(
    root,
    state === 'current' ? effisCurrentPath(spec) : effisSuspectLatestPath(spec),
  );
  const metaPath = resolve(
    root,
    state === 'current' ? effisCurrentMetaPath(spec) : effisSuspectLatestMetaPath(spec),
  );
  let lastProblem: unknown = null;
  // Two reads at most: the refresh renames payload then sidecar, so one mismatch is a
  // reader that caught the flip; two in a row is a store that is actually inconsistent.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const meta = await readOptional(metaPath);
    const body = await readOptional(payloadPath);
    if (meta === null && body === null) return 'absent';
    if (meta === null || body === null) {
      lastProblem = new Error(`${state} ${spec.id}: payload and sidecar not both present`);
      continue;
    }
    const sidecar = parseSidecar(meta, spec, state);
    if (typeof sidecar === 'string') {
      lastProblem = new Error(`${state} ${spec.id}: ${sidecar}`);
      continue;
    }
    if (createHash('sha256').update(body).digest('hex') !== sidecar.sha256) {
      lastProblem = new Error(`${state} ${spec.id}: payload does not match its sidecar sha256`);
      continue;
    }
    return { state, body, availableAt: sidecar.availableAt, availableAtMs: sidecar.availableAtMs };
  }
  throw new ProblemError(
    {
      status: 503,
      title: 'Overlay temporarily unavailable',
      detail: 'The stored copy of this overlay could not be verified.',
      retryAfterSeconds: RETRY_AFTER_SECONDS,
    },
    { cause: lastProblem },
  );
}

interface Sidecar {
  readonly sha256: string;
  readonly availableAt: string;
  readonly availableAtMs: number;
}

/** Only the three members the route relies on are read; anything off is a string reason. */
function parseSidecar(
  raw: Buffer,
  spec: EffisLayerSpec,
  state: EffisOverlayState,
): Sidecar | string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString('utf8'));
  } catch {
    return 'sidecar is not JSON';
  }
  if (typeof parsed !== 'object' || parsed === null) return 'sidecar is not an object';
  const record = parsed as Record<string, unknown>;
  if (record['layer'] !== spec.id) return 'sidecar belongs to another layer';
  // Belt and braces: `current` is only ever written for good bodies, and the
  // pass-through only for suspect ones — a rejected body must never be served.
  const wanted = state === 'current' ? 'good' : 'suspect';
  if (record['sanity'] !== wanted) return `sidecar sanity is not ${wanted}`;
  const sha256 = record['sha256'];
  if (typeof sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(sha256)) {
    return 'sidecar sha256 is malformed';
  }
  const availableAt = record['available_at'];
  const availableAtMs = typeof availableAt === 'string' ? Date.parse(availableAt) : Number.NaN;
  if (typeof availableAt !== 'string' || !Number.isFinite(availableAtMs)) {
    return 'sidecar available_at is malformed';
  }
  return { sha256, availableAt, availableAtMs };
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
