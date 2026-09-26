import { describe, expect, it } from 'vitest';

import type { ChangeReader, ChangeRow, ChangesRead } from '../ports/change-reader.js';
import { VirtualClock } from '../ports/clock.js';
import type { ActiveSetRead, SnapshotReader } from '../ports/snapshot-reader.js';
import { createStreamPump, type StreamPumpOptions } from './stream-pump.js';
import { T0, activeRow, changeRow } from './test-rows.js';

interface Harness {
  readonly pump: ReturnType<typeof createStreamPump>;
  readonly clock: VirtualClock;
  readonly broadcasts: string[];
  /** Rows the next change reads hand back, consumed one batch per read. */
  readonly batches: ChangesRead[];
  readonly calls: {
    readonly activeSet: number[];
    readonly changes: [number, number][];
    observations: number;
  };
  active: ActiveSetRead;
  failActiveSet: boolean;
  failChanges: boolean;
  failObservations: boolean;
}

function harness(overrides: Partial<StreamPumpOptions> = {}): Harness {
  const clock = new VirtualClock(T0);
  const broadcasts: string[] = [];
  const batches: ChangesRead[] = [];
  const calls = { activeSet: [] as number[], changes: [] as [number, number][], observations: 0 };
  const h: Omit<Harness, 'pump'> = {
    clock,
    broadcasts,
    batches,
    calls,
    active: { maxSeq: 1040, events: [activeRow({ publicId: 'a', seq: 1040 })] },
    failActiveSet: false,
    failChanges: false,
    failObservations: false,
  };
  const snapshotReader: SnapshotReader = {
    readActiveSet: (afterSeq) => {
      calls.activeSet.push(afterSeq);
      if (h.failActiveSet) return Promise.reject(new Error('db down'));
      return Promise.resolve(h.active);
    },
    readSourceObservations: (ids) => {
      calls.observations += 1;
      if (h.failObservations) return Promise.reject(new Error('db down'));
      return Promise.resolve(ids.map((sourceId) => ({ sourceId, lastObservedAt: null })));
    },
  };
  const changeReader: ChangeReader = {
    readChangesSince: (afterSeq, limit) => {
      calls.changes.push([afterSeq, limit]);
      if (h.failChanges) return Promise.reject(new Error('db down'));
      const next = batches.shift();
      return Promise.resolve(next ?? { maxSeq: afterSeq, rows: [] });
    },
  };
  const pump = createStreamPump({
    snapshotReader,
    changeReader,
    hub: { broadcast: (chunk) => broadcasts.push(chunk) },
    clock,
    sources: ['firms-modis'],
    ringCapacity: 10,
    batchLimit: 2,
    maxBatchesPerTick: 3,
    freshnessIntervalMs: 30_000,
    ...overrides,
  });
  return Object.assign(h, { pump });
}

function batch(rows: ChangeRow[], maxSeq?: number): ChangesRead {
  return { maxSeq: maxSeq ?? rows.at(-1)?.seq ?? 0, rows };
}

function events(broadcasts: readonly string[]): string[] {
  return broadcasts.map((chunk) => /^(?:id: \d+\n)?event: ([^\n]+)/.exec(chunk)?.[1] ?? '?');
}

describe('createStreamPump', () => {
  it('is not ready before the first tick and answers every replay with a reset', () => {
    const h = harness();
    expect(h.pump.ready()).toBe(false);
    expect(h.pump.replayAfter(1040)).toEqual({ kind: 'reset', reason: 'too_old' });
    expect(h.pump.freshness()).toBeNull();
  });

  it('seeds from the full active set: cursor at max seq, one freshness frame, no event frames', async () => {
    const h = harness();
    await h.pump.tick();
    expect(h.pump.ready()).toBe(true);
    expect(h.calls.activeSet).toEqual([0]);
    expect(h.calls.changes).toEqual([[1040, 2]]);
    expect(events(h.broadcasts)).toEqual(['freshness']);
    expect(h.pump.freshness()).toEqual({
      event: 'freshness',
      data: {
        generated_at: '2026-07-14T10:15:00Z',
        max_seq: 1040,
        sources: [{ source_id: 'firms-modis', last_observed_at: null }],
      },
    });
    // The seed's max seq is the floor: a client holding it replays nothing, one below resets.
    expect(h.pump.replayAfter(1040)).toEqual({ kind: 'replay', frames: [] });
    expect(h.pump.replayAfter(1039)).toEqual({ kind: 'reset', reason: 'too_old' });
  });

  it('stays unready when the seed fails, and seeds on the next tick', async () => {
    const h = harness();
    h.failActiveSet = true;
    await expect(h.pump.tick()).rejects.toThrow('db down');
    expect(h.pump.ready()).toBe(false);
    expect(h.broadcasts).toEqual([]);
    h.failActiveSet = false;
    await h.pump.tick();
    expect(h.pump.ready()).toBe(true);
  });

  it('projects a change batch into frames, pushes them into the ring and broadcasts them', async () => {
    const h = harness();
    await h.pump.tick();
    h.broadcasts.length = 0;
    h.batches.push(
      batch([changeRow({ publicId: 'a', seq: 1041 }), changeRow({ publicId: 'b', seq: 1042 })]),
    );
    h.batches.push(batch([]));
    await h.pump.tick();
    expect(events(h.broadcasts)).toEqual(['event.updated', 'event.created', 'freshness']);
    expect(h.broadcasts[0]?.startsWith('id: 1041\n')).toBe(true);
    const replay = h.pump.replayAfter(1040);
    expect(replay.kind).toBe('replay');
    if (replay.kind === 'replay') expect(replay.frames.map((f) => f.id)).toEqual([1041, 1042]);
    // The cursor moved to the last row read, not to the batch's max mark.
    expect(h.calls.changes.at(-1)).toEqual([1041 + 1, 2]);
  });

  it('keeps reading while batches come back full, up to the per-tick bound', async () => {
    const h = harness();
    await h.pump.tick();
    for (let i = 0; i < 5; i += 1) {
      const base = 1040 + i * 2;
      h.batches.push(
        batch([
          changeRow({ publicId: 'x', seq: base + 1 }),
          changeRow({ publicId: 'x', seq: base + 2 }),
        ]),
      );
    }
    h.calls.changes.length = 0;
    await h.pump.tick();
    // Three full batches this tick (the bound), and the next tick resumes from 1046.
    expect(h.calls.changes).toEqual([
      [1040, 2],
      [1042, 2],
      [1044, 2],
    ]);
    h.calls.changes.length = 0;
    await h.pump.tick();
    expect(h.calls.changes[0]).toEqual([1046, 2]);
  });

  it('reports the registry’s max seq in freshness even when the change was not a frame', async () => {
    const h = harness();
    await h.pump.tick();
    h.broadcasts.length = 0;
    // A row leaving the map: no event frame, but the mark moved and the client must learn it.
    h.batches.push(batch([changeRow({ publicId: 'a', seq: 1041, displayTier: 'archive' })]));
    await h.pump.tick();
    expect(events(h.broadcasts)).toEqual(['freshness']);
    expect(h.pump.freshness()?.data).toMatchObject({ max_seq: 1041 });
    expect(h.pump.replayAfter(1040)).toEqual({ kind: 'replay', frames: [] });
  });

  it('sends freshness on the interval when nothing moved, and not before', async () => {
    const h = harness();
    await h.pump.tick();
    h.broadcasts.length = 0;
    h.clock.advanceMs(29_999);
    await h.pump.tick();
    expect(h.broadcasts).toEqual([]);
    h.clock.advanceMs(1);
    await h.pump.tick();
    expect(events(h.broadcasts)).toEqual(['freshness']);
    expect(h.calls.observations).toBe(2);
  });

  it('leaves the cursor where it was when a change read fails, and resumes from there', async () => {
    const h = harness();
    await h.pump.tick();
    h.failChanges = true;
    await expect(h.pump.tick()).rejects.toThrow('db down');
    h.failChanges = false;
    h.calls.changes.length = 0;
    await h.pump.tick();
    expect(h.calls.changes[0]).toEqual([1040, 2]);
  });

  it('keeps the frames it already sent when the freshness read fails afterwards', async () => {
    const h = harness();
    await h.pump.tick();
    h.batches.push(batch([changeRow({ publicId: 'b', seq: 1041 })]));
    h.failObservations = true;
    await expect(h.pump.tick()).rejects.toThrow('db down');
    expect(h.pump.replayAfter(1040)).toMatchObject({ kind: 'replay', frames: [{ id: 1041 }] });
    // ...and does not read the same rows twice on recovery.
    h.failObservations = false;
    h.calls.changes.length = 0;
    await h.pump.tick();
    expect(h.calls.changes[0]).toEqual([1041, 2]);
  });

  it('joins a tick that is already in flight rather than starting another', async () => {
    const h = harness();
    const first = h.pump.tick();
    const second = h.pump.tick();
    expect(second).toBe(first);
    await first;
    expect(h.calls.activeSet).toEqual([0]);
    // Once settled, the next call is a fresh tick.
    await h.pump.tick();
    expect(h.calls.changes).toHaveLength(2);
  });

  it('refuses nonsensical batch bounds', () => {
    expect(() => harness({ batchLimit: 0 })).toThrow(RangeError);
    expect(() => harness({ maxBatchesPerTick: 0 })).toThrow(RangeError);
  });
});
