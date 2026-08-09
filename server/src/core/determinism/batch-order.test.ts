import { describe, expect, it } from 'vitest';

import { assertTotalOrder, compareDetections, orderBatch } from './batch-order.js';
import type { OrderableDetection } from './batch-order.js';

function detection(overrides: Partial<OrderableDetection> = {}): OrderableDetection {
  return {
    availableAt: 1_754_100_000_000,
    source: 'firms:viirs:noaa20',
    latCanonical: '42.10000',
    lonCanonical: '23.10000',
    detectionUid: 'a'.repeat(64),
    ...overrides,
  };
}

describe('compareDetections', () => {
  it('orders by available_at before anything else', () => {
    const early = detection({ availableAt: 1, source: 'lsasaf:fci:frp-pixel' });
    const late = detection({ availableAt: 2, source: 'eumetsat:slstr:frp' });
    expect(compareDetections(early, late)).toBeLessThan(0);
  });

  it('falls through source, lat, lon, then uid', () => {
    const a = detection({ source: 'firms:modis' });
    const b = detection({ source: 'firms:viirs:snpp' });
    expect(compareDetections(a, b)).toBeLessThan(0);

    const c = detection({ latCanonical: '42.10000' });
    const d = detection({ latCanonical: '42.10001' });
    expect(compareDetections(c, d)).toBeLessThan(0);

    const e = detection({ lonCanonical: '23.10000' });
    const f = detection({ lonCanonical: '23.10001' });
    expect(compareDetections(e, f)).toBeLessThan(0);

    const g = detection({ detectionUid: 'a'.repeat(64) });
    const h = detection({ detectionUid: 'b'.repeat(64) });
    expect(compareDetections(g, h)).toBeLessThan(0);
  });

  it('is total — only an identical key compares equal', () => {
    expect(compareDetections(detection(), detection())).toBe(0);
  });
});

describe('orderBatch', () => {
  const batch: OrderableDetection[] = [
    detection({ availableAt: 3, detectionUid: 'c'.repeat(64) }),
    detection({ availableAt: 1, detectionUid: 'a'.repeat(64) }),
    detection({ availableAt: 2, detectionUid: 'b'.repeat(64) }),
  ];

  it('produces the same order regardless of arrival order', () => {
    const forward = orderBatch(batch).map((d) => d.detectionUid);
    const reversed = orderBatch([...batch].reverse()).map((d) => d.detectionUid);
    expect(forward).toEqual(reversed);
    expect(forward).toEqual(['a'.repeat(64), 'b'.repeat(64), 'c'.repeat(64)]);
  });

  it('does not mutate the caller´s array', () => {
    const input = [...batch];
    orderBatch(input);
    expect(input).toEqual(batch);
  });
});

describe('assertTotalOrder', () => {
  it('accepts a well-ordered batch', () => {
    expect(() => {
      assertTotalOrder(orderBatch([detection({ availableAt: 2 }), detection({ availableAt: 1 })]));
    }).not.toThrow();
  });

  it('rejects two rows that share a full key', () => {
    expect(() => {
      assertTotalOrder([detection(), detection()]);
    }).toThrow(/not total/);
  });
});
