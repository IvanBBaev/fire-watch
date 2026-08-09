import type { FreshnessReport, FreshnessRowId } from '@fire-watch/contracts';
import { describe, expect, it } from 'vitest';

import type { FreshnessObservation } from '../../core/health/freshness.js';
import { VirtualClock } from '../../core/ports/clock.js';
import type { DatabaseProbe, FreshnessReader } from '../../core/ports/freshness-reader.js';
import { createHealthServer, type HealthServerDeps } from './health-server.js';

const NOW = '2026-08-02T12:00:00Z';
const MINUTE = 60_000;

const EXPECTED: readonly FreshnessRowId[] = [
  'firms:viirs:snpp',
  'firms:viirs:noaa20',
  'firms:viirs:noaa21',
];

/** A source that answered `minutesAgo` minutes before {@link NOW}. */
function seen(row: FreshnessRowId, minutesAgo: number): FreshnessObservation {
  const at = Date.parse(NOW) - minutesAgo * MINUTE;
  return { row, lastAttemptAt: at, lastSuccessAt: at, lastDataAt: at, consecutiveFailures: 0 };
}

function fresh(): readonly FreshnessObservation[] {
  return EXPECTED.map((row) => seen(row, 3));
}

function reader(observations: readonly FreshnessObservation[]): FreshnessReader {
  return { readObservations: () => Promise.resolve(observations) };
}

function failingReader(error: Error): FreshnessReader {
  return { readObservations: () => Promise.reject(error) };
}

const healthyProbe: DatabaseProbe = { ping: () => Promise.resolve() };

/**
 * A reader and a probe that fail the test if they are touched at all — the liveness route
 * must answer from memory, and a probe wired to a dependency turns a five-minute database
 * hiccup into a crash loop.
 */
const forbidden = {
  reader: {
    readObservations: () => Promise.reject(new Error('the database must not be touched here')),
  } satisfies FreshnessReader,
  probe: {
    ping: () => Promise.reject(new Error('the database must not be touched here')),
  } satisfies DatabaseProbe,
};

function server(overrides: Partial<HealthServerDeps> = {}): ReturnType<typeof createHealthServer> {
  return createHealthServer({
    reader: reader(fresh()),
    probe: healthyProbe,
    clock: new VirtualClock(NOW),
    expected: EXPECTED,
    ...overrides,
  });
}

describe('GET /healthz', () => {
  it('answers from memory, without the database', async () => {
    const app = server({ reader: forbidden.reader, probe: forbidden.probe });

    const response = await app.inject({ method: 'GET', url: '/healthz' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok' });
  });
});

describe('GET /readyz', () => {
  it('is ready when the database answers', async () => {
    const response = await server().inject({ method: 'GET', url: '/readyz' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok' });
  });

  it('is 503, not 500, when it cannot reach the database', async () => {
    // Readiness pulls the box out of rotation; it does not ask for a restart.
    const app = server({ probe: { ping: () => Promise.reject(new Error('ECONNREFUSED')) } });

    const response = await app.inject({ method: 'GET', url: '/readyz' });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ status: 'unavailable' });
    expect(response.payload).not.toContain('ECONNREFUSED');
  });
});

describe('GET /api/health/freshness', () => {
  it('is 200 and ok while every source is inside its budget', async () => {
    const response = await server().inject({ method: 'GET', url: '/api/health/freshness' });
    const report = response.json<FreshnessReport>();

    expect(response.statusCode).toBe(200);
    expect(report.status).toBe('ok');
    expect(report.rows).toHaveLength(3);
    expect(report.budgetVersion).toBe('freshness_budgets_v1');
    expect(report.generatedAt).toBe('2026-08-02T12:00:00.000Z');
  });

  it('is still 200 when a source is only late', async () => {
    // Warn is for the dashboard and the banner. Paging on it is how a rota learns to
    // ignore the pager — the FIRMS API is routinely slow for one cycle.
    const observations = [seen('firms:viirs:snpp', 25), seen('firms:viirs:noaa20', 3)];
    const response = await server({ reader: reader(observations) }).inject({
      method: 'GET',
      url: '/api/health/freshness',
    });
    const report = response.json<FreshnessReport>();

    expect(response.statusCode).toBe(200);
    expect(report.status).toBe('warn');
    expect(report.rows[0]).toMatchObject({ row: 'firms:viirs:snpp', state: 'warn' });
  });

  it('is 500 with the offending row first once a paging source is past critical', async () => {
    // This is the whole point of C5: killing a poller has to page inside the budget, and
    // the external prober only ever sees the status code.
    const observations = [
      seen('firms:viirs:snpp', 3),
      seen('firms:viirs:noaa20', 3),
      seen('firms:viirs:noaa21', 90),
    ];
    const response = await server({ reader: reader(observations) }).inject({
      method: 'GET',
      url: '/api/health/freshness',
    });
    const report = response.json<FreshnessReport>();

    expect(response.statusCode).toBe(500);
    expect(report.status).toBe('critical');
    expect(report.rows[0]).toMatchObject({
      row: 'firms:viirs:noaa21',
      state: 'critical',
      pages: true,
    });
  });

  it('is 500 with a reason when the query times out, never a hang', async () => {
    // A database that cannot answer within the statement timeout is itself the outage.
    const timeout = Object.assign(new Error('canceling statement due to statement timeout'), {
      code: '57014',
    });
    const response = await server({ reader: failingReader(timeout) }).inject({
      method: 'GET',
      url: '/api/health/freshness',
    });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({ status: 'critical', reason: 'freshness_query_timeout' });
  });

  it('distinguishes a refusal from a timeout, because the first move differs', async () => {
    // "What is holding the lock" versus "is Postgres running" — that distinction is the
    // entire information content a probe body owes.
    const response = await server({
      reader: failingReader(new Error('connect ECONNREFUSED 10.0.0.5:5432')),
    }).inject({ method: 'GET', url: '/api/health/freshness' });

    expect(response.json()).toEqual({ status: 'critical', reason: 'freshness_query_failed' });
    expect(response.payload).not.toContain('10.0.0.5');
  });

  it('is never cached, by the browser or by the CDN', async () => {
    // A cached 200 from four minutes ago is exactly the answer an outage would like the
    // prober to see. Cloudflare honours its own header in preference to `Cache-Control`.
    const response = await server().inject({ method: 'GET', url: '/api/health/freshness' });

    expect(response.headers['cache-control']).toBe('no-store, max-age=0');
    expect(response.headers['cdn-cache-control']).toBe('no-store');
    expect(response.headers['cloudflare-cdn-cache-control']).toBe('no-store');
  });

  it('asks the reader about exactly the rows this deployment claims to run', async () => {
    // The reader scopes its query by `expected`; a fake that ignores the argument would
    // let the route silently pass nothing and still look green in every other test here.
    const asked: (readonly FreshnessRowId[])[] = [];
    const recording: FreshnessReader = {
      readObservations: (rows) => {
        asked.push(rows);
        return Promise.resolve(fresh());
      },
    };

    await server({ reader: recording }).inject({ method: 'GET', url: '/api/health/freshness' });

    expect(asked).toEqual([EXPECTED]);
  });

  it('leaks nothing beyond row ids, budgets and timestamps', async () => {
    const report = (await server().inject({ method: 'GET', url: '/api/health/freshness' })).json<
      Record<string, unknown>
    >();

    expect(Object.keys(report).toSorted()).toEqual([
      'budgetVersion',
      'generatedAt',
      'rows',
      'status',
    ]);
  });
});

describe('the routes that are deliberately absent', () => {
  it('does not alias the superseded freshness path', async () => {
    // Two paths mean two sets of Grafana rules, CDN rules and UptimeRobot monitors to keep
    // in agreement forever, and the day they disagree is the day one of them is quietly
    // green (OPERATIONS §2.1).
    const response = await server().inject({ method: 'GET', url: '/api/v1/meta/freshness' });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ status: 'not_found' });
  });

  it('tells a scanner nothing it did not already know', async () => {
    const response = await server().inject({ method: 'GET', url: '/.env' });

    expect(response.statusCode).toBe(404);
    expect(response.payload).not.toContain('.env');
  });

  it('turns an unexpected failure into a body with no stack trace in it', async () => {
    // An `expected` row with no budget is a config bug, and a loud one — but the shape of
    // the loudness is a log line, never a 500 body quoting our internals.
    const app = server({ expected: ['firms:modis' as FreshnessRowId] });

    const response = await app.inject({ method: 'GET', url: '/api/health/freshness' });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({ status: 'error' });
    expect(response.payload).not.toContain('firms:modis');
  });

  it('keeps the no-store headers on a 404', async () => {
    // A CDN that caches a 404 for a path that is registered tomorrow serves yesterday's
    // absence; the probe surface promises no-store on *every* answer.
    const response = await server().inject({ method: 'GET', url: '/api/v1/meta/freshness' });

    expect(response.statusCode).toBe(404);
    expect(response.headers['cache-control']).toBe('no-store, max-age=0');
    expect(response.headers['cdn-cache-control']).toBe('no-store');
  });

  it('refuses a URL too malformed to route, without quoting it back', async () => {
    // A broken percent-escape never reaches the router: Fastify answers it from its
    // onBadUrl path, which skips the hooks, the not-found handler and the error handler
    // alike — and whose built-in reply quotes the offending URL back at the sender. The
    // `frameworkErrors` handler owns that path, so the answer keeps this file's rules:
    // fixed vocabulary, no-store set by hand because no hook ran to set it.
    const response = await server().inject({ method: 'GET', url: '/%c0' });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ status: 'bad_request' });
    expect(response.headers['cache-control']).toBe('no-store, max-age=0');
    expect(response.headers['cdn-cache-control']).toBe('no-store');
    expect(response.headers['cloudflare-cdn-cache-control']).toBe('no-store');
    expect(response.payload).not.toContain('%c0');
  });

  it('reports an oversized body as the client fault it is, never a 500', async () => {
    // bodyLimit is 1024 because a probe body is small and fixed. Flattening the 413 into
    // a 500 would page a 5xx-alerting monitor for something a caller did.
    const response = await server().inject({
      method: 'POST',
      url: '/readyz',
      headers: { 'content-type': 'application/json' },
      payload: `{"filler":"${'x'.repeat(2048)}"}`,
    });

    expect(response.statusCode).toBe(413);
    expect(response.json()).toEqual({ status: 'bad_request' });
  });
});

describe('the rate limit', () => {
  it('refuses a caller that will not stop, and says for how long', async () => {
    // The endpoint is unauthenticated by design (§2.2 rule 6) and costs a database round
    // trip, so the limit is what stops a curious script from tapping the pool.
    const app = server({ rateLimit: { limit: 2, windowMs: 60_000 } });

    const first = await app.inject({ method: 'GET', url: '/readyz' });
    const second = await app.inject({ method: 'GET', url: '/readyz' });
    const third = await app.inject({ method: 'GET', url: '/readyz' });

    expect([first.statusCode, second.statusCode]).toEqual([200, 200]);
    expect(third.statusCode).toBe(429);
    expect(third.json()).toEqual({ status: 'rate_limited' });
    expect(third.headers['retry-after']).toBe('60');
  });

  it('keeps the no-store headers on the refusal too', async () => {
    // Otherwise a CDN caches the 429 and the endpoint stays refused after the window ends.
    const app = server({ rateLimit: { limit: 1, windowMs: 60_000 } });

    await app.inject({ method: 'GET', url: '/readyz' });
    const refused = await app.inject({ method: 'GET', url: '/readyz' });

    expect(refused.statusCode).toBe(429);
    expect(refused.headers['cache-control']).toBe('no-store, max-age=0');
  });

  it('does not reach the database for a request it is going to refuse', async () => {
    const app = server({ rateLimit: { limit: 1, windowMs: 60_000 }, reader: forbidden.reader });

    await app.inject({ method: 'GET', url: '/readyz' });
    const refused = await app.inject({ method: 'GET', url: '/api/health/freshness' });

    expect(refused.statusCode).toBe(429);
  });

  it('never refuses liveness, however exhausted the limit is', async () => {
    // A 429'd liveness probe turns a harmless flood into a restart loop — the exact
    // failure /healthz exists to prevent. Only the routes that cost something pay.
    const app = server({ rateLimit: { limit: 1, windowMs: 60_000 } });

    await app.inject({ method: 'GET', url: '/readyz' });
    const refused = await app.inject({ method: 'GET', url: '/readyz' });
    const liveness = await app.inject({ method: 'GET', url: '/healthz' });

    expect(refused.statusCode).toBe(429);
    expect(liveness.statusCode).toBe(200);
    expect(liveness.json()).toEqual({ status: 'ok' });
  });

  it('ignores X-Forwarded-For: the key is the socket, not a header the caller writes', async () => {
    // No edge header is configured here, so there is no proxy whose word can be taken —
    // a spoofed X-Forwarded-For must not mint a fresh bucket per request.
    const app = server({ rateLimit: { limit: 1, windowMs: 60_000 } });

    const first = await app.inject({
      method: 'GET',
      url: '/readyz',
      headers: { 'x-forwarded-for': '198.51.100.1' },
    });
    const second = await app.inject({
      method: 'GET',
      url: '/readyz',
      headers: { 'x-forwarded-for': '198.51.100.2' },
    });

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(429);
  });

  it('keys on the configured edge header, one bucket per client', async () => {
    // `cf-connecting-ip` is overwritten by our own edge, and the firewall guarantees
    // nothing else reaches the port — so distinct values really are distinct callers.
    const app = server({
      rateLimit: { limit: 1, windowMs: 60_000 },
      clientIpHeader: 'cf-connecting-ip',
    });

    const alice = await app.inject({
      method: 'GET',
      url: '/readyz',
      headers: { 'cf-connecting-ip': '203.0.113.7' },
    });
    const bob = await app.inject({
      method: 'GET',
      url: '/readyz',
      headers: { 'cf-connecting-ip': '203.0.113.8' },
    });
    const aliceAgain = await app.inject({
      method: 'GET',
      url: '/readyz',
      headers: { 'cf-connecting-ip': '203.0.113.7' },
    });

    expect(alice.statusCode).toBe(200);
    expect(bob.statusCode).toBe(200);
    expect(aliceAgain.statusCode).toBe(429);
  });

  it('falls back to the socket address when the edge header is absent', async () => {
    // Loopback traffic — the supervisor's probe, a curl over SSH — never went through
    // the edge, and it still has to be keyed by something.
    const app = server({
      rateLimit: { limit: 1, windowMs: 60_000 },
      clientIpHeader: 'cf-connecting-ip',
    });

    const first = await app.inject({ method: 'GET', url: '/readyz' });
    const second = await app.inject({ method: 'GET', url: '/readyz' });

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(429);
  });
});

describe('the in-flight cap', () => {
  it('sheds load above eight concurrent database requests instead of queueing', async () => {
    // The health pool holds two connections behind a one-second acquire timeout, and the
    // limiter is per-client — only an aggregate cap stops a distributed burst from
    // stacking sockets behind the pool. Deferred promises, not timers: the test decides
    // when the reader answers.
    const releases: (() => void)[] = [];
    let allEntered: (() => void) | undefined;
    const entered = new Promise<void>((resolve) => {
      allEntered = resolve;
    });
    // Defers only while the burst is being staged. The post-drain request at the bottom
    // must answer immediately: left deferring, it would park on a promise nobody is left
    // to release, and the test would hang on its own scaffolding rather than exercise
    // the cap.
    let deferring = true;
    const stuckReader: FreshnessReader = {
      readObservations: () => {
        if (!deferring) return Promise.resolve(fresh());
        return new Promise((resolve) => {
          releases.push(() => {
            resolve(fresh());
          });
          if (releases.length === 8) allEntered?.();
        });
      },
    };
    const app = server({ reader: stuckReader });

    // `inject` without a callback returns light-my-request's lazy chain — a thenable
    // that dispatches when something subscribes (or on its own next-tick autostart).
    // `Promise.resolve` subscribes now, so the eight requests are in flight by explicit
    // choice rather than by a library default, held as plain promises for later.
    const stuck = Array.from({ length: 8 }, () =>
      Promise.resolve(app.inject({ method: 'GET', url: '/api/health/freshness' })),
    );
    // Resolves only once all eight handlers hold the counter: the ninth request below is
    // fired against a server that is provably full, not racing to become full.
    await entered;

    const ninth = await app.inject({ method: 'GET', url: '/api/health/freshness' });
    expect(ninth.statusCode).toBe(503);
    expect(ninth.json()).toEqual({ status: 'unavailable' });
    // Shed from memory: the ninth never reached the reader at all.
    expect(releases).toHaveLength(8);

    for (const release of releases) release();
    const answered = await Promise.all(stuck);
    expect(answered.map((response) => response.statusCode)).toEqual(
      Array.from({ length: 8 }, () => 200),
    );

    // The cap is a counter, not a state: once the burst drains, the next caller is served.
    deferring = false;
    const after = await app.inject({ method: 'GET', url: '/api/health/freshness' });
    expect(after.statusCode).toBe(200);
  });
});
