/**
 * The API process end to end (TASKS E1, E2, I1): `startApi` — the same composition
 * `api.ts` runs — on ephemeral ports, against a real PostGIS with every migration applied,
 * exercised over real HTTP rather than `inject`.
 *
 * What the unit suites cannot show: that the snapshot's ETag and cursor come out of the
 * real statement, that a row written to `fire_events` reaches an open stream through the
 * pump, that the probes follow the database when it goes away, that a failing read is a
 * `503` which says nothing about the driver, and that the account surface — mounted on the
 * same server as the probes — answers every refusal with a coded problem document.
 *
 * Skipped when there is no Docker daemon, which is the normal state of a laptop here;
 * `FIRE_WATCH_REQUIRE_DOCKER=1` in CI turns that skip into a failure.
 */

import { execFile, execFileSync } from 'node:child_process';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { PROBLEM_CODES, SOURCE_REGISTRY_VERSION, isProblemCode } from '@fire-watch/contracts';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ACCOUNT_PATH } from '../adapters/http/account-route.js';
import { AUTH_LINK_PATH } from '../adapters/http/auth-route.js';
import { SNAPSHOT_CACHE_CONTROL, SNAPSHOT_PATH } from '../adapters/http/snapshot-route.js';
import { STREAM_PATH } from '../adapters/http/stream-route.js';
import { startApi, type RunningApi } from './api-composition.js';
import type { Environment } from './config.js';
import { STREAM_MAX_PER_CLIENT, STREAM_TICK_MS } from './health-wiring.js';
import { createProcessLog } from './logging.js';

const execFileAsync = promisify(execFile);

const POSTGIS_IMAGE = 'postgis/postgis:16-3.4';
const ORIGIN = 'https://app.example.invalid';
/** The header the limiter keys on here, so each test can be its own client. */
const CLIENT_HEADER = 'x-itest-client';

const serverDir = fileURLToPath(new URL('../../', import.meta.url));
const dbmateBin = fileURLToPath(new URL('../../node_modules/.bin/dbmate', import.meta.url));

function dockerAvailable(): boolean {
  try {
    execFileSync('docker', ['info'], { stdio: 'ignore', timeout: 15_000 });
    return true;
  } catch {
    return false;
  }
}

const hasDocker = dockerAvailable();
if (!hasDocker && process.env['FIRE_WATCH_REQUIRE_DOCKER'] === '1') {
  throw new Error(
    'FIRE_WATCH_REQUIRE_DOCKER=1 but no Docker daemon is reachable. The API process is ' +
      'only ever run against Postgres here, so skipping it in CI is a false green.',
  );
}

/** A port nothing is listening on right now (config refuses port 0). */
async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

function baseEnv(databaseUrl: string, apiPort: number): Record<string, string> {
  return {
    DATABASE_URL: databaseUrl,
    FIRMS_MAP_KEY: '0123456789abcdef0123456789abcdef',
    FIRE_WATCH_API_HOST: '127.0.0.1',
    FIRE_WATCH_API_PORT: String(apiPort),
    FIRE_WATCH_CLIENT_IP_HEADER: CLIENT_HEADER,
  };
}

function authEnv(): Record<string, string> {
  return {
    FIRE_WATCH_AUTH_ENABLED: 'true',
    FIRE_WATCH_AUTH_MAIL_FROM: 'sign-in@auth.example.invalid',
    FIRE_WATCH_AUTH_MAIL_DOMAIN: 'auth.example.invalid',
    FIRE_WATCH_AUTH_LANDING_URL: `${ORIGIN}/sign-in`,
    FIRE_WATCH_AUTH_ALLOWED_ORIGINS: ORIGIN,
    FIRE_WATCH_SES_REGION: 'eu-central-1',
    FIRE_WATCH_SES_ACCESS_KEY_ID: 'AKIAIOSFODNN7EXAMPLE',
    FIRE_WATCH_SES_SECRET_ACCESS_KEY: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
    FIRE_WATCH_SES_FROM_ADDRESS: 'alerts@alerts.example.invalid',
  };
}

interface Booted {
  readonly api: RunningApi;
  readonly base: string;
  readonly lines: string[];
}

async function boot(env: Environment): Promise<Booted> {
  const lines: string[] = [];
  const log = createProcessLog({
    env,
    writeOut: (text) => lines.push(text),
    writeErr: (text) => lines.push(text),
  });
  const api = await startApi(env, log);
  return { api, base: `http://127.0.0.1:${String(env['FIRE_WATCH_API_PORT'])}`, lines };
}

async function waitFor<T>(
  what: string,
  attempt: () => Promise<T | undefined>,
  timeoutMs = 15_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await attempt();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

/** An open SSE response and everything read from it so far. */
interface OpenStream {
  readonly response: Response;
  readonly abort: () => void;
  text: string;
  ended: boolean;
  /** Resolves once `predicate(text)` holds, or rejects after `timeoutMs`. */
  readonly until: (predicate: (text: string) => boolean, timeoutMs?: number) => Promise<string>;
}

async function openStream(url: string, headers: Record<string, string> = {}): Promise<OpenStream> {
  const controller = new AbortController();
  const response = await fetch(url, { headers, signal: controller.signal });
  const waiters: (() => void)[] = [];
  const stream: OpenStream = {
    response,
    abort: () => controller.abort(),
    text: '',
    ended: false,
    until: (predicate, timeoutMs = 10_000) =>
      new Promise((resolve, reject) => {
        const check = (): boolean => {
          if (predicate(stream.text)) {
            clearTimeout(timer);
            resolve(stream.text);
            return true;
          }
          if (stream.ended) {
            clearTimeout(timer);
            reject(new Error(`stream ended before the predicate held:\n${stream.text}`));
            return true;
          }
          return false;
        };
        const timer = setTimeout(
          () => reject(new Error(`stream predicate timed out:\n${stream.text}`)),
          timeoutMs,
        );
        // The reader empties `waiters` on every chunk, so a check that does not hold yet
        // must register itself again: a one-shot waiter would miss every chunk after the
        // next one, and the end of the stream with them.
        const recheck = (): void => {
          if (!check()) waiters.push(recheck);
        };
        recheck();
      }),
  };
  if (response.body !== null && response.status === 200) {
    const reader: ReadableStreamDefaultReader<Uint8Array> = response.body.getReader();
    const decoder = new TextDecoder();
    void (async () => {
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          stream.text += decoder.decode(value, { stream: true });
          for (const waiter of waiters.splice(0)) waiter();
        }
      } catch {
        // Aborted by the test.
      } finally {
        stream.ended = true;
        for (const waiter of waiters.splice(0)) waiter();
      }
    })();
  } else {
    stream.ended = true;
  }
  return stream;
}

describe.skipIf(!hasDocker)('the API process against real PostGIS', () => {
  let container: StartedPostgreSqlContainer;
  let databaseUrl: string;
  let db: Client;
  let off: Booted;
  let offClosed = false;
  let metricsBase: string;
  let seedCounter = 0;

  /** A fresh event on the map; returns its public id and the seq the trigger gave it. */
  async function insertEvent(): Promise<{ publicId: string; seq: number }> {
    seedCounter += 1;
    const publicId = `fw-2026-${seedCounter.toString(36).padStart(5, '0')}`;
    const { rows } = await db.query<{ seq: string }>(
      `INSERT INTO fire_events (public_id, status, status_changed_at, started_at,
         last_detection_at, centroid, score, detection_count, nearest_place, config_version,
         source_registry_version, display_tier, inactive_since)
       VALUES ($1, 'active', now(), now(), now(), ST_SetSRID(ST_MakePoint(24.8, 42.64), 4326),
         0.8, 3, '{"name_bg":"Карлово","name_en":"Karlovo","lat":42.64,"lon":24.8}',
         'clustering_params_v1', $2, 'map', NULL)
       RETURNING seq::text AS seq`,
      [publicId, SOURCE_REGISTRY_VERSION],
    );
    return { publicId, seq: Number(rows[0]?.seq) };
  }

  function client(name: string): Record<string, string> {
    return { [CLIENT_HEADER]: name };
  }

  /**
   * Waits until the pump has read the registry up to `maxSeq`, as the stream itself
   * reports it: the `freshness` frame every connection gets carries the pump's mark.
   */
  async function streamCaughtUpTo(maxSeq: number): Promise<void> {
    await waitFor(`the stream pump to reach seq ${String(maxSeq)}`, async () => {
      const probe = await openStream(`${off.base}${STREAM_PATH}`, client('stream-mark'));
      try {
        const text = await probe.until((t) => /event: freshness\ndata: .*\n\n/.test(t));
        const data = /event: freshness\ndata: (.*)\n\n/.exec(text)?.[1] ?? '{}';
        const mark = (JSON.parse(data) as { max_seq?: number }).max_seq ?? -1;
        return mark >= maxSeq ? true : undefined;
      } finally {
        probe.abort();
      }
    });
  }

  beforeAll(async () => {
    container = await new PostgreSqlContainer(POSTGIS_IMAGE).start();
    databaseUrl = `${container.getConnectionUri()}?sslmode=disable`;
    await execFileAsync(dbmateBin, ['--no-dump-schema', 'up'], {
      cwd: serverDir,
      env: { ...process.env, DATABASE_URL: databaseUrl },
    });
    db = new Client({ connectionString: databaseUrl });
    await db.connect();
    await insertEvent();

    const apiPort = await freePort();
    const metricsPort = await freePort();
    off = await boot({
      ...baseEnv(databaseUrl, apiPort),
      FIRE_WATCH_METRICS_PORT: String(metricsPort),
    });
    metricsBase = `http://127.0.0.1:${String(metricsPort)}`;
    // The first pump tick seeds the stream; until it lands the route refuses with 503.
    await waitFor('the stream pump to seed', async () => {
      const stream = await openStream(`${off.base}${STREAM_PATH}`, client('seed-wait'));
      stream.abort();
      return stream.response.status === 200 ? true : undefined;
    });
  }, 300_000);

  afterAll(async () => {
    if (!offClosed) await off?.api.close();
    await db?.end();
    await container?.stop();
  });

  describe('probes', () => {
    it('answers /healthz and /readyz 200 with no-store while the database is up', async () => {
      for (const path of ['/healthz', '/readyz']) {
        const response = await fetch(`${off.base}${path}`, { headers: client('probes') });
        expect(response.status, path).toBe(200);
        expect(response.headers.get('cache-control'), path).toContain('no-store');
      }
    });

    it('serves /metrics on the internal port only', async () => {
      const metrics = await fetch(`${metricsBase}/metrics`);
      expect(metrics.status).toBe(200);
      expect(await metrics.text()).toMatch(/^fw_/m);
      const publicMetrics = await fetch(`${off.base}/metrics`, { headers: client('metrics') });
      expect(publicMetrics.status).toBe(404);
    });
  });

  describe('snapshot', () => {
    it('serves schema_version 2 with the seq ETag, cache headers and CORS', async () => {
      const response = await fetch(`${off.base}${SNAPSHOT_PATH}`);
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        schema_version: number;
        max_seq: number;
        partial: boolean;
        features: unknown[];
      };
      expect(body.schema_version).toBe(2);
      expect(body.partial).toBe(false);
      expect(body.features.length).toBeGreaterThan(0);
      const { rows } = await db.query<{ max: string }>(
        'SELECT max(seq)::text AS max FROM fire_events',
      );
      expect(body.max_seq).toBe(Number(rows[0]?.max));
      expect(response.headers.get('etag')).toBe(`"v2-${String(body.max_seq)}"`);
      expect(response.headers.get('cache-control')).toBe(SNAPSHOT_CACHE_CONTROL);
      expect(response.headers.get('access-control-allow-origin')).toBe('*');
      expect(response.headers.get('content-type')).toMatch(/^application\/json/);
    });

    it('answers HEAD with the same headers and no body', async () => {
      const get = await fetch(`${off.base}${SNAPSHOT_PATH}`);
      await get.arrayBuffer();
      const head = await fetch(`${off.base}${SNAPSHOT_PATH}`, { method: 'HEAD' });
      expect(head.status).toBe(200);
      expect(head.headers.get('etag')).toBe(get.headers.get('etag'));
      expect(head.headers.get('cache-control')).toBe(SNAPSHOT_CACHE_CONTROL);
      expect((await head.arrayBuffer()).byteLength).toBe(0);
    });

    it('answers 304 on a matching If-None-Match, strong or weak, and 200 once seq moves', async () => {
      const first = await fetch(`${off.base}${SNAPSHOT_PATH}`);
      await first.arrayBuffer();
      const etag = first.headers.get('etag') ?? '';
      for (const tag of [etag, `W/${etag}`, `"v2-0", ${etag}`]) {
        const cached = await fetch(`${off.base}${SNAPSHOT_PATH}`, {
          headers: { 'if-none-match': tag },
        });
        expect(cached.status, tag).toBe(304);
        expect(cached.headers.get('etag')).toBe(etag);
        expect(cached.headers.get('cache-control')).toBe(SNAPSHOT_CACHE_CONTROL);
      }
      const { seq } = await insertEvent();
      const moved = await fetch(`${off.base}${SNAPSHOT_PATH}`, {
        headers: { 'if-none-match': etag },
      });
      expect(moved.status).toBe(200);
      expect(moved.headers.get('etag')).toBe(`"v2-${String(seq)}"`);
      await moved.arrayBuffer();
    });

    it('serves a partial delta above the cursor', async () => {
      const before = (await (await fetch(`${off.base}${SNAPSHOT_PATH}`)).json()) as {
        max_seq: number;
      };
      const { publicId, seq } = await insertEvent();
      const delta = await fetch(
        `${off.base}${SNAPSHOT_PATH}?updated_after_seq=${String(before.max_seq)}`,
      );
      expect(delta.status).toBe(200);
      const body = (await delta.json()) as {
        partial: boolean;
        max_seq: number;
        features: { properties: { id?: string; public_id?: string } }[];
      };
      expect(body.partial).toBe(true);
      expect(body.max_seq).toBe(seq);
      expect(body.features).toHaveLength(1);
      expect(JSON.stringify(body.features[0])).toContain(publicId);
    });

    it.each([
      ['an unknown parameter', '?bbox=1,2,3,4'],
      ['a non-integer cursor', '?updated_after_seq=abc'],
      ['a negative cursor', '?updated_after_seq=-1'],
      ['a repeated cursor', '?updated_after_seq=1&updated_after_seq=2'],
    ])('refuses %s with a 400 problem document', async (_name, query) => {
      const response = await fetch(`${off.base}${SNAPSHOT_PATH}${query}`);
      expect(response.status).toBe(400);
      expect(response.headers.get('content-type')).toMatch(/^application\/problem\+json/);
      expect(response.headers.get('cache-control')).toContain('no-store');
      const body = (await response.json()) as Record<string, unknown>;
      expect(body['status']).toBe(400);
      expect(body['instance']).toBe(SNAPSHOT_PATH);
      expect(typeof body['correlation_id']).toBe('string');
    });
  });

  describe('stream', () => {
    it('opens with retry, a reset for no cursor, and the SSE headers', async () => {
      const stream = await openStream(`${off.base}${STREAM_PATH}`, client('stream-open'));
      try {
        expect(stream.response.status).toBe(200);
        expect(stream.response.headers.get('content-type')).toMatch(/^text\/event-stream/);
        expect(stream.response.headers.get('cache-control')).toBe('no-cache, no-transform');
        expect(stream.response.headers.get('x-accel-buffering')).toBe('no');
        expect(stream.response.headers.get('access-control-allow-origin')).toBe('*');
        const text = await stream.until((t) => t.includes('event: reset'));
        expect(text.startsWith('retry: 5000\n\n')).toBe(true);
      } finally {
        stream.abort();
      }
    });

    it('delivers a row written to fire_events as event.created, then replays it by Last-Event-ID', async () => {
      const snapshot = (await (await fetch(`${off.base}${SNAPSHOT_PATH}`)).json()) as {
        max_seq: number;
      };
      // The snapshot reads the registry directly; the stream only knows what the pump has
      // read, once per STREAM_TICK_MS. The snapshot tests above insert rows just before
      // this one, so a cursor taken from the snapshot can be ahead of the ring for up to
      // one tick, and the product answers such a cursor with `reset` (reason `unknown`,
      // frame-ring.ts) by design. That is not what this test is about — it proves the
      // pump delivers a new row and the ring replays it — so it waits for the pump to
      // catch up with the snapshot first, and the no-reset assertion below stays as is.
      await streamCaughtUpTo(snapshot.max_seq);
      const stream = await openStream(
        `${off.base}${STREAM_PATH}?last_event_id=${String(snapshot.max_seq)}`,
        client('stream-live'),
      );
      let seq = 0;
      try {
        expect(stream.response.status).toBe(200);
        // Connected before the write, so the frame can only come from the pump.
        await stream.until((t) => t.startsWith('retry: 5000\n\n') && t.length > 14);
        expect(stream.text).not.toContain('event: reset');
        const inserted = await insertEvent();
        seq = inserted.seq;
        const text = await stream.until(
          (t) => t.includes(`id: ${String(seq)}\n`),
          STREAM_TICK_MS * 5,
        );
        const frame = text.slice(text.indexOf(`id: ${String(seq)}\n`));
        expect(frame).toMatch(new RegExp(`^id: ${String(seq)}\nevent: event\\.created\ndata: `));
        expect(frame.split('\n\n')[0]).toContain(inserted.publicId);
      } finally {
        stream.abort();
      }

      const resumed = await openStream(`${off.base}${STREAM_PATH}`, {
        ...client('stream-resume'),
        'last-event-id': String(seq - 1),
      });
      try {
        const text = await resumed.until((t) => t.includes(`id: ${String(seq)}\n`));
        expect(text).not.toContain('event: reset');
      } finally {
        resumed.abort();
      }
    });

    it('refuses an unknown query parameter with 400', async () => {
      const response = await fetch(`${off.base}${STREAM_PATH}?since=1`, {
        headers: client('stream-400'),
      });
      expect(response.status).toBe(400);
      expect(response.headers.get('content-type')).toMatch(/^application\/problem\+json/);
    });

    it('refuses the stream past the per-client cap with 429 and Retry-After 60', async () => {
      const open: OpenStream[] = [];
      try {
        for (let i = 0; i < STREAM_MAX_PER_CLIENT; i += 1) {
          const stream = await openStream(`${off.base}${STREAM_PATH}`, client('stream-cap'));
          open.push(stream);
          expect(stream.response.status).toBe(200);
        }
        const refused = await fetch(`${off.base}${STREAM_PATH}`, { headers: client('stream-cap') });
        expect(refused.status).toBe(429);
        expect(refused.headers.get('retry-after')).toBe('60');
        expect(refused.headers.get('content-type')).toMatch(/^application\/problem\+json/);
        await refused.arrayBuffer();
        // Another client is not affected.
        const other = await openStream(`${off.base}${STREAM_PATH}`, client('stream-cap-other'));
        open.push(other);
        expect(other.response.status).toBe(200);
      } finally {
        for (const stream of open) stream.abort();
      }
    });
  });

  describe('account surface with auth off', () => {
    it.each([
      ['GET', ACCOUNT_PATH],
      ['POST', AUTH_LINK_PATH],
    ])('%s %s is not served', async (method, path) => {
      const response = await fetch(`${off.base}${path}`, {
        method,
        headers: { ...client('auth-off'), origin: ORIGIN, 'content-type': 'application/json' },
        ...(method === 'POST' ? { body: '{}' } : {}),
      });
      expect(response.status).toBe(404);
    });
  });

  describe('account surface with auth on', () => {
    let on: Booted;

    beforeAll(async () => {
      on = await boot({ ...baseEnv(databaseUrl, await freePort()), ...authEnv() });
    });

    afterAll(async () => {
      await on?.api.close();
    });

    async function expectCoded(response: Response, status: number, code: string): Promise<void> {
      expect(response.status).toBe(status);
      expect(response.headers.get('content-type')).toMatch(/^application\/problem\+json/);
      expect(response.headers.get('cache-control')).toContain('no-store');
      const body = (await response.json()) as Record<string, unknown>;
      expect(body['status']).toBe(status);
      expect(isProblemCode(body['code']), JSON.stringify(body)).toBe(true);
      expect(body['code']).toBe(code);
    }

    it('answers a sign-in request without an allowed Origin with origin_refused', async () => {
      const response = await fetch(`${on.base}${AUTH_LINK_PATH}`, {
        method: 'POST',
        headers: { ...client('auth-origin'), 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'someone@example.org' }),
      });
      await expectCoded(response, 403, 'origin_refused');
    });

    it('answers a malformed body with invalid_body', async () => {
      const response = await fetch(`${on.base}${AUTH_LINK_PATH}`, {
        method: 'POST',
        headers: { ...client('auth-body'), origin: ORIGIN, 'content-type': 'application/json' },
        body: JSON.stringify({ nope: true }),
      });
      await expectCoded(response, 400, 'invalid_body');
    });

    it('answers GET /api/v1/account without a session with not_signed_in', async () => {
      const response = await fetch(`${on.base}${ACCOUNT_PATH}`, { headers: client('auth-me') });
      await expectCoded(response, 401, 'not_signed_in');
    });

    it('answers every refusal on the account surface with a code, the rate limit included', async () => {
      // Past any per-client request budget: whatever refuses the caller, the account
      // surface's contract (PROBLEM_CODES) is a coded problem document.
      const seen = new Set<number>();
      for (let i = 0; i < 80; i += 1) {
        const response = await fetch(`${on.base}${ACCOUNT_PATH}`, {
          headers: client('auth-flood'),
        });
        seen.add(response.status);
        expect(response.headers.get('content-type'), `request ${String(i)}`).toMatch(
          /^application\/problem\+json/,
        );
        const body = (await response.json()) as Record<string, unknown>;
        expect(PROBLEM_CODES as readonly unknown[], JSON.stringify(body)).toContain(body['code']);
        if (response.status === 429) {
          expect(body['code']).toBe('rate_limited');
          expect(Number(response.headers.get('retry-after'))).toBeGreaterThan(0);
        }
      }
      expect(seen.has(401)).toBe(true);
    });
  });

  describe('database failures', () => {
    it('answers a failed snapshot read with 503 + Retry-After and no driver detail', async () => {
      await db.query('REVOKE SELECT ON fire_events FROM fire_watch_app');
      try {
        const response = await fetch(`${off.base}${SNAPSHOT_PATH}`);
        expect(response.status).toBe(503);
        expect(response.headers.get('retry-after')).toBe('5');
        expect(response.headers.get('content-type')).toMatch(/^application\/problem\+json/);
        expect(response.headers.get('cache-control')).toContain('no-store');
        const text = await response.text();
        for (const leak of [
          'permission',
          'fire_events',
          'fire_watch_app',
          '42501',
          container.getPassword(),
          container.getHost() + ':' + String(container.getPort()),
        ]) {
          expect(text, leak).not.toContain(leak);
        }
        const body = JSON.parse(text) as Record<string, unknown>;
        const correlationId = body['correlation_id'];
        expect(typeof correlationId).toBe('string');
        // The operator's side: the same id in the log, with the redacted cause.
        const logged = off.lines.find((line) => line.includes(String(correlationId)));
        expect(logged).toBeDefined();
        expect(logged).toContain('503');
      } finally {
        await db.query('GRANT SELECT ON fire_events TO fire_watch_app');
      }
      const recovered = await fetch(`${off.base}${SNAPSHOT_PATH}`);
      expect(recovered.status).toBe(200);
      await recovered.arrayBuffer();
    });

    it('turns /readyz and the snapshot to 503 while the database is paused, /healthz stays 200', async () => {
      await execFileAsync('docker', ['pause', container.getId()]);
      try {
        const started = Date.now();
        const ready = await fetch(`${off.base}/readyz`, {
          headers: client('paused'),
          signal: AbortSignal.timeout(15_000),
        });
        expect(ready.status).toBe(503);
        expect(Date.now() - started).toBeLessThan(10_000);
        await ready.arrayBuffer();

        const snapshotStarted = Date.now();
        const snapshot = await fetch(`${off.base}${SNAPSHOT_PATH}`, {
          signal: AbortSignal.timeout(15_000),
        });
        expect(snapshot.status).toBe(503);
        expect(snapshot.headers.get('retry-after')).not.toBeNull();
        expect(Date.now() - snapshotStarted).toBeLessThan(10_000);
        await snapshot.arrayBuffer();

        const live = await fetch(`${off.base}/healthz`, { headers: client('paused') });
        expect(live.status).toBe(200);
        await live.arrayBuffer();
      } finally {
        await execFileAsync('docker', ['unpause', container.getId()]);
      }
      await waitFor('/readyz to recover', async () => {
        const response = await fetch(`${off.base}/readyz`, { headers: client('recovered') });
        await response.arrayBuffer();
        return response.status === 200 ? true : undefined;
      });
    });
  });

  describe('shutdown', () => {
    it('tells an open stream when to come back and closes it', async () => {
      const stream = await openStream(`${off.base}${STREAM_PATH}`, client('shutdown'));
      expect(stream.response.status).toBe(200);
      await stream.until((t) => t.includes('event: reset'));
      const before = stream.text.length;
      offClosed = true;
      await off.api.close();
      await stream.until((t) => t.length > before && /retry: \d+\n\n$/.test(t) && stream.ended);
      expect(stream.ended).toBe(true);
    });
  });
});
