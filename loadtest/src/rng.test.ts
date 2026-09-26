import { describe, expect, it } from 'vitest';

import { createRng, shardSeed } from './rng.js';

describe('createRng', () => {
  it('is reproducible, uniform enough, and differs per shard', () => {
    const a = createRng(42);
    const b = createRng(42);
    const draws = Array.from({ length: 10_000 }, () => a());
    expect(draws.slice(0, 5)).toEqual(Array.from({ length: 5 }, () => b()));
    expect(draws.every((d) => d >= 0 && d < 1)).toBe(true);
    const mean = draws.reduce((s, d) => s + d, 0) / draws.length;
    expect(mean).toBeGreaterThan(0.48);
    expect(mean).toBeLessThan(0.52);
    expect(createRng(shardSeed(1, 1))()).not.toBe(createRng(shardSeed(1, 2))());
  });
});
