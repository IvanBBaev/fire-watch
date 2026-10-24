import { describe, expect, it } from 'vitest';

import { BoundedCache } from './bounded-cache.js';

const bytes = (n: number): Uint8Array => new Uint8Array(n);

describe('BoundedCache (TASKS V2-D4)', () => {
  it('evicts the least recently used entry when the entry bound is hit', () => {
    const cache = new BoundedCache<Uint8Array>({ maxEntries: 2, maxBytes: 1_000 });
    cache.set('a', bytes(1));
    cache.set('b', bytes(1));
    expect(cache.get('a')).toBeDefined();
    cache.set('c', bytes(1));
    expect(cache.get('b')).toBeUndefined();
    expect(cache.get('a')).toBeDefined();
    expect(cache.get('c')).toBeDefined();
    expect(cache.size).toBe(2);
  });

  it('evicts until the byte bound holds', () => {
    const cache = new BoundedCache<Uint8Array>({ maxEntries: 10, maxBytes: 10 });
    cache.set('a', bytes(4));
    cache.set('b', bytes(4));
    cache.set('c', bytes(4));
    expect(cache.get('a')).toBeUndefined();
    expect(cache.bytes).toBe(8);
  });

  it('never stores a value larger than the byte bound', () => {
    const cache = new BoundedCache<Uint8Array>({ maxEntries: 10, maxBytes: 10 });
    cache.set('a', bytes(4));
    cache.set('huge', bytes(11));
    expect(cache.get('huge')).toBeUndefined();
    expect(cache.get('a')).toBeDefined();
    expect(cache.bytes).toBe(4);
  });

  it('replaces a key without double-counting its bytes', () => {
    const cache = new BoundedCache<Uint8Array>({ maxEntries: 10, maxBytes: 10 });
    cache.set('a', bytes(4));
    cache.set('a', bytes(6));
    expect(cache.size).toBe(1);
    expect(cache.bytes).toBe(6);
  });
});
