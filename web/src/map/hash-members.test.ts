/**
 * The camera shares the fragment with the filters and the sign-in token: writing the
 * camera must keep them, and every permalink ever written (`#map=…` alone) must still open.
 */

import { describe, expect, it } from 'vitest';

import { parseFilterHash, withFilterHash } from '../core/filter/filter-hash.js';
import { parseMapHash, withMapHash } from './hash.js';

const VIEW = { zoom: 7.2, lat: 42.7, lon: 25.3 };

describe('withMapHash', () => {
  it('writes the camera alone into an empty fragment, as before', () => {
    expect(withMapHash('', VIEW)).toBe('#map=7.2/42.7000/25.3000');
  });

  it('replaces only the camera, keeping filters, token and unknown members', () => {
    const before = '#map=5.0/40.0000/20.0000&t=3h&src=v&r=22&token=abc&future=1';
    const after = withMapHash(before, VIEW);
    expect(after).toBe('#map=7.2/42.7000/25.3000&t=3h&src=v&r=22&token=abc&future=1');
    expect(parseMapHash(after)).toStrictEqual(VIEW);
    expect(parseFilterHash(after)).toStrictEqual({ window: '3h', family: 'v', oblast: 22 });
  });

  it('round-trips with the filter writer in either order', () => {
    const selection = { window: '12h', family: 'g', oblast: 9 } as const;
    const a = withFilterHash(withMapHash('', VIEW), selection);
    const b = withMapHash(withFilterHash('', selection), VIEW);
    for (const hash of [a, b]) {
      expect(parseMapHash(hash)).toStrictEqual(VIEW);
      expect(parseFilterHash(hash)).toStrictEqual(selection);
    }
  });
});
