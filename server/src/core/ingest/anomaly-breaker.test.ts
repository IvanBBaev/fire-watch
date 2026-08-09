import { describe, expect, it } from 'vitest';

import { INGEST_ANOMALY, assertIngestAnomalyParams } from '../config/ingest-anomaly.js';
import { defineConfig } from '../config/versioned-config.js';
import { evaluateBatch, median } from './anomaly-breaker.js';

const { ratio, minBatchSize, minSamples, windowSize } = INGEST_ANOMALY.values;

/** `count` successful polls of `size` rows each — the boring history the breaker wants. */
function trailing(size: number, count = windowSize): number[] {
  return Array.from({ length: count }, () => size);
}

describe('evaluateBatch', () => {
  it('stays quiet on a batch that looks like the ones before it', () => {
    const decision = evaluateBatch(2100, trailing(2000));

    expect(decision.tripped).toBe(false);
    expect(decision.verdict).toBe('within_baseline');
    expect(decision.baseline).toBe(2000);
    expect(decision.ratio).toBe(1.05);
  });

  it('trips on a flood and says what it measured', () => {
    const decision = evaluateBatch(90_000, trailing(2000));

    expect(decision.tripped).toBe(true);
    expect(decision.verdict).toBe('above_baseline');
    expect(decision.baseline).toBe(2000);
    expect(decision.ratio).toBe(45);
  });

  it('treats exactly N× baseline as normal, and one row more as a flood', () => {
    // Strictly greater, so the boundary is a single pinned comparison rather than a place
    // two runs of the same replay can disagree about. The decision is taken on the exact
    // numbers; the recorded ratio is rounded for a human, which is why a batch one row over
    // the line still reports a flat 10.
    expect(evaluateBatch(2000 * ratio, trailing(2000)).tripped).toBe(false);

    const justOver = evaluateBatch(2000 * ratio + 1, trailing(2000));
    expect(justOver.tripped).toBe(true);
    expect(justOver.ratio).toBe(10);
  });

  it('is not armed until it has seen enough successful polls', () => {
    // A worker that has just been deployed, or has just come back from an outage, must not
    // quarantine its own first real batch.
    const decision = evaluateBatch(50_000, trailing(1, minSamples - 1));

    expect(decision.tripped).toBe(false);
    expect(decision.verdict).toBe('not_enough_history');
    expect(decision.baseline).toBeNull();
    expect(decision.ratio).toBeNull();
  });

  it('arms on the sample that completes the window', () => {
    expect(evaluateBatch(50_000, trailing(1, minSamples)).tripped).toBe(true);
  });

  it('never trips below the floor, however large the multiple', () => {
    // February: a median of two rows, and the first fire of the year brings forty. That is
    // twenty times the baseline and it is not an anomaly.
    const decision = evaluateBatch(minBatchSize - 1, trailing(2));

    expect(decision.tripped).toBe(false);
    expect(decision.verdict).toBe('below_floor');
    expect(decision.baseline).toBe(2);
  });

  it('trips out of complete silence only once the floor is cleared', () => {
    expect(evaluateBatch(minBatchSize - 1, trailing(0)).tripped).toBe(false);
    const decision = evaluateBatch(minBatchSize, trailing(0));

    expect(decision.tripped).toBe(true);
    expect(decision.baseline).toBe(0);
    // Infinity is not a number the archive can keep; the verdict carries the meaning.
    expect(decision.ratio).toBeNull();
    expect(JSON.stringify(decision)).toContain('"ratio":null');
  });

  it('looks no further back than the window', () => {
    // An August baseline must not be held down by an April one still sitting in the array.
    const history = [...trailing(2000, windowSize), ...trailing(5, 50)];

    expect(evaluateBatch(6000, history).baseline).toBe(2000);
  });

  it('records the config version the decision ran under', () => {
    expect(evaluateBatch(100, trailing(10)).configVersion).toBe('ingest_anomaly_v1');
  });

  it('replays under the version it is handed', () => {
    const config = defineConfig('ingest_anomaly', 'ingest_anomaly_v0', {
      ratio: 2,
      minBatchSize: 10,
      minSamples: 2,
      windowSize: 4,
    });
    const decision = evaluateBatch(30, trailing(10), { config });

    expect(decision.tripped).toBe(true);
    expect(decision.configVersion).toBe('ingest_anomaly_v0');
  });

  it('refuses a batch size that is not a count', () => {
    expect(() => evaluateBatch(-1, trailing(10))).toThrow(RangeError);
    expect(() => evaluateBatch(12.5, trailing(10))).toThrow(RangeError);
  });
});

describe('median', () => {
  it('takes the middle of an odd window and the mean of the middle two of an even one', () => {
    expect(median([5, 1, 3])).toBe(3);
    expect(median([4, 1, 3, 2])).toBe(2.5);
  });

  it('is not dragged upward by the flood it is measuring', () => {
    // Two artifact batches already in the window: a mean would raise the bar enough for the
    // third to pass, which is exactly backwards.
    const window = [...trailing(2000, 22), 90_000, 90_000];
    const mean = window.reduce((sum, value) => sum + value, 0) / window.length;

    expect(median(window)).toBe(2000);
    expect(mean).toBeGreaterThan(9000);
    expect(evaluateBatch(90_000, window).tripped).toBe(true);
  });

  it('has no answer for an empty window', () => {
    expect(() => median([])).toThrow(RangeError);
  });
});

describe('ingest_anomaly_v1', () => {
  it('is a set of parameters the breaker can actually arm under', () => {
    expect(() => {
      assertIngestAnomalyParams(INGEST_ANOMALY.values);
    }).not.toThrow();
    expect(INGEST_ANOMALY.version).toBe('ingest_anomaly_v1');
  });

  it('refuses parameters that would quarantine a merely busy batch', () => {
    expect(() => {
      assertIngestAnomalyParams({ ...INGEST_ANOMALY.values, ratio: 1 });
    }).toThrow(/greater than 1/);
  });

  it('refuses a window the breaker could never fill', () => {
    expect(() => {
      assertIngestAnomalyParams({ ...INGEST_ANOMALY.values, minSamples: windowSize + 1 });
    }).toThrow(/never arm/);
  });
});
