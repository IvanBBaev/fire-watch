import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { loadConfig, type Environment } from './config.js';
import {
  EFFIS_REFRESH_INTERVAL_MS,
  WEATHER_REFRESH_INTERVAL_MS,
  wireRefreshJobs,
} from './refresh-wiring.js';

const MAP_KEY = 'testtesttesttesttesttesttesttest';
const DATABASE_URL = 'postgres://fire_watch:hunter2@db.internal:5432/fire_watch';

const env = (overrides: Environment = {}): Environment => ({
  DATABASE_URL,
  FIRMS_MAP_KEY: MAP_KEY,
  ...overrides,
});

const temporaries: string[] = [];

afterEach(() => {
  for (const dir of temporaries.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('wireRefreshJobs', () => {
  it('wires nothing when the deployment has no state dir', () => {
    expect(wireRefreshJobs(loadConfig(env()))).toBeNull();
  });

  it('wires both refresh loops against one shared state dir when configured', () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'fw-refresh-wiring-'));
    temporaries.push(stateDir);

    const wiring = wireRefreshJobs(loadConfig(env({ FIRE_WATCH_STATE_DIR: stateDir })));

    expect(wiring).not.toBeNull();
    // Both loops must share the payload and feed-status stores: the health endpoint reads
    // one `feed-status/` directory, and splitting the stores would strand half the rows.
    expect(wiring?.effisDeps.payloads).toBe(wiring?.weatherDeps.payloads);
    expect(wiring?.effisDeps.feedStatus).toBe(wiring?.weatherDeps.feedStatus);
  });

  it('keeps the cadences inside the C5 budgets', () => {
    // EFFIS: 6 h cadence against a 24 h warn budget — four misses before a warn.
    // Weather: 1 h cadence against a 6 h warn budget — six.
    expect(EFFIS_REFRESH_INTERVAL_MS).toBe(6 * 3_600_000);
    expect(WEATHER_REFRESH_INTERVAL_MS).toBe(3_600_000);
  });
});
