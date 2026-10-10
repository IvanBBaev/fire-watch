import { mkdtempSync, renameSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { STATIC_SOURCE_KINDS } from '@fire-watch/contracts';
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

function writeMask(path: string, version: string, year: number): void {
  const next = `${path}.tmp`;
  writeFileSync(
    next,
    JSON.stringify({
      format: 'fire-watch/static-sources@1',
      version,
      licence: 'ODbL-1.0',
      attribution: '© OpenStreetMap contributors',
      scale: 10000,
      kinds: STATIC_SOURCE_KINDS,
      sources: [[3, 273300, 425400]],
    }),
  );
  utimesSync(next, new Date(year, 0, 1), new Date(year, 0, 1));
  renameSync(next, path);
}

describe('wireIdentity static-source mask hot reload', () => {
  it('swaps the evaluator the cycle reads when the mask file gets a new version', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fw-identity-mask-'));
    const path = join(dir, 'static-sources.json');
    writeMask(path, 'osm-a', 2030);
    const notes: Record<string, unknown>[] = [];
    const wiring = wireIdentity(loadConfig({ ...env, FIRE_WATCH_STATIC_SOURCES: path }), {
      note: (record) => notes.push(record),
    });
    const before = wiring.deps.staticSources;
    expect(before?.maskVersion).toBe('osm-a');

    wiring.reloadStaticSources();
    expect(wiring.deps.staticSources).toBe(before);
    expect(notes).toEqual([]);

    writeMask(path, 'osm-b', 2031);
    wiring.reloadStaticSources();
    const after = wiring.deps.staticSources;
    expect(after?.maskVersion).toBe('osm-b');
    expect(after?.policyVersion).toBe(before?.policyVersion);
    // The old evaluator is untouched: a cycle that already read it finishes on one mask.
    expect(before?.maskVersion).toBe('osm-a');
    // A spread (as the integration tests do) snapshots the current evaluator.
    expect({ ...wiring.deps }.staticSources).toBe(after);
    expect(notes).toEqual([{ static_source_mask_reloaded: { from: 'osm-a', to: 'osm-b', path } }]);
    await wiring.close();
  });

  it('keeps the loaded mask on a broken file and notes the reason once', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fw-identity-mask-'));
    const path = join(dir, 'static-sources.json');
    writeMask(path, 'osm-a', 2030);
    const notes: Record<string, unknown>[] = [];
    const wiring = wireIdentity(loadConfig({ ...env, FIRE_WATCH_STATIC_SOURCES: path }), {
      note: (record) => notes.push(record),
    });
    writeFileSync(path, '{"format":');
    wiring.reloadStaticSources();
    wiring.reloadStaticSources();
    expect(wiring.deps.staticSources?.maskVersion).toBe('osm-a');
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({
      static_source_mask_reload_rejected: { kept: 'osm-a', path },
    });
    await wiring.close();
  });
});
