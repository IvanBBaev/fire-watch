import { describe, expect, it } from 'vitest';

import { sparklineGeometry } from './sparkline.js';

const BOX = { width: 100, height: 30, pad: 5 };

describe('sparklineGeometry', () => {
  it('is null for no data', () => {
    expect(sparklineGeometry([], BOX)).toBeNull();
    expect(sparklineGeometry([{ tMs: Number.NaN, value: 1 }], BOX)).toBeNull();
  });

  it('draws a single point as a short flat stroke in the middle', () => {
    const geometry = sparklineGeometry([{ tMs: 0, value: 10 }], BOX);
    expect(geometry?.points).toEqual([{ x: 50, y: 5 }]);
    expect(geometry?.path).toBe('M42 5L58 5');
  });

  it('scales time on x and value on y from a zero baseline', () => {
    const geometry = sparklineGeometry(
      [
        { tMs: 0, value: 0 },
        { tMs: 50, value: 5 },
        { tMs: 100, value: 10 },
      ],
      BOX,
    );
    expect(geometry?.points).toEqual([
      { x: 5, y: 25 },
      { x: 50, y: 15 },
      { x: 95, y: 5 },
    ]);
    expect(geometry?.path).toBe('M5 25L50 15L95 5');
  });

  it('spreads equal instants so neither point hides the other', () => {
    const geometry = sparklineGeometry(
      [
        { tMs: 7, value: 4 },
        { tMs: 7, value: 8 },
      ],
      BOX,
    );
    expect(geometry?.points.map((p) => p.x)).toEqual([5, 95]);
  });

  it('keeps a flat all-zero series on the baseline', () => {
    const geometry = sparklineGeometry(
      [
        { tMs: 0, value: 0 },
        { tMs: 1, value: 0 },
      ],
      BOX,
    );
    expect(geometry?.points.map((p) => p.y)).toEqual([25, 25]);
  });
});
