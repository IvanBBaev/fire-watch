import { describe, expect, it } from 'vitest';

import { FIRE_OUTLINE_PARAMS } from '../core/config/fire-outline.js';
import type { FireOutlinePassReport } from '../core/outlines/fire-outline-pass.js';
import type { JobRun } from '../core/scheduler/repeating-job.js';
import { loadConfig, type Environment } from './config.js';
import {
  FIRE_OUTLINE_INTERVAL_MS,
  reportFireOutlinePass,
  wireFireOutlines,
} from './fire-outline-wiring.js';
import { IDENTITY_CYCLE_INTERVAL_MS } from './identity-wiring.js';

// A closed port: the wiring must be buildable without anything being reachable.
const ENV: Environment = {
  DATABASE_URL: 'postgres://fire_watch:hunter2@127.0.0.1:1/fire_watch',
  FIRMS_MAP_KEY: 'testtesttesttesttesttesttesttest',
};

const REPORT: FireOutlinePassReport = {
  paramsVersion: 'fire_outline_params_v1',
  pending: 3,
  drawn: 2,
  empty: 1,
  backlog: false,
};

const run = (
  value: FireOutlinePassReport | undefined,
  error: unknown = null,
): JobRun<FireOutlinePassReport> => ({ startedAt: 0, finishedAt: 1_000, value, error });

describe('wireFireOutlines', () => {
  it('wires the pass to the shipped parameters without connecting', async () => {
    const wiring = wireFireOutlines(loadConfig(ENV, 'fire-watch-test'));
    expect(wiring.deps.params).toBe(FIRE_OUTLINE_PARAMS);
    expect(typeof wiring.deps.store.pendingEvents).toBe('function');
    expect(typeof wiring.deps.clock.now).toBe('function');
    await wiring.close();
  });

  it('follows the identity cadence', () => {
    expect(FIRE_OUTLINE_INTERVAL_MS).toBe(IDENTITY_CYCLE_INTERVAL_MS);
  });
});

describe('reportFireOutlinePass', () => {
  it('prints the report as one canonical line', () => {
    const lines: string[] = [];
    reportFireOutlinePass(run(REPORT), { writeLine: (line) => lines.push(line) });
    expect(lines.map((line) => JSON.parse(line) as unknown)).toEqual([{ fire_outlines: REPORT }]);
  });

  it('prints the failure when the run threw', () => {
    const lines: string[] = [];
    reportFireOutlinePass(run(undefined, new Error('refused')), {
      writeLine: (line) => lines.push(line),
    });
    expect(lines.map((line) => JSON.parse(line) as unknown)).toEqual([
      { fire_outlines_failed: { error: 'refused', at: 1_000 } },
    ]);
  });
});
