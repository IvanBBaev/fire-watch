/**
 * The fake origin the built app is pointed at — a static file server for `web/dist` plus
 * the few small routes the client reads at runtime, on one loopback port.
 *
 * Why a hand-rolled `node:http` server rather than the real Fastify API: CI-7 is the
 * polling-only gate of the *client*. What it must prove is that the shipped bundle boots,
 * renders, polls on the advertised cadence with the ETag/cursor discipline of ADR-003,
 * notices a change, and degrades honestly — and proving that needs an origin whose
 * answers the test can script (a status flip, an old `generated_at`, a 503 streak) and
 * whose request log the test can read. A real server would need PostGIS for the same
 * five routes and would hide the request stream behind its own logging.
 *
 * The wire behaviour copies the server's, header for header where the client keys off
 * it, so a client passing here is exercising the same contract:
 *
 *   * `/api/v1/client-config` — `transport: "poll"`, a 5 s cadence (the client's floor),
 *     `Cache-Control: public, max-age=30`, CORS `*`. The stream is never offered.
 *   * the snapshot — `ETag` from the global `seq` mark, `304` on a matching
 *     `If-None-Match`, `?updated_after_seq=` cursor answered with a `partial` body,
 *     `max-age=0` so the browser revalidates on every poll.
 *   * the freshness probe — a healthy report in the contract's camelCase shape.
 *   * `/api/v1/stream` — `503` + `Retry-After: 60`, the operator-kill answer; the test
 *     asserts the client never asks.
 *   * `/static/snapshot.json` — the T2 copy (ADR-003 A1.2): the whole set, never a cursor.
 *
 * Every answer carries a correct `Date` header because the client's server-time tracker
 * (A1.6) reads it on every poll, 304s included, and every staleness verdict is measured
 * against that clock. The header is written from the origin's own clock — real time by
 * default, or the scenario's world clock (`harness/world-clock.ts`) when the test moves
 * time forward — so the `Date` a page reads and the `generated_at` it is compared with
 * always come from one clock.
 *
 * Scenarios switch what the origin says: `fresh` (the default), `stale`, `origin-down`
 * (`503` with a short `Retry-After` on the snapshot route alone, so the client's own
 * backoff — not the hold — paces its retries) and `origin-dead` (the same `503` on every
 * API route: snapshot, freshness probe, client-config, stream and the same-origin static
 * copy — the whole application server gone). The built app's own files stay served in
 * every scenario: the page under test is already loaded, and what an outage takes away
 * from it is the API, not the shell it is running in.
 *
 * `stale` is one coherent outage rather than one bent field: publishing stopped at a fixed
 * instant `staleByMs` ago, so the snapshot document is anchored there and stays there
 * while the wall clock moves on, *and* the freshness probe says the same thing — every
 * monitored source `critical`, last data at that same instant. That is what a stopped
 * pipeline behind a live API looks like, and it is the only shape that puts the banner up
 * for longer than a frame: the client treats a `304` on a full request as the origin
 * confirming the held set as of the response `Date` (core/types.ts `snapshot-confirmed`,
 * core/store/reconciler.ts `applyConfirmation`), so a backdated `generated_at` alone is
 * re-anchored to "now" by the very next revalidation and the snapshot-age trigger of
 * GLOSSARY §3b never fires while the origin is answering.
 */

import { readFile, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { extname, join, normalize, resolve, sep } from 'node:path';

import { MONITORED_SOURCE_IDS, SNAPSHOT_PUSH_WARN_SECONDS } from '@fire-watch/contracts';
import type { ClientConfigDocument, FreshnessReport } from '@fire-watch/contracts';

import { DEFAULT_CONFIG } from '../../src/core/config.js';
import { anchoredAt, scriptSnapshot } from './fixture.js';
import type { ScriptedSnapshot, WireSnapshot } from './fixture.js';

export type Scenario = 'fresh' | 'stale' | 'origin-down' | 'origin-dead';

export interface LoggedRequest {
  readonly method: string;
  readonly path: string;
  readonly query: Readonly<Record<string, string>>;
  /** Whether the request carried `If-None-Match`. */
  readonly conditional: boolean;
  readonly status: number;
  /** Origin-clock ms when the answer was decided (wall clock unless a clock is injected). */
  readonly at: number;
}

export interface HarnessOrigin {
  /** `http://127.0.0.1:<port>` — the only origin the browser is allowed to reach. */
  readonly baseUrl: string;
  /** The absolute URL of the T2 copy, for a client-config that advertises one. */
  readonly staticSnapshotUrl: string;
  /** Every request answered so far, in arrival order. */
  readonly requests: readonly LoggedRequest[];
  /** The scripted document behind the snapshot routes, for mutations. */
  readonly snapshot: ScriptedSnapshot;
  /** The document as the next full answer would carry it, anchored at `nowMs`. */
  servedSnapshot(nowMs: number): WireSnapshot;
  setScenario(scenario: Scenario): void;
  /**
   * Advertise a T2 copy hosted elsewhere — a mirror on its own origin — in place of the
   * harness's same-origin one. Set before the page boots: client-config is read once.
   */
  advertiseStaticSnapshotUrl(url: string): void;
  close(): Promise<void>;
}

export interface OriginOptions {
  /** The built app to serve; the suite refuses to run against a missing build. */
  readonly distDir: string;
  readonly fixture: WireSnapshot;
  /** Whether `/api/v1/client-config` advertises the harness's own T2 copy. */
  readonly advertiseStaticCopy: boolean;
  /** How long ago publishing stopped, in the `stale` scenario. */
  readonly staleByMs: number;
  /**
   * The origin's clock, epoch ms: every `Date` header, every anchored `generated_at` and
   * every freshness stamp is read from it. Defaults to the wall clock.
   */
  readonly clock?: () => number;
}

/** The cursor query parameter of ADR-003 — the wire name, asserted on rather than imported. */
export const CURSOR_QUERY_PARAM = 'updated_after_seq';

/** Mirrors the server's client-config route: one edge TTL, no ETag. */
const CLIENT_CONFIG_CACHE_CONTROL = 'public, max-age=30';
/** Mirrors the server's snapshot route: the browser revalidates, the edge holds briefly. */
const SNAPSHOT_CACHE_CONTROL = 'public, max-age=0, s-maxage=30, stale-while-revalidate=60';
/** What the server answers when the stream is switched off (`FIRE_WATCH_SSE_ENABLED=false`). */
const STREAM_RETRY_AFTER_SECONDS = 60;
/** Short on purpose: the client's exponential backoff, not the hold, must pace retries. */
const ORIGIN_DOWN_RETRY_AFTER_SECONDS = 1;
/** The floor the client accepts (`CLIENT_POLL_INTERVAL_MIN_MS`); the suite's waits scale on it. */
export const HARNESS_POLL_INTERVAL_MS = 5_000;
export const STATIC_COPY_PATH = '/static/snapshot.json';

/** Every route the application server answers — what `origin-dead` takes away. */
const API_PATHS: ReadonlySet<string> = new Set([
  DEFAULT_CONFIG.clientConfigUrl,
  DEFAULT_CONFIG.snapshotUrl,
  DEFAULT_CONFIG.freshnessUrl,
  DEFAULT_CONFIG.streamUrl,
  STATIC_COPY_PATH,
]);

const HTML_TYPE = 'text/html; charset=utf-8';

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.html': HTML_TYPE,
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

export async function startOrigin(options: OriginOptions): Promise<HarnessOrigin> {
  const distRoot = resolve(options.distDir);
  try {
    await stat(join(distRoot, 'index.html'));
  } catch {
    throw new Error(
      `e2e: ${join(distRoot, 'index.html')} is missing — build the web app first ` +
        '(`pnpm --filter @fire-watch/web build`, which `pnpm run test:e2e` runs for you).',
    );
  }

  const clock = options.clock ?? ((): number => Date.now());
  const snapshot = scriptSnapshot(options.fixture);
  const requests: LoggedRequest[] = [];
  let scenario: Scenario = 'fresh';
  let baseUrl = '';
  let advertisedStaticUrl: string | null = null;
  /**
   * The instant publishing stopped, fixed when the `stale` scenario is entered. Fixed, not
   * recomputed per request: an outage's last document keeps getting older, and a sliding
   * "always 20 minutes behind" stamp would also drift between the snapshot route and the
   * freshness route, which the banner's "since" stamp is read from.
   */
  let publishingStoppedAtMs: number | null = null;

  const generatedAtMs = (nowMs: number): number =>
    scenario === 'stale' ? (publishingStoppedAtMs ?? nowMs - options.staleByMs) : nowMs;

  const clientConfig = (): ClientConfigDocument => ({
    transport: 'poll',
    poll_interval_ms: HARNESS_POLL_INTERVAL_MS,
    static_snapshot_url:
      advertisedStaticUrl ?? (options.advertiseStaticCopy ? `${baseUrl}${STATIC_COPY_PATH}` : null),
  });

  /**
   * The probe API's report. In `stale` it reports the same outage the snapshot document
   * is in — the report and the document are two views of one world, and a client shown a
   * cheerful report over an old document would be right to believe the report. In
   * `origin-down` it stays healthy on purpose: what has failed there is the delivery of
   * one object, not the ingest pipeline the probe describes, and the A1.2 scenario's claim
   * is that the client flips tier without telling the user anything (ADR-003 D2).
   */
  const freshnessReport = (nowMs: number): FreshnessReport => {
    const nowIso = new Date(nowMs).toISOString();
    const behind = scenario === 'stale';
    const lastDataIso = new Date(generatedAtMs(nowMs)).toISOString();
    const ageSeconds = Math.round((nowMs - Date.parse(lastDataIso)) / 1_000);
    return {
      generatedAt: nowIso,
      status: behind ? 'critical' : 'ok',
      budgetVersion: 'e2e',
      rows: MONITORED_SOURCE_IDS.map((row) => ({
        row,
        state: behind ? 'critical' : 'ok',
        lastSuccessAt: behind ? lastDataIso : nowIso,
        lastDataAt: behind ? lastDataIso : nowIso,
        ageSeconds: behind ? ageSeconds : 0,
        // The budgets the rows are scored against, as the server would deliver them: the
        // banner renders what it is told and hardcodes no threshold of its own.
        warnSeconds: SNAPSHOT_PUSH_WARN_SECONDS,
        criticalSeconds: 3 * SNAPSHOT_PUSH_WARN_SECONDS,
        consecutiveFailures: 0,
        pages: true,
        mutedUntil: null,
        muteReason: null,
      })),
    };
  };

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? '/', baseUrl);
    const method = req.method ?? 'GET';
    const query = Object.fromEntries(url.searchParams.entries());
    const ifNoneMatch = req.headers['if-none-match'] ?? null;
    const now = clock();

    const send = (
      status: number,
      headers: Readonly<Record<string, string>>,
      body: Buffer | string | null,
    ): void => {
      requests.push({
        method,
        path: url.pathname,
        query,
        conditional: ifNoneMatch !== null,
        status,
        at: now,
      });
      res.writeHead(status, { date: new Date(now).toUTCString(), ...headers });
      if (method === 'HEAD' || body === null) res.end();
      else res.end(body);
    };
    const sendJson = (
      status: number,
      headers: Readonly<Record<string, string>>,
      body: unknown,
    ): void => {
      send(
        status,
        { 'content-type': CONTENT_TYPES['.json'] ?? '', ...headers },
        JSON.stringify(body),
      );
    };

    /** Both snapshot routes share the tag rule: the global mark is the whole validator. */
    const sendSnapshot = (doc: WireSnapshot): void => {
      // Same rule as the server's `snapshotEtag`: schema version and global mark, nothing else.
      const etag = `"v${doc.schema_version}-${doc.max_seq}"`;
      const headers = {
        etag,
        'cache-control': SNAPSHOT_CACHE_CONTROL,
        'access-control-allow-origin': '*',
      };
      if (ifNoneMatch !== null && weakMatch(ifNoneMatch, etag)) {
        send(304, headers, null);
        return;
      }
      sendJson(200, headers, doc);
    };

    if (method !== 'GET' && method !== 'HEAD') {
      send(405, { allow: 'GET, HEAD' }, null);
      return;
    }

    if (scenario === 'origin-dead' && API_PATHS.has(url.pathname)) {
      send(
        503,
        { 'retry-after': String(ORIGIN_DOWN_RETRY_AFTER_SECONDS), 'cache-control': 'no-store' },
        'origin dead (scripted)',
      );
      return;
    }

    if (url.pathname === DEFAULT_CONFIG.clientConfigUrl) {
      sendJson(
        200,
        { 'cache-control': CLIENT_CONFIG_CACHE_CONTROL, 'access-control-allow-origin': '*' },
        clientConfig(),
      );
      return;
    }

    if (url.pathname === DEFAULT_CONFIG.snapshotUrl) {
      if (scenario === 'origin-down') {
        send(
          503,
          { 'retry-after': String(ORIGIN_DOWN_RETRY_AFTER_SECONDS), 'cache-control': 'no-store' },
          'origin down (scripted)',
        );
        return;
      }
      const after = query[CURSOR_QUERY_PARAM];
      const cursor = after === undefined ? null : Number.parseInt(after, 10);
      const base = cursor === null ? snapshot.current() : snapshot.changesAfter(cursor);
      sendSnapshot(anchoredAt(base, generatedAtMs(now)));
      return;
    }

    if (url.pathname === STATIC_COPY_PATH) {
      // A CDN object: the whole set whatever the query says, and unaffected by the
      // origin being down — that is the point of it.
      sendSnapshot(anchoredAt(snapshot.current(), generatedAtMs(now)));
      return;
    }

    if (url.pathname === DEFAULT_CONFIG.freshnessUrl) {
      sendJson(200, { 'cache-control': 'no-store' }, freshnessReport(now));
      return;
    }

    if (url.pathname === DEFAULT_CONFIG.streamUrl) {
      send(
        503,
        { 'retry-after': String(STREAM_RETRY_AFTER_SECONDS), 'cache-control': 'no-store' },
        'stream not offered',
      );
      return;
    }

    const file = await staticFile(distRoot, url.pathname);
    if (file !== null) {
      send(200, { 'content-type': file.type, 'cache-control': 'no-cache' }, file.body);
      return;
    }
    if (extname(url.pathname) === '') {
      // SPA fallback: `/event/<id>` and friends are routes of the app, not files.
      const index = await readFile(join(distRoot, 'index.html'));
      send(200, { 'content-type': HTML_TYPE, 'cache-control': 'no-cache' }, index);
      return;
    }
    send(404, { 'content-type': 'text/plain; charset=utf-8' }, 'not found');
  };

  const server: Server = createServer((req, res) => {
    handle(req, res).catch((error: unknown) => {
      res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(error instanceof Error ? error.message : String(error));
    });
  });

  await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;

  return {
    baseUrl,
    staticSnapshotUrl: `${baseUrl}${STATIC_COPY_PATH}`,
    requests,
    snapshot,
    servedSnapshot: (nowMs) => anchoredAt(snapshot.current(), generatedAtMs(nowMs)),
    setScenario: (next) => {
      scenario = next;
      if (next === 'stale' && publishingStoppedAtMs === null) {
        publishingStoppedAtMs = clock() - options.staleByMs;
      }
    },
    advertiseStaticSnapshotUrl: (url) => {
      advertisedStaticUrl = url;
    },
    close: () =>
      new Promise<void>((resolveClose, rejectClose) => {
        server.closeAllConnections();
        server.close((error) => (error === undefined ? resolveClose() : rejectClose(error)));
      }),
  };
}

/** RFC 9110 §13.1.2 weak comparison — the client sends the tag back verbatim. */
function weakMatch(ifNoneMatch: string, etag: string): boolean {
  const strip = (tag: string): string => tag.trim().replace(/^W\//, '');
  return ifNoneMatch.split(',').some((candidate) => strip(candidate) === strip(etag));
}

interface StaticFile {
  readonly type: string;
  readonly body: Buffer;
}

/** A file under `distRoot`, or `null`; never anything outside it, whatever the path says. */
async function staticFile(distRoot: string, pathname: string): Promise<StaticFile | null> {
  const relative = normalize(decodeURIComponent(pathname)).replace(/^[/\\]+/, '');
  const absolute = resolve(distRoot, relative);
  if (absolute !== distRoot && !absolute.startsWith(distRoot + sep)) return null;
  try {
    const info = await stat(absolute);
    if (!info.isFile()) return null;
  } catch {
    return null;
  }
  const type = CONTENT_TYPES[extname(absolute)] ?? 'application/octet-stream';
  return { type, body: await readFile(absolute) };
}
