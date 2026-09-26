/**
 * Deterministic RNG (mulberry32) behind the `Rng` port — jitter quality, replayable in
 * tests by fixing the seed. Entropy for the production seed comes from the platform,
 * in this file because `src/adapters/` is the designated randomness boundary.
 */

import type { Rng } from '../core/ports.js';

export function createMulberry32(seed: number): Rng {
  let state = seed >>> 0;
  return {
    next: () => {
      state = (state + 0x6d2b79f5) >>> 0;
      let t = state;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    },
  };
}

export function entropySeed(): number {
  const box = new Uint32Array(1);
  crypto.getRandomValues(box);
  return box[0] ?? 1;
}
