import { describe, expect, it } from 'vitest';

import type { FilterSelection } from './filter-hash.js';
import { DEFAULT_FILTERS, parseFilterHash, withFilterHash } from './filter-hash.js';
import { DEFAULT_SENSITIVITY, SENSITIVITY_PRESETS } from './sensitivity.js';

const ALL = DEFAULT_SENSITIVITY;

describe('filter hash', () => {
  it('writes only what differs from the defaults', () => {
    expect(withFilterHash('', DEFAULT_FILTERS)).toBe('');
    expect(withFilterHash('', { window: '6h', family: 'v', oblast: 22, sensitivity: ALL })).toBe(
      '#t=6h&src=v&r=22',
    );
    expect(withFilterHash('#t=6h&src=v&r=22', DEFAULT_FILTERS)).toBe('');
  });

  it('round-trips every window, family and oblast', () => {
    const selections: FilterSelection[] = [
      { window: '1h', family: null, oblast: null, sensitivity: ALL },
      { window: '3h', family: 'm', oblast: 1, sensitivity: ALL },
      { window: '12h', family: 's', oblast: 28, sensitivity: ALL },
      { window: '48h', family: 'g', oblast: 23, sensitivity: ALL },
      { window: 'all', family: 'v', oblast: 16, sensitivity: SENSITIVITY_PRESETS.multi },
      { window: '6h', family: null, oblast: null, sensitivity: SENSITIVITY_PRESETS.balanced },
      {
        window: '6h',
        family: null,
        oblast: null,
        sensitivity: { minBand: 'confirmed', minDetections: 3, minSensors: 1 },
      },
    ];
    for (const selection of selections) {
      const parsed = parseFilterHash(withFilterHash('', selection));
      expect({ ...DEFAULT_FILTERS, ...parsed }).toStrictEqual(selection);
    }
  });

  it('keeps the camera, a sign-in token and unknown members', () => {
    const hash = withFilterHash('#map=7.0/42.7000/25.3000&token=abc&future=1', {
      window: '3h',
      family: null,
      oblast: 5,
      sensitivity: ALL,
    });
    expect(hash).toBe('#map=7.0/42.7000/25.3000&token=abc&future=1&t=3h&r=5');
  });

  it('reads a camera-only link — every link written before filters — as saying nothing', () => {
    expect(parseFilterHash('#map=7.0/42.7000/25.3000')).toStrictEqual({});
    expect(parseFilterHash('')).toStrictEqual({});
  });

  it('writes the sensitivity as a preset token or a custom triple, never the default', () => {
    const base = { window: DEFAULT_FILTERS.window, family: null, oblast: null } as const;
    expect(withFilterHash('', { ...base, sensitivity: SENSITIVITY_PRESETS.balanced })).toBe(
      '#sens=bal',
    );
    expect(withFilterHash('', { ...base, sensitivity: SENSITIVITY_PRESETS.multi })).toBe(
      '#sens=multi',
    );
    expect(
      withFilterHash('', {
        ...base,
        sensitivity: { minBand: 'confirmed', minDetections: 1, minSensors: 2 },
      }),
    ).toBe('#sens=c.1.2');
    expect(withFilterHash('#sens=bal', DEFAULT_FILTERS)).toBe('');
    expect(parseFilterHash('#sens=all')).toStrictEqual({ sensitivity: ALL });
  });

  it('ignores invalid members one by one', () => {
    expect(parseFilterHash('#t=7d&src=x&r=29')).toStrictEqual({});
    expect(parseFilterHash('#t=7d&src=m&r=0')).toStrictEqual({ family: 'm' });
    expect(parseFilterHash('#r=07')).toStrictEqual({ oblast: 7 });
    expect(parseFilterHash('#sens=x.2.1&src=v')).toStrictEqual({ family: 'v' });
    expect(parseFilterHash('#sens=l.0.1')).toStrictEqual({});
    expect(parseFilterHash('#sens=l.2')).toStrictEqual({});
  });
});
