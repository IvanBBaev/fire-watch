import type { HeartbeatJobId } from '@fire-watch/contracts';
import { describe, expect, it } from 'vitest';

import { VirtualClock } from '../core/ports/clock.js';
import type { ObjectToStore, PublicObjectObservation } from '../core/ports/object-store.js';
import type { Sleeper } from '../core/ports/sleeper.js';
import { loadConfig } from './config.js';
import { createProcessMetrics, loopObserver } from './metrics-wiring.js';
import type { R2MirrorConfig } from './r2-mirror-config.js';
import {
  MIRROR_AGE_INTERVAL_MS,
  MIRROR_PUSH_INTERVAL_MS,
  startR2MirrorLoops,
  wireR2Mirror,
  type R2MirrorWiring,
} from './r2-mirror-wiring.js';

const SERVER = loadConfig(
  {
    DATABASE_URL: 'postgres://fire_watch:hunter2@127.0.0.1:1/fire_watch',
    FIRMS_MAP_KEY: 'testtesttesttesttesttesttesttest',
  },
  'fire-watch-worker',
);

const MIRROR: R2MirrorConfig = {
  endpoint: 'https://acct123.eu.r2.cloudflarestorage.com',
  bucket: 'fire-watch-t2',
  objectKey: 'snapshot.json',
  accessKeyId: 'a1b2c3d4e5f60718293a4b5c6d7e8f90',
  secretAccessKey: 'Zm9vYmFyYmF6cXV4c2VjcmV0c2VjcmV0c2VjcmV0MTI=',
  publicUrl: 'https://t2.fire-watch.example/snapshot.json',
};

describe('wireR2Mirror', () => {
  it('is off, with a reason, when the group is unset', () => {
    expect(wireR2Mirror(SERVER, null)).toEqual({
      kind: 'disabled',
      reason: 'FIRE_WATCH_R2_* is not configured',
    });
  });

  it('pushes but does not monitor without a public URL', async () => {
    const wiring = wireR2Mirror(SERVER, { ...MIRROR, publicUrl: null });
    expect(wiring).toMatchObject({
      kind: 'enabled',
      probe: null,
      monitorDisabledReason: 'FIRE_WATCH_STATIC_SNAPSHOT_URL is not set',
    });
    if (wiring.kind === 'enabled') await wiring.close();
  });

  it('wires both, on the snapshot-push budget, with no feed-status claim sans state dir', async () => {
    const wiring = wireR2Mirror(SERVER, MIRROR);
    expect(wiring.kind).toBe('enabled');
    if (wiring.kind !== 'enabled') return;
    expect(wiring.probe).not.toBeNull();
    expect(wiring.monitorDisabledReason).toBeNull();
    expect(wiring.budget).toMatchObject({ warnSeconds: 300, criticalSeconds: 900 });
    expect(wiring.pushDeps.objectKey).toBe('snapshot.json');
    expect(wiring.pushDeps.feedStatus).toBeNull();
    await wiring.close();
  });
});

describe('startR2MirrorLoops', () => {
  const START = '2026-07-14T10:15:00Z';

  function runtime(clock: VirtualClock, controller: AbortController, stopAfter: number) {
    const lines: string[] = [];
    const pings: HeartbeatJobId[] = [];
    const pauses: number[] = [];
    const sleeper: Sleeper = {
      sleep(ms: number) {
        pauses.push(ms);
        clock.advanceMs(ms);
        if (pauses.length >= stopAfter) controller.abort();
        return Promise.resolve();
      },
    };
    return {
      lines,
      pings,
      pauses,
      runtime: {
        clock,
        sleeper,
        heartbeat: {
          succeeded: (job: HeartbeatJobId) => {
            pings.push(job);
            return Promise.resolve();
          },
        },
        writeLine: (line: string) => lines.push(line),
      },
    };
  }

  function enabled(
    clock: VirtualClock,
    puts: ObjectToStore[],
    observe: () => PublicObjectObservation,
  ): Extract<R2MirrorWiring, { kind: 'enabled' }> {
    return {
      kind: 'enabled',
      pushDeps: {
        reader: {
          readActiveSet: () => Promise.resolve({ maxSeq: 3, events: [] }),
          readSourceObservations: () => Promise.resolve([]),
        },
        store: {
          put: (object) => {
            puts.push(object);
            return Promise.resolve({ etag: '"e"' });
          },
          head: () => Promise.resolve(null),
        },
        clock,
        sources: [],
        objectKey: 'snapshot.json',
        feedStatus: null,
      },
      probe: { head: () => Promise.resolve(observe()) },
      monitorDisabledReason: null,
      budget: { warnSeconds: 300, criticalSeconds: 900 },
      close: () => Promise.resolve(),
    };
  }

  it('runs the push and the age check each minute, and reports both', async () => {
    const clock = new VirtualClock(START);
    const controller = new AbortController();
    const h = runtime(clock, controller, 4);
    const puts: ObjectToStore[] = [];
    const wiring = enabled(clock, puts, () => ({
      kind: 'present',
      status: 200,
      // The two loops start together, so the object the probe sees is the previous push's.
      generatedAtMs: clock.now() - 20_000,
      lastModifiedMs: null,
      etag: null,
      cacheControl: null,
    }));

    const loops = startR2MirrorLoops(wiring, h.runtime, controller.signal);
    expect(loops.map(([name]) => name)).toEqual(['r2_mirror_push', 'r2_mirror_age']);
    await Promise.all(loops.map(([, stats]) => stats));

    expect(MIRROR_PUSH_INTERVAL_MS).toBe(60_000);
    expect(MIRROR_AGE_INTERVAL_MS).toBe(60_000);
    expect(puts.length).toBeGreaterThanOrEqual(1);
    expect(h.pings.every((job) => job === 'snapshot-push')).toBe(true);
    expect(h.pings.length).toBe(puts.length);
    const ages = h.lines
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((line) => 'r2_mirror_age' in line);
    expect(ages.length).toBeGreaterThanOrEqual(1);
    expect(ages[0]).toMatchObject({ degraded: false, r2_mirror_age: { level: 'ok' } });
  });

  it('records both loops through the observe hook under their own names (C5)', async () => {
    const clock = new VirtualClock(START);
    const controller = new AbortController();
    const h = runtime(clock, controller, 4);
    const registry = createProcessMetrics();
    const wiring = enabled(clock, [], () => ({ kind: 'missing', status: 404 }));
    const loops = startR2MirrorLoops(
      wiring,
      { ...h.runtime, observe: loopObserver(registry, () => {}) },
      controller.signal,
    );
    await Promise.all(loops.map(([, stats]) => stats));
    const text = await registry.render();
    expect(text).toMatch(/fw_loop_runs_total\{loop="r2_mirror_push",outcome="ok"\} \d+\n/);
    expect(text).toMatch(/fw_loop_runs_total\{loop="r2_mirror_age",outcome="ok"\} \d+\n/);
    // The reporters still run: the hook wraps them, it does not replace them.
    expect(h.lines.some((line) => line.includes('r2_mirror_age'))).toBe(true);
  });

  it('omits the age loop without a probe', () => {
    const clock = new VirtualClock(START);
    const controller = new AbortController();
    controller.abort();
    const wiring = { ...enabled(clock, [], () => ({ kind: 'missing', status: 404 })), probe: null };
    const loops = startR2MirrorLoops(
      wiring,
      runtime(clock, controller, 1).runtime,
      controller.signal,
    );
    expect(loops.map(([name]) => name)).toEqual(['r2_mirror_push']);
  });
});
