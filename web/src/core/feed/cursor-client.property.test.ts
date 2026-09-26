/**
 * S15 — cursor-only removal convergence (ADR-003 A1.5, review 14 M1).
 *
 * The cursor request (`?updated_after_seq=N`) is a bandwidth optimization on the *version*
 * axis only: an event leaving the map bumps the global seq and emits nothing, so a client
 * that polled only cursors would never learn the removal. The client owes itself a full
 * snapshot at least every `safetySnapshotIntervalMs`, and the store treats only a full
 * snapshot as set authority. This suite drives the real client pipeline — polling feed,
 * store, supervisor and coordinator, everything `boot.ts` wires except the transports —
 * against a simulated origin and checks the one thing the fixture asks: after any
 * removal, the client's set matches the server's within one full-snapshot cycle, and it
 * never resurrects what the server dropped.
 */

import fc from 'fast-check';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_CONFIG, type ClientConfig } from '../config.js';
import type { Clock, PageLifecycle, Rng } from '../ports.js';
import { createFireEventStore } from '../store/index.js';
import { createFeedCoordinator } from './feed-coordinator.js';
import { createPollingFeed } from './polling-feed.js';
import { createServerTimeTracker } from './server-time.js';
import { createTransportSupervisor } from './supervisor.js';

const SECOND = 1_000;
const MINUTE = 60 * SECOND;
const BASE_EPOCH = '2026-07-14T10:00:00Z';

const CONFIG: ClientConfig = {
  ...DEFAULT_CONFIG,
  snapshotUrl: '/snapshot.json',
  pollIntervalMs: 45 * SECOND,
  pollJitterRatio: 0.2,
  safetySnapshotIntervalMs: 10 * MINUTE,
  sseEnabled: false,
};

/**
 * A1.5's bound: one full-snapshot cycle. The safety timer is re-armed by every full fetch
 * and jittered only downward, so a removal at `t` is on the wire by `t + safety`; the two
 * poll intervals cover the ordinary poll that may be pacing the loop at that instant.
 */
const CONVERGENCE_BOUND_MS = CONFIG.safetySnapshotIntervalMs + 2 * CONFIG.pollIntervalMs;

// ---------------------------------------------------------------------------------------
// The simulated origin: the wire contract of `/snapshot.json` (server `snapshot-route`).
// ---------------------------------------------------------------------------------------

interface ServerEvent {
  readonly id: string;
  readonly seq: number;
  readonly detectionCount: number;
}

interface SimServer {
  readonly active: () => ReadonlyMap<string, ServerEvent>;
  readonly maxSeq: () => number;
  readonly create: () => string;
  readonly update: (id: string) => void;
  readonly remove: (id: string) => void;
  /** Every snapshot request, in order: `null` cursor = full. */
  readonly requests: () => readonly { readonly cursor: number | null; readonly status: number }[];
  readonly fetchFn: typeof fetch;
}

function publicIdOf(n: number): string {
  return `fw-2026-${String(n)}`;
}

function wireFeature(event: ServerEvent): unknown {
  return {
    type: 'Feature',
    id: event.id,
    geometry: { type: 'Point', coordinates: [25.9, 41.93] },
    properties: {
      id: event.id,
      seq: event.seq,
      status: 'active',
      score_bucket: 'confirmed',
      merged_into: null,
      first_observed_at: '2026-07-14T08:00:00Z',
      last_observed_at: '2026-07-14T09:47:00Z',
      detection_count: event.detectionCount,
      place_name_bg: 'Харманли',
      place_name_en: 'Harmanli',
      area_ha: 320,
      next_pass_window: null,
    },
  };
}

/** Same shape as the polling-feed unit suite's stand-in: settles on the microtask queue. */
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

/**
 * Mirrors `SELECT_ACTIVE_SET` + the route: `max_seq` is the mark over the whole registry
 * (a removal bumps it although no active row carries it), members are the active rows
 * above the cursor, a cursor response is `partial: true`, the ETag is `"v1-<maxSeq>"` and
 * a matching `If-None-Match` is a `304` in either mode.
 */
function simServer(): SimServer {
  const active = new Map<string, ServerEvent>();
  const requests: { cursor: number | null; status: number }[] = [];
  let maxSeq = 0;
  let nextId = 1;
  const bump = (): number => {
    maxSeq += 1;
    return maxSeq;
  };

  const snapshotResponse = (cursor: number | null, ifNoneMatch: string | null): Response => {
    const etag = `"v1-${String(maxSeq)}"`;
    const date = new Date(Date.now()).toUTCString();
    if (ifNoneMatch !== null && ifNoneMatch.replace(/^W\//, '') === etag) {
      return fakeResponse(304, null, { etag, date });
    }
    const members = [...active.values()]
      .filter((event) => cursor === null || event.seq > cursor)
      .sort((a, b) => a.seq - b.seq);
    return fakeResponse(
      200,
      {
        type: 'FeatureCollection',
        schema_version: 1,
        generated_at: new Date(Date.now()).toISOString(),
        max_seq: maxSeq,
        partial: cursor !== null,
        sources: [],
        features: members.map(wireFeature),
      },
      { etag, date, 'content-type': 'application/geo+json' },
    );
  };

  const fetchFn: typeof fetch = (input, init) => {
    const raw =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const url = new URL(raw, 'http://origin.test');
    if (url.pathname !== CONFIG.snapshotUrl) {
      // The freshness side-poll: an unparseable body is skipped silently and is not the
      // subject here.
      return Promise.resolve(fakeResponse(200, {}));
    }
    const cursorParam = url.searchParams.get('updated_after_seq');
    const cursor = cursorParam === null ? null : Number(cursorParam);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const ifNoneMatch =
      Object.entries(headers).find(([key]) => key.toLowerCase() === 'if-none-match')?.[1] ?? null;
    const response = snapshotResponse(cursor, ifNoneMatch);
    requests.push({ cursor, status: response.status });
    return Promise.resolve(response);
  };

  return {
    active: () => active,
    maxSeq: () => maxSeq,
    create: () => {
      const n = nextId;
      nextId += 1;
      const id = publicIdOf(n);
      active.set(id, { id, seq: bump(), detectionCount: 1 });
      return id;
    },
    update: (id) => {
      const event = active.get(id);
      if (event === undefined) return;
      active.set(id, { ...event, seq: bump(), detectionCount: event.detectionCount + 1 });
    },
    remove: (id) => {
      // E1/E2: leaving the map is a seq bump with no frame and no row in any snapshot.
      if (active.delete(id)) bump();
    },
    requests: () => requests,
    fetchFn,
  };
}

// ---------------------------------------------------------------------------------------
// The real client pipeline, minus the browser adapters.
// ---------------------------------------------------------------------------------------

function client(server: SimServer) {
  const clock: Clock = { epochNow: () => Date.now(), monotonicNow: () => Date.now() };
  const rng: Rng = { next: () => 0.5 };
  const serverTime = createServerTimeTracker(clock);
  const store = createFireEventStore({ serverNow: serverTime.serverNow });
  const polling = createPollingFeed({
    config: CONFIG,
    clock,
    rng,
    fetchFn: server.fetchFn,
    serverTime,
  });
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
  const lifecycle: PageLifecycle = { onWake: () => () => {}, onOnline: () => () => {} };
  const coordinator = createFeedCoordinator({
    store,
    polling,
    stream: null,
    supervisor,
    lifecycle,
  });
  return {
    store,
    coordinator,
    /** The client's view of the set: every resident event that is not a tombstone. */
    activeIds: (): Set<string> =>
      new Set(
        [...store.state().events.values()]
          .filter((event) => event.mergedInto === null)
          .map((event) => event.id),
      ),
  };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 25; i += 1) await Promise.resolve();
}

async function advance(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
  await flush();
}

function sameSet(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) return false;
  for (const value of a) if (!b.has(value)) return false;
  return true;
}

beforeEach(() => {
  vi.useFakeTimers({ now: new Date(BASE_EPOCH) });
});

afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------------------
// The fixture narrative, step by step.
// ---------------------------------------------------------------------------------------

describe('S15 — a removal is invisible to cursor polls and lands with the next full snapshot', () => {
  it('keeps the removed event through cursor polls, drops it on the safety full fetch', async () => {
    const server = simServer();
    const a = server.create();
    const b = server.create();
    const { coordinator, activeIds } = client(server);
    coordinator.start();
    await flush();

    expect(activeIds()).toEqual(new Set([a, b]));
    expect(server.requests().at(-1)).toEqual({ cursor: null, status: 200 });

    server.remove(b);
    const removedAt = Date.now();

    // Ordinary polls are cursor requests; the server answers `partial: true` with no rows
    // and a bumped mark, and the store keeps B — a partial is never set authority.
    await advance(CONFIG.pollIntervalMs * 2);
    const cursorPolls = server.requests().filter((request) => request.cursor !== null);
    expect(cursorPolls.length).toBeGreaterThan(0);
    // The first cursor poll asks from the mark of the full snapshot (A = 1, B = 2); the
    // answer moves the mark to the removal's bump, and the store still shows B.
    expect(cursorPolls[0]?.cursor).toBe(2);
    expect(cursorPolls.at(-1)?.cursor).toBe(3);
    expect(activeIds()).toEqual(new Set([a, b]));

    // Within one full cycle the safety timer forces a full snapshot: B leaves.
    await advance(CONVERGENCE_BOUND_MS - (Date.now() - removedAt));
    const fulls = server.requests().filter((request) => request.cursor === null);
    expect(fulls.length).toBeGreaterThanOrEqual(2);
    expect(activeIds()).toEqual(new Set([a]));

    coordinator.stop();
  });
});

// ---------------------------------------------------------------------------------------
// The property: random server histories, one bound, no zombies.
// ---------------------------------------------------------------------------------------

type ServerOp =
  | { readonly type: 'create' }
  | { readonly type: 'update'; readonly pick: number }
  | { readonly type: 'remove'; readonly pick: number }
  | { readonly type: 'advance'; readonly ms: number };

const opArb: fc.Arbitrary<ServerOp> = fc.oneof(
  { weight: 3, arbitrary: fc.constant({ type: 'create' } as const) },
  { weight: 3, arbitrary: fc.nat({ max: 15 }).map((pick) => ({ type: 'update', pick }) as const) },
  { weight: 3, arbitrary: fc.nat({ max: 15 }).map((pick) => ({ type: 'remove', pick }) as const) },
  {
    weight: 6,
    arbitrary: fc
      .integer({ min: SECOND, max: 8 * MINUTE })
      .map((ms) => ({ type: 'advance', ms }) as const),
  },
);

function pickActive(server: SimServer, pick: number): string | null {
  const ids = [...server.active().keys()];
  const chosen = ids[pick % Math.max(ids.length, 1)];
  return chosen ?? null;
}

describe('S15 — property', () => {
  it('converges to the server set within one full cycle of every removal and never resurrects', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(opArb, { minLength: 10, maxLength: 60 }), async (ops) => {
        vi.clearAllTimers();
        vi.setSystemTime(new Date(BASE_EPOCH));

        const server = simServer();
        server.create();
        server.create();
        const { store, coordinator, activeIds } = client(server);
        coordinator.start();
        await flush();

        const removedAt = new Map<string, number>();
        const everRemoved = new Set<string>();

        const check = (): void => {
          const now = Date.now();
          const clientSet = activeIds();
          const serverSet = new Set(server.active().keys());
          for (const id of clientSet) {
            // Anything the client holds is either live on the server or was removed less
            // than one full cycle ago.
            if (serverSet.has(id)) continue;
            const at = removedAt.get(id);
            expect(at, `client holds ${id} the server never had`).toBeDefined();
            expect(now - (at ?? now), `removal of ${id} not converged`).toBeLessThanOrEqual(
              CONVERGENCE_BOUND_MS,
            );
          }
          // Versions never regress: a held event's seq is at most the server's.
          for (const event of store.state().events.values()) {
            const live = server.active().get(event.id);
            if (live !== undefined) expect(event.seq).toBeLessThanOrEqual(live.seq);
          }
        };

        for (const op of ops) {
          switch (op.type) {
            case 'create':
              server.create();
              break;
            case 'update': {
              const id = pickActive(server, op.pick);
              if (id !== null) server.update(id);
              break;
            }
            case 'remove': {
              const id = pickActive(server, op.pick);
              if (id !== null) {
                server.remove(id);
                removedAt.set(id, Date.now());
                everRemoved.add(id);
              }
              break;
            }
            case 'advance':
              await advance(op.ms);
              break;
          }
          check();
          // No zombies: once the client has dropped a removed id it stays dropped.
          for (const id of everRemoved) {
            if (!activeIds().has(id)) removedAt.delete(id);
            else expect(removedAt.has(id), `${id} came back`).toBe(true);
          }
        }

        // Settle for one full cycle: the sets are now identical, version for version.
        await advance(CONVERGENCE_BOUND_MS);
        check();
        const clientSet = activeIds();
        const serverSet = new Set(server.active().keys());
        expect(sameSet(clientSet, serverSet)).toBe(true);
        for (const [id, live] of server.active()) {
          expect(store.state().events.get(id)?.seq).toBe(live.seq);
        }
        expect(store.state().maxSeq).toBe(server.maxSeq());

        coordinator.stop();
      }),
      { numRuns: 80 },
    );
  }, 120_000);
});
