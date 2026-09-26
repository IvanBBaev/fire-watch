import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ClientConfig } from '../config.js';
import type { Clock, Rng } from '../ports.js';
import type { FeedMessage, FeedStatus, PollOutcome } from '../types.js';
import { REQUEST_TIMEOUT_MS, createPollingFeed, parseFreshnessReport } from './polling-feed.js';
import type { ServerTimeTracker } from './server-time.js';

const BASE_EPOCH = '2026-08-09T10:00:00Z';

const CONFIG: ClientConfig = {
  snapshotUrl: '/snapshot.json',
  detectionsUrlTemplate: null,
  freshnessUrl: '/api/health/freshness',
  pollIntervalMs: 10_000,
  pollJitterRatio: 0.2,
  freshnessPollIntervalMs: 60_000,
  basemapStyleUrl: { light: 'light-style', dark: 'dark-style' },
  streamUrl: '/api/v1/stream',
  clientConfigUrl: '/api/v1/client-config',
  sseEnabled: false,
  safetySnapshotIntervalMs: 600_000,
  sseReofferHysteresisMs: 30 * 60_000,
  staticFlipStaleMs: 5 * 60_000,
  staticSnapshotUrl: null,
};

const STATIC_URL = '/static/snapshot.json';
const FULL_URL = '/snapshot.json';
const cursorUrl = (mark: number): string => `/snapshot.json?updated_after_seq=${mark}`;

/** Marker body: `json()` rejects like a real unparseable response would. */
const INVALID_JSON = Symbol('invalid-json');

/**
 * A microtask-only Response stand-in. The real `Response` reads its body through
 * streams whose scheduling is runtime-dependent; this one settles purely on the
 * promise queue, which keeps the fake-timer flow deterministic.
 */
function fakeResponse(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response {
  const map = new Map(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (name: string) => map.get(name.toLowerCase()) ?? null },
    json: () =>
      body === INVALID_JSON
        ? Promise.reject(new SyntaxError('unexpected token'))
        : Promise.resolve(body),
    arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
  } as unknown as Response;
}

/** Minimal valid wire snapshot (one feature), matching the fixture schema. */
function wireBody(): Record<string, unknown> {
  return {
    type: 'FeatureCollection',
    schema_version: 1,
    generated_at: '2026-08-09T09:58:00Z',
    max_seq: 42,
    partial: false,
    sources: [{ source_id: 'firms:viirs:snpp', last_observed_at: '2026-08-09T00:52:00Z' }],
    features: [
      {
        type: 'Feature',
        id: 'fw-2026-q7f3d',
        geometry: { type: 'Point', coordinates: [25.9, 41.93] },
        properties: {
          id: 'fw-2026-q7f3d',
          seq: 42,
          status: 'active',
          score_bucket: 'confirmed',
          merged_into: null,
          first_observed_at: '2026-08-07T11:14:00Z',
          last_observed_at: '2026-08-09T09:47:00Z',
          detection_count: 14,
          place_name_bg: 'Харманли',
          place_name_en: 'Harmanli',
          area_ha: 320,
          next_pass_window: null,
        },
      },
    ],
  };
}

/** A cursor answer: `partial: true`, no features, the given high-water mark. */
function partialBody(maxSeq: number): Record<string, unknown> {
  return { ...wireBody(), partial: true, max_seq: maxSeq, features: [] };
}

function freshnessBody(status: 'ok' | 'warn' | 'critical'): unknown {
  return {
    generatedAt: '2026-08-09T10:00:00Z',
    status,
    budgetVersion: '2026-08-01',
    rows: [
      {
        row: 'firms:viirs:snpp',
        lastSuccessAt: '2026-08-09T00:52:00Z',
        lastDataAt: '2026-08-09T00:52:00Z',
        ageSeconds: 33_000,
        warnSeconds: 21_600,
        criticalSeconds: 28_800,
        state: status,
        consecutiveFailures: status === 'ok' ? 0 : 4,
        pages: true,
        mutedUntil: null,
        muteReason: null,
      },
    ],
  };
}

const dateHeader = (): string => new Date(Date.now()).toUTCString();

const okSnapshot = (etag = '"v1"'): Response =>
  fakeResponse(200, wireBody(), { etag, date: dateHeader() });

const partialSnapshot = (maxSeq: number, etag = '"c1"'): Response =>
  fakeResponse(200, partialBody(maxSeq), { etag, date: dateHeader() });

const notModified = (): Response => fakeResponse(304, null, { date: dateHeader() });

interface RecordedCall {
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly atMs: number;
}

type Handler = (call: RecordedCall) => Response | Promise<Response>;

function fetchStub(): {
  fetchFn: typeof fetch;
  snapshotCalls: () => RecordedCall[];
  freshnessCalls: () => RecordedCall[];
  setSnapshot: (handler: Handler) => void;
  setFreshness: (handler: Handler) => void;
} {
  const calls: RecordedCall[] = [];
  let snapshotHandler: Handler = () => okSnapshot();
  let freshnessHandler: Handler = () => fakeResponse(200, freshnessBody('ok'));
  const fetchFn: typeof fetch = (input, init) => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const call: RecordedCall = {
      url,
      headers: { ...((init?.headers ?? {}) as Record<string, string>) },
      atMs: Date.now(),
    };
    calls.push(call);
    const handler = url.includes('freshness') ? freshnessHandler : snapshotHandler;
    return Promise.resolve(handler(call));
  };
  return {
    fetchFn,
    snapshotCalls: () => calls.filter((call) => !call.url.includes('freshness')),
    freshnessCalls: () => calls.filter((call) => call.url.includes('freshness')),
    setSnapshot: (handler) => {
      snapshotHandler = handler;
    },
    setFreshness: (handler) => {
      freshnessHandler = handler;
    },
  };
}

/** Drain the promise microtask queue without moving the fake clock. */
async function flush(): Promise<void> {
  for (let i = 0; i < 25; i += 1) await Promise.resolve();
}

async function advance(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
  await flush();
}

interface SetupOptions {
  readonly rng?: number;
  readonly config?: Partial<ClientConfig>;
  readonly serverTime?: ServerTimeTracker;
}

function setup(options: SetupOptions = {}): {
  stub: ReturnType<typeof fetchStub>;
  feed: ReturnType<typeof createPollingFeed>;
  statuses: FeedStatus[];
  messages: FeedMessage[];
  outcomes: PollOutcome[];
} {
  const stub = fetchStub();
  const clock: Clock = { epochNow: () => Date.now(), monotonicNow: () => Date.now() };
  const rng: Rng = { next: () => options.rng ?? 0.5 };
  const feed = createPollingFeed({
    config: { ...CONFIG, ...options.config },
    clock,
    rng,
    fetchFn: stub.fetchFn,
    ...(options.serverTime === undefined ? {} : { serverTime: options.serverTime }),
  });
  const statuses: FeedStatus[] = [];
  const messages: FeedMessage[] = [];
  const outcomes: PollOutcome[] = [];
  feed.onStatus((status) => statuses.push(status));
  feed.onMessage((message) => messages.push(message));
  feed.onOutcome((outcome) => outcomes.push(outcome));
  return { stub, feed, statuses, messages, outcomes };
}

const snapshotMessages = (messages: FeedMessage[]): FeedMessage[] =>
  messages.filter((message) => message.kind === 'snapshot');
const confirmedMessages = (messages: FeedMessage[]): FeedMessage[] =>
  messages.filter((message) => message.kind === 'snapshot-confirmed');
const freshnessMessages = (messages: FeedMessage[]): FeedMessage[] =>
  messages.filter((message) => message.kind === 'freshness');
const urls = (stub: ReturnType<typeof fetchStub>): string[] =>
  stub.snapshotCalls().map((call) => call.url);

beforeEach(() => {
  vi.useFakeTimers({ now: new Date(BASE_EPOCH) });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('createPollingFeed', () => {
  it('fetches immediately on start, emits the snapshot, and goes connecting → live', async () => {
    const { stub, feed, statuses, messages } = setup();
    expect(statuses).toEqual(['connecting']);

    feed.start({ lastSeq: null });
    await flush();

    expect(stub.snapshotCalls()).toHaveLength(1);
    const first = messages.find((message) => message.kind === 'snapshot');
    expect(first?.kind).toBe('snapshot');
    if (first?.kind === 'snapshot') {
      expect(first.snapshot.maxSeq).toBe(42);
      expect(first.snapshot.events[0]?.id).toBe('fw-2026-q7f3d');
    }
    expect(statuses).toEqual(['connecting', 'live']);
  });

  it('delivers the current status to late subscribers immediately', async () => {
    const { feed } = setup();
    feed.start({ lastSeq: null });
    await flush();

    const late: FeedStatus[] = [];
    feed.onStatus((status) => late.push(status));
    expect(late).toEqual(['live']);
  });

  it('is idempotent under a double start', async () => {
    const { stub, feed } = setup();
    feed.start({ lastSeq: null });
    feed.start({ lastSeq: null });
    await flush();
    expect(stub.snapshotCalls()).toHaveLength(1);
  });

  it('schedules the next poll at the lower jitter bound when rng is 0', async () => {
    const { stub, feed } = setup({ rng: 0 }); // factor = 1 + 0.2 * (2·0 − 1) = 0.8 → 8 000 ms
    feed.start({ lastSeq: null });
    await flush();
    expect(stub.snapshotCalls()).toHaveLength(1);

    await advance(7_999);
    expect(stub.snapshotCalls()).toHaveLength(1);
    await advance(1);
    expect(stub.snapshotCalls()).toHaveLength(2);
  });

  it('schedules the next poll at the upper jitter bound when rng is 1', async () => {
    // rng at the top of its range: factor = 1 + 0.2 * (2·1 − 1) = 1.2 → exactly 12 000 ms
    const { stub, feed } = setup({ rng: 1 });
    feed.start({ lastSeq: null });
    await flush();

    await advance(11_999);
    expect(stub.snapshotCalls()).toHaveLength(1);
    await advance(1);
    expect(stub.snapshotCalls()).toHaveLength(2);
  });

  it('treats a malformed snapshot body as a failed poll — no message ever emitted', async () => {
    const { stub, feed, statuses, messages } = setup();
    feed.start({ lastSeq: null });
    await flush();

    stub.setSnapshot(() => fakeResponse(200, { type: 'garbage' }, { date: dateHeader() }));
    await advance(10_000);

    expect(snapshotMessages(messages)).toHaveLength(1); // only the initial one
    expect(statuses.at(-1)).toBe('live'); // one failure does not change status
  });

  it('treats unparseable JSON as a failed poll', async () => {
    const { stub, feed, messages } = setup();
    feed.start({ lastSeq: null });
    await flush();

    stub.setSnapshot(() => fakeResponse(200, INVALID_JSON));
    await advance(10_000);
    expect(snapshotMessages(messages)).toHaveLength(1);
  });

  it("goes 'degraded' after 2 consecutive failures and back to 'live' on recovery", async () => {
    const { stub, feed, statuses } = setup(); // rng 0.5 → jitter factor 1
    feed.start({ lastSeq: null });
    await flush();

    stub.setSnapshot(() => fakeResponse(500, INVALID_JSON));
    await advance(10_000); // failure 1 → backoff 10 000
    expect(statuses).toEqual(['connecting', 'live']);
    await advance(10_000); // failure 2 → degraded, backoff 20 000
    expect(statuses).toEqual(['connecting', 'live', 'degraded']);

    stub.setSnapshot(() => okSnapshot());
    await advance(20_000);
    expect(statuses).toEqual(['connecting', 'live', 'degraded', 'live']);
  });

  it('counts a network error as a failure', async () => {
    const { stub, feed, statuses } = setup();
    feed.start({ lastSeq: null });
    await flush();

    stub.setSnapshot(() => {
      throw new TypeError('network down');
    });
    await advance(10_000);
    await advance(10_000);
    expect(statuses.at(-1)).toBe('degraded');
  });

  it('honors Retry-After in delta-seconds on 429', async () => {
    const { stub, feed } = setup();
    feed.start({ lastSeq: null });
    await flush();

    stub.setSnapshot(() => fakeResponse(429, null, { 'retry-after': '120' }));
    await advance(10_000); // failure at t=10 s → hold = max(10 s backoff, 120 s) = 120 s
    expect(stub.snapshotCalls()).toHaveLength(2);

    stub.setSnapshot(() => okSnapshot());
    await advance(119_999);
    expect(stub.snapshotCalls()).toHaveLength(2);
    await advance(1);
    expect(stub.snapshotCalls()).toHaveLength(3);
  });

  it('honors Retry-After as an HTTP-date measured against server time on 503', async () => {
    const { stub, feed } = setup();
    feed.start({ lastSeq: null });
    await flush();

    stub.setSnapshot(() =>
      fakeResponse(503, null, { 'retry-after': new Date(Date.now() + 90_000).toUTCString() }),
    );
    await advance(10_000); // failure at t=10 s → retry not before t=100 s

    stub.setSnapshot(() => okSnapshot());
    await advance(89_999);
    expect(stub.snapshotCalls()).toHaveLength(2);
    await advance(1);
    expect(stub.snapshotCalls()).toHaveLength(3);
  });

  it('emits a freshness report parsed from a 500-status body (the probe contract)', async () => {
    const { stub, feed, messages } = setup();
    stub.setFreshness(() => fakeResponse(500, freshnessBody('critical')));
    feed.start({ lastSeq: null });
    await flush();

    const freshness = messages.find((message) => message.kind === 'freshness');
    expect(freshness?.kind).toBe('freshness');
    if (freshness?.kind === 'freshness') {
      expect(freshness.report.status).toBe('critical');
      expect(freshness.report.rows[0]?.row).toBe('firms:viirs:snpp');
    }
  });

  it('skips an unparseable freshness body silently and keeps the side-poll alive', async () => {
    const { stub, feed, messages, statuses } = setup();
    stub.setFreshness(() => fakeResponse(200, { nope: true }));
    feed.start({ lastSeq: null });
    await flush();
    expect(freshnessMessages(messages)).toHaveLength(0);
    expect(statuses.at(-1)).toBe('live'); // freshness never drives feed status

    stub.setFreshness(() => fakeResponse(200, freshnessBody('ok')));
    await advance(60_000);
    expect(freshnessMessages(messages)).toHaveLength(1);
  });

  it('polls freshness every freshnessPollIntervalMs after the immediate first fetch', async () => {
    const { stub, feed } = setup();
    feed.start({ lastSeq: null });
    await flush();
    expect(stub.freshnessCalls()).toHaveLength(1);

    await advance(60_000);
    expect(stub.freshnessCalls()).toHaveLength(2);
    await advance(60_000);
    expect(stub.freshnessCalls()).toHaveLength(3);
  });

  it("stop() reports 'dead' and silences all loops, the safety timer included", async () => {
    const { stub, feed, statuses } = setup();
    feed.start({ lastSeq: null });
    await flush();

    feed.stop();
    expect(statuses.at(-1)).toBe('dead');

    const snapshotCount = stub.snapshotCalls().length;
    const freshnessCount = stub.freshnessCalls().length;
    await advance(1_200_000);
    expect(stub.snapshotCalls()).toHaveLength(snapshotCount);
    expect(stub.freshnessCalls()).toHaveLength(freshnessCount);
  });

  it('can be restarted after stop(): connecting again, then live', async () => {
    const { stub, feed, statuses } = setup();
    feed.start({ lastSeq: null });
    await flush();
    feed.stop();

    feed.start({ lastSeq: null });
    await flush();
    expect(stub.snapshotCalls()).toHaveLength(2);
    expect(statuses).toEqual(['connecting', 'live', 'dead', 'connecting', 'live']);
  });

  it('feeds Date headers into the server-time tracker (serverNow lands on server truth)', async () => {
    const { stub, feed } = setup();
    const skewMs = 3 * 3_600_000; // server is 3 h ahead of the device clock
    stub.setSnapshot(() =>
      fakeResponse(200, wireBody(), {
        etag: '"v1"',
        date: new Date(Date.now() + skewMs).toUTCString(),
      }),
    );
    feed.start({ lastSeq: null });
    await flush();

    expect(Math.abs(feed.serverNow() - (Date.now() + skewMs))).toBeLessThan(1_000);
  });

  it('uses an injected server-time tracker for every sample and for serverNow', async () => {
    const observed: { headers: { date: string | null; age: string | null }; rttMs: number }[] = [];
    const tracker: ServerTimeTracker = {
      observe: (headers, rttMs) => {
        observed.push({ headers, rttMs });
      },
      serverNow: () => 1_234,
      offsetMs: () => 0,
    };
    const { stub, feed } = setup({ serverTime: tracker });
    stub.setSnapshot(() =>
      fakeResponse(200, wireBody(), {
        etag: '"v1"',
        date: 'Sun, 09 Aug 2026 10:00:00 GMT',
        age: '3',
      }),
    );
    feed.start({ lastSeq: null });
    await flush();

    expect(observed).toEqual([
      { headers: { date: 'Sun, 09 Aug 2026 10:00:00 GMT', age: '3' }, rttMs: 0 },
    ]);
    expect(feed.serverNow()).toBe(1_234);
  });
});

describe('cursor mode (A1.5)', () => {
  it('fetches full first, then polls with the cursor and without the full ETag', async () => {
    const { stub, feed } = setup();
    feed.start({ lastSeq: null });
    await flush();
    expect(stub.snapshotCalls()[0]?.url).toBe(FULL_URL);
    expect(stub.snapshotCalls()[0]?.headers['if-none-match']).toBeUndefined();

    await advance(10_000);
    const second = stub.snapshotCalls()[1];
    expect(second?.url).toBe(cursorUrl(42));
    expect(second?.headers['if-none-match']).toBeUndefined();
  });

  it('a seeded lastSeq is the initial mark, yet the first fetch is still full', async () => {
    const { stub, feed } = setup();
    feed.start({ lastSeq: 100 });
    await flush();
    expect(urls(stub)).toEqual([FULL_URL]);

    await advance(10_000);
    expect(urls(stub)).toEqual([FULL_URL, cursorUrl(100)]); // highest of seed and body
  });

  it('advances the mark with every partial response', async () => {
    const { stub, feed, messages } = setup();
    feed.start({ lastSeq: null });
    await flush();

    stub.setSnapshot(() => partialSnapshot(50));
    await advance(10_000);
    stub.setSnapshot(() => partialSnapshot(57));
    await advance(10_000);
    await advance(10_000);

    expect(urls(stub)).toEqual([FULL_URL, cursorUrl(42), cursorUrl(50), cursorUrl(57)]);
    const partials = snapshotMessages(messages).filter(
      (message) => message.kind === 'snapshot' && message.snapshot.partial,
    );
    expect(partials).toHaveLength(3);
  });

  it('keeps the full and cursor ETags in their own lanes', async () => {
    const { stub, feed } = setup();
    feed.start({ lastSeq: null }); // full 200, ETag "v1"
    await flush();

    stub.setSnapshot(() => partialSnapshot(50, '"c1"'));
    await advance(10_000); // cursor 200, ETag "c1"
    await advance(10_000);
    expect(stub.snapshotCalls()[2]?.url).toBe(cursorUrl(50));
    expect(stub.snapshotCalls()[2]?.headers['if-none-match']).toBe('"c1"');

    feed.refetchNow();
    await flush();
    expect(stub.snapshotCalls()[3]?.url).toBe(FULL_URL);
    expect(stub.snapshotCalls()[3]?.headers['if-none-match']).toBe('"v1"');
  });

  it('a cursor 304 is a quiet success: no message, no status churn', async () => {
    const { stub, feed, statuses, messages, outcomes } = setup();
    feed.start({ lastSeq: null });
    await flush();

    stub.setSnapshot(() => notModified());
    await advance(10_000);

    expect(stub.snapshotCalls()).toHaveLength(2);
    expect(stub.snapshotCalls()[1]?.url).toBe(cursorUrl(42));
    expect(snapshotMessages(messages)).toHaveLength(1);
    expect(confirmedMessages(messages)).toHaveLength(0);
    expect(statuses).toEqual(['connecting', 'live']);
    expect(outcomes.at(-1)).toEqual({ kind: 'ok', tier: 'T1', full: false, generatedAt: null });
  });

  it('a full 304 emits snapshot-confirmed stamped with the response Date', async () => {
    const { stub, feed, messages, outcomes } = setup();
    feed.start({ lastSeq: null });
    await flush();

    stub.setSnapshot(() => fakeResponse(304, null, { date: 'Sun, 09 Aug 2026 10:00:05 GMT' }));
    feed.refetchNow();
    await flush();

    expect(stub.snapshotCalls()[1]?.url).toBe(FULL_URL);
    expect(stub.snapshotCalls()[1]?.headers['if-none-match']).toBe('"v1"');
    expect(confirmedMessages(messages)).toEqual([
      { kind: 'snapshot-confirmed', generatedAt: '2026-08-09T10:00:05.000Z' },
    ]);
    expect(outcomes.at(-1)).toEqual({ kind: 'ok', tier: 'T1', full: true, generatedAt: null });
  });

  it('a full 304 without a usable Date confirms nothing but still counts as success', async () => {
    const { stub, feed, messages, outcomes, statuses } = setup();
    feed.start({ lastSeq: null });
    await flush();

    stub.setSnapshot(() => fakeResponse(304, null));
    feed.refetchNow();
    await flush();

    expect(confirmedMessages(messages)).toHaveLength(0);
    expect(outcomes.at(-1)).toEqual({ kind: 'ok', tier: 'T1', full: true, generatedAt: null });
    expect(statuses.at(-1)).toBe('live');
  });

  it('a static 304 confirms nothing: a cache hit is not a live pipeline', async () => {
    const { stub, feed, messages, outcomes } = setup({
      config: { staticSnapshotUrl: STATIC_URL },
    });
    // T2 is where the client goes when the origin is unreachable, so the origin is down
    // for the whole of this test — which is what makes the static answers the only ones.
    stub.setSnapshot((call) =>
      call.url === STATIC_URL ? okSnapshot('"s1"') : fakeResponse(500, null),
    );
    feed.setTier('T2');
    feed.start({ lastSeq: null });
    await flush();
    expect(confirmedMessages(messages)).toHaveLength(0);

    stub.setSnapshot((call) => (call.url === STATIC_URL ? notModified() : fakeResponse(500, null)));
    await advance(10_000);

    // The static `304` is still a full success — it keeps the held set usable and re-arms
    // the safety timer — but it carries no claim about the set's age: the CDN answers for
    // the object it stores, not for the publisher behind it. Confirming here would move
    // the staleness anchor to "now" on every poll and hide a frozen pipeline behind a
    // healthy cache (GLOSSARY §3b trigger 1). The object's own `generated_at`, delivered
    // with the body, is the only age this client has while the origin is dark.
    expect(stub.snapshotCalls().at(-2)?.url).toBe(STATIC_URL);
    expect(stub.snapshotCalls().at(-2)?.headers['if-none-match']).toBe('"s1"');
    expect(confirmedMessages(messages)).toHaveLength(0);
    expect(outcomes.filter((outcome) => outcome.tier === 'T2').at(-1)).toEqual({
      kind: 'ok',
      tier: 'T2',
      full: true,
      generatedAt: null,
    });
  });

  it('a restart with a cursor keeps the full ETag, so a 304 confirms the held set', async () => {
    const { stub, feed, messages } = setup();
    feed.start({ lastSeq: null });
    await flush();
    feed.stop();

    stub.setSnapshot(() => notModified());
    feed.start({ lastSeq: 42 });
    await flush();
    expect(stub.snapshotCalls()[1]?.url).toBe(FULL_URL);
    expect(stub.snapshotCalls()[1]?.headers['if-none-match']).toBe('"v1"');
    expect(confirmedMessages(messages)).toHaveLength(1);

    await advance(10_000); // the confirmed set is proof enough for cursor polls
    expect(stub.snapshotCalls()[2]?.url).toBe(cursorUrl(42));
  });

  it('a restart without a cursor forgets every ETag: the first response has a body', async () => {
    const { stub, feed } = setup();
    feed.start({ lastSeq: null });
    await flush();
    feed.stop();

    feed.start({ lastSeq: null });
    await flush();
    expect(stub.snapshotCalls()[1]?.headers['if-none-match']).toBeUndefined();
  });

  it('treats a cursor request answered partial:false as full (the static dev file)', async () => {
    const { stub, feed } = setup({ rng: 0, config: { safetySnapshotIntervalMs: 30_000 } });
    let cursorCalls = 0;
    stub.setSnapshot((call) => {
      if (!call.url.includes('updated_after_seq')) return okSnapshot('"v1"');
      cursorCalls += 1;
      return cursorCalls === 1 ? okSnapshot('"v2"') : partialSnapshot(42, '"c1"');
    });
    feed.start({ lastSeq: null }); // full at 0 s arms the safety timer for 30 s
    await flush();

    await advance(8_000); // the cursor poll at 8 s is answered with the whole file
    await advance(8_000); // ...whose ETag the next cursor request now carries
    expect(stub.snapshotCalls()[2]?.headers['if-none-match']).toBe('"v2"');

    await advance(21_999); // t = 37 999: no safety fetch at 30 s — it was re-armed to 38 s
    expect(urls(stub).filter((url) => url === FULL_URL)).toHaveLength(1);
    await advance(1);
    expect(urls(stub).filter((url) => url === FULL_URL)).toHaveLength(2);
    expect(stub.snapshotCalls().at(-1)?.headers['if-none-match']).toBe('"v2"');
  });
});

describe('safety timer (A1.5, 10-minute rule)', () => {
  it('fires a full fetch at exactly the interval when rng is 0', async () => {
    const { stub, feed } = setup({ rng: 0 });
    feed.start({ lastSeq: null, cadence: 'safety' });
    await flush();

    await advance(599_999);
    expect(stub.snapshotCalls()).toHaveLength(1);
    await advance(1);
    expect(stub.snapshotCalls()).toHaveLength(2);
    expect(stub.snapshotCalls()[1]?.url).toBe(FULL_URL);
    expect(stub.snapshotCalls()[1]?.headers['if-none-match']).toBe('"v1"');
  });

  it('jitters downward only: rng 1 fires at interval × (1 − ratio)', async () => {
    const { stub, feed } = setup({ rng: 1 }); // 600 000 × (1 − 0.2) = 480 000
    feed.start({ lastSeq: null, cadence: 'safety' });
    await flush();

    await advance(479_999);
    expect(stub.snapshotCalls()).toHaveLength(1);
    await advance(1);
    expect(stub.snapshotCalls()).toHaveLength(2);
  });

  it('is re-armed by a full 304 as well as by a full 200', async () => {
    const { stub, feed, messages } = setup({ rng: 0 });
    feed.start({ lastSeq: null, cadence: 'safety' });
    await flush();

    stub.setSnapshot(() => notModified());
    await advance(600_000);
    expect(stub.snapshotCalls()).toHaveLength(2);
    expect(confirmedMessages(messages)).toHaveLength(1);

    await advance(599_999);
    expect(stub.snapshotCalls()).toHaveLength(2);
    await advance(1);
    expect(stub.snapshotCalls()).toHaveLength(3);
  });

  it('is never re-armed by cursor responses', async () => {
    const { stub, feed } = setup({ rng: 0, config: { safetySnapshotIntervalMs: 30_000 } });
    stub.setSnapshot((call) =>
      call.url.includes('updated_after_seq') ? partialSnapshot(50) : okSnapshot(),
    );
    feed.start({ lastSeq: null });
    await flush();

    await advance(29_999); // cursor polls at 8, 16 and 24 s
    expect(urls(stub)).toEqual([FULL_URL, cursorUrl(42), cursorUrl(50), cursorUrl(50)]);
    await advance(1); // 30 s after the last full response, whatever the cursor polls did
    expect(urls(stub).at(-1)).toBe(FULL_URL);

    // The forced full fetch re-arms the timer and restarts the poll cadence from now.
    await advance(29_999); // cursor polls at 38, 46 and 54 s
    expect(urls(stub).filter((url) => url === FULL_URL)).toHaveLength(2);
    expect(urls(stub)).toHaveLength(8);
    await advance(1);
    expect(urls(stub).filter((url) => url === FULL_URL)).toHaveLength(3);
  });

  it("cadence 'safety' issues no cursor polls; the freshness side-poll keeps running", async () => {
    const { stub, feed } = setup(); // rng 0.5 → 600 000 × (1 − 0.1) = 540 000
    feed.start({ lastSeq: null, cadence: 'safety' });
    await flush();

    await advance(100_000); // ten poll intervals
    expect(stub.snapshotCalls()).toHaveLength(1);
    expect(stub.freshnessCalls()).toHaveLength(2);

    await advance(440_000);
    expect(urls(stub)).toEqual([FULL_URL, FULL_URL]);
  });

  it("cadence 'safety' still retries a failed full fetch: the store is never empty", async () => {
    const { stub, feed } = setup();
    stub.setSnapshot(() => fakeResponse(500, null));
    feed.start({ lastSeq: null, cadence: 'safety' });
    await flush();

    stub.setSnapshot(() => okSnapshot());
    await advance(10_000); // failure 1 → backoff 10 000
    expect(urls(stub)).toEqual([FULL_URL, FULL_URL]);
    await advance(100_000); // and once it has a full set, silence until the safety timer
    expect(urls(stub)).toEqual([FULL_URL, FULL_URL]);
  });
});

describe('refetchNow()', () => {
  it('fetches full immediately and cancels the pending poll', async () => {
    const { stub, feed } = setup();
    feed.start({ lastSeq: null }); // next poll due at 10 s
    await flush();

    await advance(5_000);
    feed.refetchNow();
    await flush();
    expect(stub.snapshotCalls()).toHaveLength(2);
    expect(stub.snapshotCalls()[1]?.url).toBe(FULL_URL);
    expect(stub.snapshotCalls()[1]?.headers['if-none-match']).toBe('"v1"');

    await advance(5_000); // t = 10 s: the original poll was cancelled
    expect(stub.snapshotCalls()).toHaveLength(2);
    await advance(5_000); // t = 15 s: the cadence restarted from the forced fetch
    expect(stub.snapshotCalls()).toHaveLength(3);
    expect(stub.snapshotCalls()[2]?.url).toBe(cursorUrl(42));
  });

  it('supersedes a fetch already in flight: the stale response is dropped', async () => {
    const { stub, feed, messages, outcomes } = setup();
    const releases: ((response: Response) => void)[] = [];
    stub.setSnapshot(
      () =>
        new Promise<Response>((resolve) => {
          releases.push(resolve);
        }),
    );
    feed.start({ lastSeq: null });
    await flush();
    expect(stub.snapshotCalls()).toHaveLength(1);

    stub.setSnapshot(() => okSnapshot());
    feed.refetchNow();
    await flush();
    expect(stub.snapshotCalls()).toHaveLength(2);
    expect(snapshotMessages(messages)).toHaveLength(1);

    releases[0]?.(fakeResponse(200, { ...wireBody(), max_seq: 7 }, { date: dateHeader() }));
    await flush();
    expect(snapshotMessages(messages)).toHaveLength(1);
    expect(outcomes).toHaveLength(1);
  });

  it('is a no-op before start() and after stop()', async () => {
    const { stub, feed } = setup();
    feed.refetchNow();
    await flush();
    expect(stub.snapshotCalls()).toHaveLength(0);

    feed.start({ lastSeq: null });
    await flush();
    feed.stop();
    feed.refetchNow();
    await flush();
    expect(stub.snapshotCalls()).toHaveLength(1);
  });
});

describe('tiers (A1.2)', () => {
  it('T2 with no static url behaves exactly like T1', async () => {
    const { stub, feed, outcomes } = setup();
    feed.start({ lastSeq: null });
    await flush();

    feed.setTier('T2'); // switching still forces a full fetch...
    await flush();
    expect(urls(stub)).toEqual([FULL_URL, FULL_URL]);

    await advance(10_000); // ...and the origin loop carries on in cursor mode
    expect(urls(stub).at(-1)).toBe(cursorUrl(42));
    expect(outcomes.map((outcome) => outcome.tier)).toEqual(['T1', 'T1', 'T1']);

    stub.setSnapshot(() => fakeResponse(500, null));
    await advance(10_000); // failure 1 → backoff 10 000
    await advance(10_000); // failure 2 → backoff 20 000: the T1 exponential backoff
    await advance(19_999);
    expect(stub.snapshotCalls()).toHaveLength(5);
    await advance(1);
    expect(stub.snapshotCalls()).toHaveLength(6);
  });

  it('setTier to the current tier is a no-op', async () => {
    const { stub, feed } = setup();
    feed.start({ lastSeq: null });
    await flush();
    feed.setTier('T1');
    await flush();
    expect(stub.snapshotCalls()).toHaveLength(1);
  });

  it('T2 fetches the static copy, then probes the origin; outcomes carry their tiers', async () => {
    const { stub, feed, messages, outcomes } = setup({
      config: { staticSnapshotUrl: STATIC_URL },
    });
    stub.setSnapshot((call) =>
      call.url === STATIC_URL
        ? fakeResponse(200, { ...wireBody(), max_seq: 43 }, { etag: '"s1"', date: dateHeader() })
        : okSnapshot(),
    );
    feed.start({ lastSeq: null });
    await flush();

    feed.setTier('T2');
    await flush();
    expect(urls(stub)).toEqual([FULL_URL, STATIC_URL, FULL_URL]);
    expect(outcomes).toEqual([
      { kind: 'ok', tier: 'T1', full: true, generatedAt: '2026-08-09T09:58:00Z' },
      { kind: 'ok', tier: 'T2', full: true, generatedAt: '2026-08-09T09:58:00Z' },
      { kind: 'ok', tier: 'T1', full: true, generatedAt: '2026-08-09T09:58:00Z' },
    ]);
    expect(snapshotMessages(messages)).toHaveLength(3); // the probe body is emitted too

    await advance(10_000); // the next cycle: each request carries its own ETag
    expect(urls(stub)).toEqual([FULL_URL, STATIC_URL, FULL_URL, STATIC_URL, FULL_URL]);
    expect(stub.snapshotCalls()[3]?.headers['if-none-match']).toBe('"s1"');
    expect(stub.snapshotCalls()[4]?.headers['if-none-match']).toBe('"v1"');
  });

  it('T2 status follows the static fetch, not the origin probe', async () => {
    const { stub, feed, statuses } = setup({ config: { staticSnapshotUrl: STATIC_URL } });
    feed.start({ lastSeq: null });
    await flush();
    expect(statuses).toEqual(['connecting', 'live']);

    // Static copy fine, origin down: the origin's failures never reach the status.
    stub.setSnapshot((call) =>
      call.url === STATIC_URL ? okSnapshot('"s1"') : fakeResponse(500, null),
    );
    feed.setTier('T2');
    await flush();
    await advance(10_000);
    await advance(10_000);
    expect(statuses).toEqual(['connecting', 'live']);

    // Static copy down, origin fine: two static failures degrade, whatever the origin says.
    stub.setSnapshot((call) => (call.url === STATIC_URL ? fakeResponse(500, null) : okSnapshot()));
    await advance(10_000);
    await advance(10_000);
    expect(statuses).toEqual(['connecting', 'live', 'degraded']);
  });

  it('T2 paces static failures at the poll interval — no exponential backoff', async () => {
    const { stub, feed, statuses } = setup({ config: { staticSnapshotUrl: STATIC_URL } });
    feed.start({ lastSeq: null });
    await flush();

    stub.setSnapshot((call) => (call.url === STATIC_URL ? fakeResponse(500, null) : okSnapshot()));
    feed.setTier('T2');
    await flush();
    await advance(30_000);
    const staticCalls = stub.snapshotCalls().filter((call) => call.url === STATIC_URL);
    expect(staticCalls.map((call) => call.atMs - Date.parse(BASE_EPOCH))).toEqual([
      0, 10_000, 20_000, 30_000,
    ]);
    expect(statuses.at(-1)).toBe('degraded');
  });

  it('an origin Retry-After in T2 skips only the origin probes until it elapses', async () => {
    const { stub, feed, outcomes, statuses } = setup({
      config: { staticSnapshotUrl: STATIC_URL },
    });
    feed.start({ lastSeq: null });
    await flush();

    stub.setSnapshot((call) =>
      call.url === STATIC_URL
        ? okSnapshot('"s1"')
        : fakeResponse(503, null, { 'retry-after': '25' }),
    );
    feed.setTier('T2');
    await flush();
    expect(outcomes.at(-1)).toEqual({
      kind: 'unusable',
      tier: 'T1',
      status: 503,
      retryAfterMs: 25_000,
    });

    await advance(10_000);
    await advance(10_000);
    expect(urls(stub)).toEqual([FULL_URL, STATIC_URL, FULL_URL, STATIC_URL, STATIC_URL]);
    await advance(10_000); // t = 30 s: the hold (until 25 s) has elapsed
    expect(urls(stub).slice(-2)).toEqual([STATIC_URL, FULL_URL]);
    expect(statuses.at(-1)).toBe('live');
  });

  it('a static Retry-After in T2 holds the whole cycle', async () => {
    const { stub, feed } = setup({ config: { staticSnapshotUrl: STATIC_URL } });
    feed.start({ lastSeq: null });
    await flush();

    stub.setSnapshot((call) =>
      call.url === STATIC_URL ? fakeResponse(429, null, { 'retry-after': '30' }) : okSnapshot(),
    );
    feed.setTier('T2');
    await flush();
    expect(urls(stub)).toEqual([FULL_URL, STATIC_URL, FULL_URL]);

    await advance(29_999);
    expect(stub.snapshotCalls()).toHaveLength(3);
    await advance(1);
    expect(urls(stub).slice(-2)).toEqual([STATIC_URL, FULL_URL]);
  });

  it('switching back to T1 forces a full origin fetch and resumes cursor polls', async () => {
    const { stub, feed } = setup({ config: { staticSnapshotUrl: STATIC_URL } });
    feed.start({ lastSeq: null });
    await flush();
    feed.setTier('T2');
    await flush();

    feed.setTier('T1');
    await flush();
    expect(urls(stub).at(-1)).toBe(FULL_URL);
    await advance(10_000);
    expect(urls(stub).at(-1)).toBe(cursorUrl(42));
  });
});

describe('onOutcome', () => {
  it('reports one outcome per attempt, after the message, never for freshness', async () => {
    const { stub, feed, outcomes } = setup();
    const log: string[] = [];
    feed.onMessage((message) => log.push(`message:${message.kind}`));
    feed.onOutcome((outcome) => log.push(`outcome:${outcome.kind}`));

    feed.start({ lastSeq: null });
    await flush();
    expect(log.filter((entry) => !entry.includes('freshness'))).toEqual([
      'message:snapshot',
      'outcome:ok',
    ]);
    expect(outcomes).toEqual([
      { kind: 'ok', tier: 'T1', full: true, generatedAt: '2026-08-09T09:58:00Z' },
    ]);

    stub.setSnapshot(() => notModified());
    await advance(10_000); // cursor 304
    expect(outcomes.at(-1)).toEqual({ kind: 'ok', tier: 'T1', full: false, generatedAt: null });

    stub.setSnapshot(() => {
      throw new TypeError('network down');
    });
    await advance(10_000);
    expect(outcomes.at(-1)).toEqual({
      kind: 'unusable',
      tier: 'T1',
      status: null,
      retryAfterMs: null,
    });

    stub.setSnapshot(() => fakeResponse(429, null, { 'retry-after': '120' }));
    await advance(10_000); // failure 1 backed off 10 s
    expect(outcomes.at(-1)).toEqual({
      kind: 'unusable',
      tier: 'T1',
      status: 429,
      retryAfterMs: 120_000,
    });

    stub.setSnapshot(() => fakeResponse(200, { type: 'garbage' }, { date: dateHeader() }));
    await advance(120_000); // held by Retry-After
    expect(outcomes.at(-1)).toEqual({
      kind: 'unusable',
      tier: 'T1',
      status: 200,
      retryAfterMs: null,
    });

    expect(outcomes).toHaveLength(5);
    expect(stub.freshnessCalls().length).toBeGreaterThan(1);
  });
});

/** A feed whose every request hangs; the signal each one was sent with is recorded. */
function hangingFeed(): {
  feed: ReturnType<typeof createPollingFeed>;
  snapshotSignals: AbortSignal[];
  allSignals: AbortSignal[];
} {
  const snapshotSignals: AbortSignal[] = [];
  const allSignals: AbortSignal[] = [];
  const feed = createPollingFeed({
    config: CONFIG,
    clock: { epochNow: () => Date.now(), monotonicNow: () => Date.now() },
    rng: { next: () => 0.5 },
    fetchFn: (input, init) => {
      const signal = init?.signal;
      if (signal) {
        allSignals.push(signal);
        const url = input instanceof Request ? input.url : input.toString();
        if (!url.includes('freshness')) snapshotSignals.push(signal);
      }
      return new Promise<Response>(() => undefined);
    },
  });
  return { feed, snapshotSignals, allSignals };
}

describe('request deadline and cancellation', () => {
  it('fails a snapshot request that never answers at REQUEST_TIMEOUT_MS, and keeps polling', async () => {
    const { stub, feed, statuses, outcomes } = setup(); // rng 0.5 → jitter factor 1
    feed.start({ lastSeq: null });
    await flush();

    stub.setSnapshot(() => new Promise<Response>(() => undefined));
    await advance(10_000); // the poll goes out and hangs
    expect(stub.snapshotCalls()).toHaveLength(2);
    await advance(REQUEST_TIMEOUT_MS - 1);
    expect(outcomes).toHaveLength(1); // still waiting: no verdict before the deadline
    await advance(1);
    expect(outcomes.at(-1)).toEqual({
      kind: 'unusable',
      tier: 'T1',
      status: null,
      retryAfterMs: null,
    });

    // The loop is alive: the backoff retry goes out, hangs too, and the second failure
    // turns the status honest instead of leaving 'live' over a feed that stopped.
    await advance(10_000);
    expect(stub.snapshotCalls()).toHaveLength(3);
    await advance(REQUEST_TIMEOUT_MS);
    expect(statuses.at(-1)).toBe('degraded');

    stub.setSnapshot(() => okSnapshot());
    await advance(20_000);
    expect(statuses.at(-1)).toBe('live');
  });

  it('bounds a body that never finishes arriving', async () => {
    const { stub, feed, outcomes } = setup();
    feed.start({ lastSeq: null });
    await flush();

    stub.setSnapshot(() => {
      const hungBody: Response = {
        ...okSnapshot(),
        json: () => new Promise<never>(() => undefined),
      };
      return hungBody;
    });
    await advance(10_000);
    await advance(REQUEST_TIMEOUT_MS);
    expect(outcomes.at(-1)?.kind).toBe('unusable');
  });

  it('gives each request its own signal, aborted at the deadline and by stop()', async () => {
    const { feed, allSignals } = hangingFeed();
    feed.start({ lastSeq: null });
    await flush();
    expect(allSignals).toHaveLength(2); // the full snapshot and the freshness side-poll
    expect(allSignals.some((signal) => signal.aborted)).toBe(false);
    await advance(REQUEST_TIMEOUT_MS);
    expect(allSignals.every((signal) => signal.aborted)).toBe(true);

    const before = allSignals.length;
    await advance(10_000); // the backoff retry of the failed snapshot
    const retries = allSignals.slice(before);
    expect(retries.length).toBeGreaterThan(0);
    expect(retries.some((signal) => signal.aborted)).toBe(false);
    feed.stop();
    expect(retries.every((signal) => signal.aborted)).toBe(true);
  });

  it('refetchNow() aborts the snapshot request it supersedes', async () => {
    const { feed, snapshotSignals } = hangingFeed();
    feed.start({ lastSeq: null });
    await flush();
    expect(snapshotSignals).toHaveLength(1);
    feed.refetchNow();
    await flush();
    expect(snapshotSignals).toHaveLength(2);
    expect(snapshotSignals[0]?.aborted).toBe(true);
    expect(snapshotSignals[1]?.aborted).toBe(false);
    feed.stop();
  });

  it('reads 304 and error bodies to the end, so the browser completes the request', async () => {
    const { stub, feed } = setup();
    let reads = 0;
    const counted = (response: Response): Response =>
      ({
        status: response.status,
        ok: response.ok,
        headers: response.headers,
        json: () => response.json(),
        arrayBuffer: () => {
          reads += 1;
          return Promise.resolve(new ArrayBuffer(0));
        },
      }) as unknown as Response;
    feed.start({ lastSeq: null });
    await flush();

    stub.setSnapshot(() => counted(notModified()));
    await advance(10_000);
    expect(reads).toBe(1);
    stub.setSnapshot(() => counted(fakeResponse(503, { title: 'down' })));
    await advance(10_000);
    expect(reads).toBe(2);
    stub.setSnapshot(() => counted(okSnapshot()));
    await advance(20_000); // backoff after the 503; a parsed 200 is read by json(), not drained
    expect(reads).toBe(2);
  });
});

describe('parseFreshnessReport', () => {
  it('parses a valid report', () => {
    const report = parseFreshnessReport(freshnessBody('warn'));
    expect(report?.status).toBe('warn');
    expect(report?.rows).toHaveLength(1);
    expect(report?.rows[0]?.warnSeconds).toBe(21_600);
  });

  it.each([
    ['null', null],
    ['an array', []],
    ['missing generatedAt', { status: 'ok', budgetVersion: 'v', rows: [] }],
    [
      'a status outside the vocabulary',
      { generatedAt: 't', status: 'down', budgetVersion: 'v', rows: [] },
    ],
    [
      'rows that are not an array',
      { generatedAt: 't', status: 'ok', budgetVersion: 'v', rows: {} },
    ],
  ])('returns null for %s', (_label, body) => {
    expect(parseFreshnessReport(body)).toBeNull();
  });

  it('returns null when any row is malformed', () => {
    const body = freshnessBody('ok') as { rows: Record<string, unknown>[] };
    const row = body.rows[0];
    if (row === undefined) throw new Error('fixture row missing');
    row['state'] = 'broken';
    expect(parseFreshnessReport(body)).toBeNull();
  });

  it('accepts a row id this build does not know (forward compatibility)', () => {
    const body = freshnessBody('ok') as { rows: Record<string, unknown>[] };
    const row = body.rows[0];
    if (row === undefined) throw new Error('fixture row missing');
    row['row'] = 'a-feed-minted-after-this-release';
    expect(parseFreshnessReport(body)?.rows[0]?.row).toBe('a-feed-minted-after-this-release');
  });
});
