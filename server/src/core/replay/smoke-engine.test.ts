import { describe, expect, it } from 'vitest';

import { VirtualClock } from '../ports/clock.js';
import { EMPTY_OBSERVATIONS } from './fixture-format.js';
import { createSmokeEngine } from './smoke-engine.js';
import type { ReplayContext, ReplayDetection } from './runner.js';

const uid = (n: number): string => String(n).padStart(64, '0');

const detection = (n: number, lat: string, lon = '26.14003'): ReplayDetection => ({
  detectionUid: uid(n),
  source: 'firms:viirs:snpp',
  availableAt: Date.parse('2026-08-02T11:41:00Z'),
  acqTsIso: '2026-08-02T11:24:00Z',
  latCanonical: lat,
  lonCanonical: lon,
  confidence: 'nominal',
  frpMw: 12.5,
  dayNight: 'D',
});

function context(): ReplayContext {
  return {
    clock: new VirtualClock('2026-08-02T11:41:00Z'),
    configVersions: { smoke: 'smoke_engine_v1' },
    mode: 'live',
    allowRevive: false,
    // The smoke engine has no lifecycle to read them with, and must not grow one.
    observations: EMPTY_OBSERVATIONS,
    emitAlert: () => {
      throw new Error('the smoke engine has no alerting and must never grow any');
    },
  };
}

describe('createSmokeEngine', () => {
  it('groups detections that share a canonical cell', () => {
    const engine = createSmokeEngine(context());
    engine.ingest([detection(1, '41.85012'), detection(2, '41.85012'), detection(3, '41.86114')]);

    const events = engine.events();

    expect(events.map((event) => event.publicId)).toEqual(['smoke-001', 'smoke-002']);
    expect(events[0]?.detectionUids).toEqual([uid(1), uid(2)]);
    expect(events[1]?.detectionUids).toEqual([uid(3)]);
  });

  it('carries a group across polls', () => {
    const engine = createSmokeEngine(context());
    engine.ingest([detection(1, '41.85012')]);
    engine.ingest([detection(2, '41.85012'), detection(3, '41.90001')]);

    expect(engine.events()).toHaveLength(2);
    expect(engine.events()[0]?.detectionUids).toEqual([uid(1), uid(2)]);
  });

  it('mints ids in the order it first sees a cell', () => {
    // This is the property that makes the engine a determinism probe rather than a
    // placeholder: an order-insensitive grouping would pass CI-2 with `orderBatch`
    // deleted, and would therefore prove nothing about the harness.
    const first = createSmokeEngine(context());
    first.ingest([detection(1, '41.85012'), detection(3, '41.86114')]);

    const second = createSmokeEngine(context());
    second.ingest([detection(3, '41.86114'), detection(1, '41.85012')]);

    expect(first.events()[0]?.detectionUids).toEqual([uid(1)]);
    expect(second.events()[0]?.detectionUids).toEqual([uid(3)]);
  });

  it('reports one fixed lifecycle state, because it has no lifecycle', () => {
    const engine = createSmokeEngine(context());
    engine.ingest([detection(1, '41.85012')]);

    expect(engine.events()[0]).toMatchObject({
      status: 'active',
      bucket: 'unverified',
      mergedInto: null,
      relation: null,
      labels: [],
    });
  });
});
