import { deflateSync } from 'node:zlib';

import { describe, expect, it } from 'vitest';

import { storedInflate, zlibStored } from '../../core/effis/png-testkit.js';

import { zlibInflate } from './zlib-inflate.js';

describe('zlibInflate', () => {
  const plain = new Uint8Array(4096).map((_v, i) => i % 251);
  const compressed = new Uint8Array(deflateSync(plain));

  it('inflates a well-formed stream up to the cap', () => {
    expect(zlibInflate(compressed, plain.byteLength)).toEqual(plain);
  });

  it('returns null when the output would exceed the cap (bomb guard)', () => {
    expect(zlibInflate(compressed, plain.byteLength - 1)).toBeNull();
  });

  it('returns null for corrupt and truncated streams instead of throwing', () => {
    expect(zlibInflate(new Uint8Array([1, 2, 3, 4]), 100)).toBeNull();
    expect(zlibInflate(compressed.subarray(0, compressed.byteLength - 6), 100_000)).toBeNull();
  });

  it('returns null for a nonsensical cap', () => {
    expect(zlibInflate(compressed, -1)).toBeNull();
    expect(zlibInflate(compressed, Number.NaN)).toBeNull();
  });

  it('agrees with the core test kit on the same stream, both directions', () => {
    // The core tests inject the kit's stored-block inflater; this pins it to real zlib.
    const stored = zlibStored(plain);
    expect(zlibInflate(stored, plain.byteLength)).toEqual(plain);
    expect(storedInflate(stored, plain.byteLength)).toEqual(plain);
    const big = new Uint8Array(70_000).map((_v, i) => i & 0xff);
    expect(zlibInflate(zlibStored(big), big.byteLength)).toEqual(big);
  });
});
