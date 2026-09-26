import { describe, expect, it } from 'vitest';

import { NRT_LAG_HISTOGRAM } from '../core/ingest/lag-histogram-params.js';
import type { LagRecordReport } from '../core/ingest/lag-recorder.js';
import type { JobRun } from '../core/scheduler/repeating-job.js';
import { loadConfig, type Environment } from './config.js';
import {
  LAG_HISTOGRAM_INTERVAL_MS,
  reportLagRecording,
  wireLagHistograms,
} from './lag-histogram-wiring.js';

// A closed port: the wiring must be buildable without anything being reachable.
const ENV: Environment = {
  DATABASE_URL: 'postgres://fire_watch:hunter2@127.0.0.1:1/fire_watch',
  FIRMS_MAP_KEY: 'testtesttesttesttesttesttesttest',
};

const REPORT: LagRecordReport = {
  at: '2026-08-20T10:00:00Z',
  histogramVersion: 'nrt_lag_histogram_v0',
  histogramDigest: 'abcd1234',
  days: [{ day: '2026-08-20', samples: 3, sources: 2 }],
  rowsWritten: 2,
};

const run = (
  value: LagRecordReport | undefined,
  error: unknown = null,
): JobRun<LagRecordReport> => ({
  startedAt: 0,
  finishedAt: 1_000,
  value,
  error,
});

describe('wireLagHistograms', () => {
  it('wires the recorder to one store for both sides and the shipped edges', async () => {
    const wiring = wireLagHistograms(loadConfig(ENV, 'fire-watch-test'));
    expect(wiring.deps.reader).toBe(wiring.deps.store);
    expect(wiring.deps.config).toBe(NRT_LAG_HISTOGRAM);
    expect(typeof wiring.deps.clock.now).toBe('function');
    await wiring.close();
  });

  it('runs hourly: the interval only bounds how stale today is', () => {
    expect(LAG_HISTOGRAM_INTERVAL_MS).toBe(3_600_000);
  });
});

describe('reportLagRecording', () => {
  it('prints the report as one canonical line', () => {
    const lines: string[] = [];
    reportLagRecording(run(REPORT), { writeLine: (line) => lines.push(line) });
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] ?? '')).toEqual({ lag_histograms: REPORT });
  });

  it('prints the failure when the run threw', () => {
    const lines: string[] = [];
    reportLagRecording(run(undefined, new Error('boom')), {
      writeLine: (line) => lines.push(line),
    });
    expect(JSON.parse(lines[0] ?? '')).toEqual({
      lag_histograms_failed: { error: 'boom', at: 1_000 },
    });
  });
});
