/**
 * Reachability of GLOSSARY §3b trigger 1 — "snapshot `generated_at` past 2× cadence
 * budget" — driven end to end instead of asserted on a hand-built state.
 *
 * `pick-banner.test.ts` next door pins the *arbitration*: given a `StoreState`, which
 * banner wins. That is a shape test, and a shape test cannot see the failure this file
 * exists for: a trigger that no sequence of real responses can ever produce. The snapshot
 * branch of `pickBanner` reads `state.lastSnapshotAt`, and nothing in the UI controls what
 * puts a value there — the polling feed, the supervisor and the reconciler do, several
 * layers down. So this test builds the real ones (no stubs but `fetch`, the clocks and the
 * page lifecycle), scripts the outage, and asks only at the end which banner the arbiter
 * picks.
 *
 * The outage scripted here is the one the trigger was written for (contracts/freshness.ts:
 * "a threshold delivered by the pipeline cannot describe that pipeline being down"): the
 * publisher stops, the origin goes dark with it, and the CDN in front of the static copy
 * keeps serving the last object it was given — healthily, with a correct `Date`, for as
 * long as you care to poll it. Nothing in that picture is an error:
 *
 * - `feedStatus` stays `live`, because the static fetch succeeds every time, so the
 *   `offline` branch is silent;
 * - the freshness report cannot arrive at all (it is served by the dead origin), so the
 *   last one received — a cheerful one — stays in the store, and the source branch is
 *   silent;
 * - only the age of the snapshot itself is left to tell the truth.
 *
 * The second case is the guard on the first: a quiet night on a *healthy* origin is also a
 * long run of `304`s over an unchanging set, and it must banner nothing. Any fix that
 * makes case one fire by distrusting `304`s in general breaks case two, which is the
 * false-alarm failure — a banner claiming the satellites are late while the pipeline is
 * running perfectly.
 */

import { MONITORED_SOURCE_IDS } from '@fire-watch/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ClientConfig } from '../../core/config.js';
import {
  createFeedCoordinator,
  createPollingFeed,
  createServerTimeTracker,
  createTransportSupervisor,
} from '../../core/feed/index.js';
import type { Clock, PageLifecycle, Rng } from '../../core/ports.js';
import { createFireEventStore } from '../../core/store/index.js';
import type { FireEventStore } from '../../core/types.js';
import { pickBanner } from './pick-banner.js';

const STATIC_URL = 'https://static.example/snapshot.json';
const ORIGIN_URL = '/snapshot.json';
const FRESHNESS_URL = '/api/health/freshness';

const CONFIG: ClientConfig = {
  snapshotUrl: ORIGIN_URL,
  detectionsUrlTemplate: null,
  freshnessUrl: FRESHNESS_URL,
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
  staticSnapshotUrl: STATIC_URL,
};

/** The instant the pipeline froze — and, in the first case, the only honest "since". */
const PUBLISHING_STOPPED_AT = '2026-08-09T10:00:00Z';

const ORIGIN_ETAG = '"v1-42"';
const CURSOR_ETAG = '"c1-42"';
const STATIC_ETAG = '"static-v1-42"';

/** Same microtask-only stand-in as `polling-feed.test.ts`: no streams, no real timers. */
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
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

function wireBody(generatedAt: string): Record<string, unknown> {
  return {
    type: 'FeatureCollection',
    schema_version: 1,
    generated_at: generatedAt,
    max_seq: 42,
    partial: false,
    sources: [{ source_id: 'firms:viirs:snpp', last_observed_at: PUBLISHING_STOPPED_AT }],
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

/** A cursor answer with nothing new: `partial`, no features, the same high-water mark. */
function partialBody(generatedAt: string): Record<string, unknown> {
  return { ...wireBody(generatedAt), partial: true, features: [] };
}

/**
 * A report in which nothing at all is wrong. It has to be believable, because the point of
 * the first case is that the last report to arrive before the outage keeps the source
 * branch of `pickBanner` quiet forever afterwards.
 */
function healthyFreshnessBody(generatedAt: string): unknown {
  return {
    generatedAt,
    status: 'ok',
    budgetVersion: '2026-08-01',
    rows: MONITORED_SOURCE_IDS.map((row) => ({
      row,
      lastSuccessAt: generatedAt,
      lastDataAt: generatedAt,
      ageSeconds: 60,
      warnSeconds: 21_600,
      criticalSeconds: 28_800,
      state: 'ok',
      consecutiveFailures: 0,
      pages: true,
      mutedUntil: null,
      muteReason: null,
    })),
  };
}

const nowHeaders = (extra: Record<string, string> = {}): Record<string, string> => ({
  date: new Date(Date.now()).toUTCString(),
  ...extra,
});

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  return input instanceof URL ? input.toString() : input.url;
}

function ifNoneMatch(init: RequestInit | undefined): string | null {
  const headers = (init?.headers ?? {}) as Record<string, string>;
  return headers['if-none-match'] ?? null;
}

/** Everything the composition root wires, with only the platform edges faked. */
function wireApp(fetchFn: typeof fetch): {
  store: FireEventStore;
  supervisor: ReturnType<typeof createTransportSupervisor>;
  coordinator: ReturnType<typeof createFeedCoordinator>;
  serverNow: () => number;
} {
  const clock: Clock = { epochNow: () => Date.now(), monotonicNow: () => Date.now() };
  const rng: Rng = { next: () => 0.5 };
  const serverTime = createServerTimeTracker(clock);
  const store = createFireEventStore({ serverNow: serverTime.serverNow });
  const polling = createPollingFeed({ config: CONFIG, clock, rng, fetchFn, serverTime });
  const supervisor = createTransportSupervisor({
    clock,
    serverNow: serverTime.serverNow,
    config: {
      pollIntervalMs: CONFIG.pollIntervalMs,
      staticFlipStaleMs: CONFIG.staticFlipStaleMs,
      hysteresisMs: CONFIG.sseReofferHysteresisMs,
      sseEnabled: CONFIG.sseEnabled,
    },
  });
  // The tab is visible and the browser is online throughout: this outage is entirely on
  // the far side of the wire, which is exactly why nothing local announces it.
  const lifecycle: PageLifecycle = {
    onWake: () => () => undefined,
    onOnline: () => () => undefined,
  };
  const coordinator = createFeedCoordinator({
    store,
    polling,
    stream: null,
    supervisor,
    lifecycle,
  });
  return { store, supervisor, coordinator, serverNow: serverTime.serverNow };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 25; i += 1) await Promise.resolve();
}

async function advance(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
  await flush();
}

beforeEach(() => {
  vi.useFakeTimers({ now: new Date(PUBLISHING_STOPPED_AT) });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('the stale-snapshot banner, reached through the feed rather than constructed', () => {
  it('fires when the pipeline freezes behind a CDN that keeps answering 304', async () => {
    let originDark = false;
    let staticNotModified = 0;

    const fetchFn: typeof fetch = (input, init) => {
      const url = requestUrl(input);
      if (url === STATIC_URL) {
        // The CDN never fails: it holds one object, published the instant the pipeline
        // stopped, and revalidates it correctly for as long as anyone asks.
        if (ifNoneMatch(init) === STATIC_ETAG) {
          staticNotModified += 1;
          return Promise.resolve(fakeResponse(304, null, nowHeaders()));
        }
        return Promise.resolve(
          fakeResponse(200, wireBody(PUBLISHING_STOPPED_AT), nowHeaders({ etag: STATIC_ETAG })),
        );
      }
      if (originDark) return Promise.reject(new TypeError('Failed to fetch'));
      if (url.startsWith(FRESHNESS_URL)) {
        return Promise.resolve(fakeResponse(200, healthyFreshnessBody(PUBLISHING_STOPPED_AT)));
      }
      return Promise.resolve(
        fakeResponse(200, wireBody(PUBLISHING_STOPPED_AT), nowHeaders({ etag: ORIGIN_ETAG })),
      );
    };

    const app = wireApp(fetchFn);
    app.coordinator.start();
    await flush();

    // One honest snapshot and one cheerful report land before anything breaks.
    expect(app.store.state().lastSnapshotAt).toBe(PUBLISHING_STOPPED_AT);
    expect(app.store.state().freshness?.status).toBe('ok');
    expect(pickBanner(app.store.state(), app.serverNow())).toBeNull();

    // The publisher and the origin stop together; the CDN copy is now frozen at the
    // instant above, and it is the only thing still answering.
    originDark = true;

    // Three unusable origin answers spanning more than two poll intervals: ADR-003 A1.2's
    // flip, reached by the supervisor on its own rather than by calling `setTier`.
    await advance(60_000);
    expect(app.supervisor.state()).toBe('STATIC_FALLBACK');

    // A quarter of an hour of T2 polling — half again the 10-minute trigger.
    await advance(15 * 60_000);
    expect(staticNotModified).toBeGreaterThan(10);

    const state = app.store.state();
    // The other two branches are provably silent, which is the whole danger: the feed
    // reports itself alive because the CDN answers, and the newest report anyone has is
    // the one from before the outage.
    expect(state.feedStatus).toBe('live');
    expect(state.freshness?.status).toBe('ok');

    expect(pickBanner(state, app.serverNow())).toStrictEqual({
      kind: 'stale-sources',
      sinceIso: PUBLISHING_STOPPED_AT,
    });
  });

  it('stays silent through half an hour of a quiet but healthy origin', async () => {
    let fullNotModified = 0;

    const fetchFn: typeof fetch = (input, init) => {
      const url = requestUrl(input);
      if (url.startsWith(FRESHNESS_URL)) {
        return Promise.resolve(
          fakeResponse(200, healthyFreshnessBody(new Date(Date.now()).toISOString())),
        );
      }
      // A live origin restamps `generated_at` on every body it sends, which is what makes
      // this the "quiet night" case rather than a second frozen pipeline.
      const generatedAt = new Date(Date.now()).toISOString();
      if (url.includes('updated_after_seq')) {
        if (ifNoneMatch(init) === CURSOR_ETAG) {
          return Promise.resolve(fakeResponse(304, null, nowHeaders()));
        }
        return Promise.resolve(
          fakeResponse(200, partialBody(generatedAt), nowHeaders({ etag: CURSOR_ETAG })),
        );
      }
      if (ifNoneMatch(init) === ORIGIN_ETAG) {
        fullNotModified += 1;
        return Promise.resolve(fakeResponse(304, null, nowHeaders()));
      }
      return Promise.resolve(
        fakeResponse(200, wireBody(generatedAt), nowHeaders({ etag: ORIGIN_ETAG })),
      );
    };

    const app = wireApp(fetchFn);
    app.coordinator.start();
    await flush();

    await advance(30 * 60_000);

    // The safety snapshot ran and was answered `304` — the confirmation path this case
    // depends on was actually exercised, not merely available.
    expect(fullNotModified).toBeGreaterThan(0);
    expect(app.supervisor.state()).toBe('POLLING');
    expect(app.store.state().feedStatus).toBe('live');
    expect(pickBanner(app.store.state(), app.serverNow())).toBeNull();
  });
});
