import { describe, expect, it } from 'vitest';

import { CLUSTERING_PARAMS } from '../core/clustering/clustering-params.js';
import { loadConfig, type Environment } from './config.js';
import {
  IDENTITY_CYCLE_INTERVAL_MS,
  IDENTITY_MAX_BATCHES_PER_CYCLE,
  wireIdentity,
} from './identity-wiring.js';

const env: Environment = {
  DATABASE_URL: 'postgres://fire_watch:hunter2@db.internal:5432/fire_watch',
  FIRMS_MAP_KEY: 'testtesttesttesttesttesttesttest',
};

describe('wireIdentity', () => {
  it('wires the ratified clustering parameters and the batch limit without connecting', async () => {
    const wiring = wireIdentity(loadConfig(env));
    expect(wiring.deps.config).toBe(CLUSTERING_PARAMS);
    expect(wiring.deps.maxBatchesPerCycle).toBe(IDENTITY_MAX_BATCHES_PER_CYCLE);
    expect(wiring.deps.lifecycle).toBeUndefined();
    // Closing a pool that never connected resolves: building the wiring opened nothing.
    await expect(wiring.close()).resolves.toBeUndefined();
  });

  it('runs at least as often as the default poll, so a batch waits one cycle at most', () => {
    expect(IDENTITY_CYCLE_INTERVAL_MS).toBeLessThanOrEqual(loadConfig(env).pollIntervalMs);
  });
});
