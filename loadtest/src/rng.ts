/**
 * A seeded PRNG (mulberry32). The request mix is drawn from it rather than `Math.random`
 * so a run is reproducible from its seed and each shard draws a different sequence.
 */
export type Rng = () => number;

export function createRng(seed: number): Rng {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A per-shard seed, so shards never draw identical sequences from one `--seed`. */
export function shardSeed(seed: number, shardIndex: number): number {
  return (Math.imul(seed >>> 0, 2654435761) + shardIndex * 0x9e3779b9) >>> 0;
}
