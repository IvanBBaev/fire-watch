import { describe, expect, it } from 'vitest';

import { FIRE_OUTLINE_PARAMS } from '../config/fire-outline.js';
import { defineConfig } from '../config/versioned-config.js';
import { VirtualClock } from '../ports/clock.js';
import type {
  FireOutlineCandidate,
  FireOutlineRow,
  FireOutlineStore,
} from '../ports/fire-outline-store.js';
import type { OutlineDetection } from './fire-outline.js';
import { runFireOutlinePass } from './fire-outline-pass.js';

function fakeStore(
  candidates: readonly FireOutlineCandidate[],
  members: Readonly<Record<string, readonly OutlineDetection[]>>,
): FireOutlineStore & {
  saved: FireOutlineRow[];
  passes: { version: string; at: number }[];
  limits: number[];
} {
  const saved: FireOutlineRow[] = [];
  const passes: { version: string; at: number }[] = [];
  const limits: number[] = [];
  return {
    saved,
    passes,
    limits,
    pendingEvents: (_version, limit) => {
      limits.push(limit);
      return Promise.resolve(candidates.slice(0, limit));
    },
    members: (eventId, limit) => {
      limits.push(limit);
      return Promise.resolve(members[eventId] ?? []);
    },
    save: (rows) => {
      saved.push(...rows);
      return Promise.resolve();
    },
    recordPass: (version, at) => {
      passes.push({ version, at });
      return Promise.resolve();
    },
  };
}

const AT = '2026-08-15T12:00:00Z';

describe('runFireOutlinePass', () => {
  it('draws each pending event, stores an empty answer too, and records the pass', async () => {
    const store = fakeStore(
      [
        { eventId: '1', detectionCount: 1, lastDetectionAt: Date.parse(AT) - 60_000 },
        { eventId: '2', detectionCount: 1, lastDetectionAt: Date.parse(AT) - 120_000 },
      ],
      {
        '1': [
          { uid: 'a', sourceId: 'firms:viirs:snpp', lat: 42.7, lon: 25, scanKm: 0.4, trackKm: 0.4 },
        ],
        '2': [
          {
            uid: 'b',
            sourceId: 'lsasaf:seviri:frp-pixel',
            lat: 42.7,
            lon: 25,
            scanKm: null,
            trackKm: null,
          },
        ],
      },
    );
    const clock = new VirtualClock(AT);

    const report = await runFireOutlinePass({ store, clock });

    expect(report).toEqual({
      paramsVersion: 'fire_outline_params_v1',
      pending: 2,
      drawn: 1,
      empty: 1,
      backlog: false,
    });
    expect(store.saved.map((r) => [r.eventId, r.geometry === null, r.detectionCount])).toEqual([
      ['1', false, 1],
      ['2', true, 1],
    ]);
    expect(store.saved[0]?.paramsVersion).toBe('fire_outline_params_v1');
    expect(store.saved[0]?.computedAt).toBe(Date.parse(AT));
    expect(store.passes).toEqual([{ version: 'fire_outline_params_v1', at: Date.parse(AT) }]);
    expect(store.limits).toEqual([
      FIRE_OUTLINE_PARAMS.values.batchSize,
      FIRE_OUTLINE_PARAMS.values.maxDetections,
      FIRE_OUTLINE_PARAMS.values.maxDetections,
    ]);
  });

  it('records a pass even when nothing is pending', async () => {
    const store = fakeStore([], {});
    await runFireOutlinePass({ store, clock: new VirtualClock(AT) });
    expect(store.passes).toHaveLength(1);
  });

  it('reports a backlog when the batch is full', async () => {
    const params = defineConfig('fire_outline_params', 'fire_outline_params_v99', {
      ...FIRE_OUTLINE_PARAMS.values,
      batchSize: 1,
    });
    const store = fakeStore(
      [
        { eventId: '1', detectionCount: 1, lastDetectionAt: 0 },
        { eventId: '2', detectionCount: 1, lastDetectionAt: 0 },
      ],
      {},
    );
    const report = await runFireOutlinePass({ store, clock: new VirtualClock(AT), params });
    expect(report.backlog).toBe(true);
    expect(report.paramsVersion).toBe('fire_outline_params_v99');
    expect(store.saved).toHaveLength(1);
  });
});
