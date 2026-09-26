import { describe, expect, it } from 'vitest';

import { Histogram, type HistogramData } from './histogram.js';

describe('Histogram', () => {
  it('answers quantiles within the bucket error', () => {
    const h = new Histogram();
    for (let ms = 1; ms <= 1_000; ms += 1) h.record(ms);
    expect(h.count).toBe(1_000);
    expect(h.quantile(0.95)).toBeGreaterThan(950 * 0.97);
    expect(h.quantile(0.95)).toBeLessThan(950 * 1.03);
    expect(h.quantile(1)).toBeLessThanOrEqual(1_000);
  });

  it('is empty-safe and ignores garbage', () => {
    const h = new Histogram();
    expect(h.quantile(0.5)).toBeNull();
    h.record(Number.NaN);
    h.record(-1);
    expect(h.count).toBe(0);
  });

  it('merges shards into the quantile of all samples, not an average of quantiles', () => {
    const fast = new Histogram();
    const slow = new Histogram();
    for (let i = 0; i < 90; i += 1) fast.record(10);
    for (let i = 0; i < 10; i += 1) slow.record(1_000);
    const all = Histogram.from(fast.toJSON());
    all.merge(slow.toJSON());
    expect(all.count).toBe(100);
    expect(all.quantile(0.95)).toBeGreaterThan(900);
    expect(
      Histogram.from(JSON.parse(JSON.stringify(all.toJSON())) as HistogramData).quantile(0.5),
    ).toBeLessThan(11);
  });
});
