import { describe, expect, it } from 'vitest';

import type { EffisLayerResult, EffisRefreshReport } from '../core/effis/effis-refresh.js';
import type { Heartbeat } from '../core/ports/heartbeat.js';
import type { JobRun } from '../core/scheduler/repeating-job.js';
import type { WeatherRefreshReport } from '../core/weather/weather-refresh.js';
import { reportEffisRefresh, reportWeatherRefresh } from './refresh-reporter.js';

const T0 = 1_765_620_900_000;
const T1 = T0 + 60_000;

const storedLayer = (layer: EffisLayerResult['layer']): EffisLayerResult => ({
  layer,
  outcome: 'stored',
  sanity: 'good',
  sanityRule: null,
  bytes: 2048,
  availableAt: T0,
  staleAvailable: true,
  error: null,
});

const failedLayer = (layer: EffisLayerResult['layer']): EffisLayerResult => ({
  layer,
  outcome: 'fetch_failed',
  sanity: null,
  sanityRule: null,
  bytes: 0,
  availableAt: null,
  staleAvailable: true,
  error: 'EFFIS returned 503',
});

const effisReport = (overrides?: Partial<EffisRefreshReport>): EffisRefreshReport => ({
  startedAt: T0,
  finishedAt: T1,
  layers: [storedLayer('fwi'), storedLayer('ba')],
  feedStatusError: null,
  jobStatusError: null,
  ...overrides,
});

const weatherReport = (overrides?: Partial<WeatherRefreshReport>): WeatherRefreshReport => ({
  startedAt: T0,
  finishedAt: T1,
  cycle: { dateYmd: '20260813', hour: 6 },
  steps: [{ step: 0, indexFetched: true, fields: [], error: null }],
  feedStatusError: null,
  ...overrides,
});

const completedRun = <T>(value: T): JobRun<T> => ({
  startedAt: T0,
  finishedAt: T1,
  value,
  error: null,
});

const crashedRun = <T>(error: unknown): JobRun<T> => ({
  startedAt: T0,
  finishedAt: T1,
  value: undefined,
  error,
});

interface Fixture {
  lines: string[];
  pings: string[];
  heartbeat: Heartbeat;
  writeLine: (line: string) => void;
}

function fixture(): Fixture {
  const lines: string[] = [];
  const pings: string[] = [];
  return {
    lines,
    pings,
    heartbeat: {
      succeeded(job): Promise<void> {
        pings.push(job);
        return Promise.resolve();
      },
    },
    writeLine: (line) => lines.push(line),
  };
}

const parsed = (line: string | undefined): Record<string, unknown> =>
  JSON.parse(line ?? '') as Record<string, unknown>;

describe('reportEffisRefresh', () => {
  it('writes one line and pings the heartbeat for a healthy refresh', async () => {
    const f = fixture();
    await reportEffisRefresh(completedRun(effisReport()), f);

    expect(f.lines).toHaveLength(1);
    const line = parsed(f.lines[0]);
    expect(line['degraded']).toBe(false);
    expect(line['effis_refresh']).toMatchObject({ startedAt: T0, finishedAt: T1 });
    expect(f.pings).toEqual(['effis-refresh']);
  });

  it('stays silent towards the monitor when no layer landed', async () => {
    const f = fixture();
    await reportEffisRefresh(
      completedRun(effisReport({ layers: [failedLayer('fwi'), failedLayer('ba')] })),
      f,
    );

    expect(parsed(f.lines[0])['degraded']).toBe(true);
    expect(f.pings).toEqual([]);
  });

  it('stays silent towards the monitor when the evidence chain broke', async () => {
    // Layers landed, but the freshness row did not: pinging would certify bookkeeping
    // that is not actually happening.
    const f = fixture();
    await reportEffisRefresh(
      completedRun(effisReport({ feedStatusError: 'feed status disk unwritable' })),
      f,
    );

    expect(parsed(f.lines[0])['degraded']).toBe(true);
    expect(f.pings).toEqual([]);
  });

  it('records a crashed run as its own line and never pings', async () => {
    const f = fixture();
    await reportEffisRefresh(crashedRun(new Error('wiring exploded')), f);

    expect(parsed(f.lines[0])['effis_refresh_failed']).toEqual({
      error: 'wiring exploded',
      at: T1,
    });
    expect(f.pings).toEqual([]);
  });
});

describe('reportWeatherRefresh', () => {
  it('writes one line for a healthy refresh', () => {
    const f = fixture();
    reportWeatherRefresh(completedRun(weatherReport()), f);

    const line = parsed(f.lines[0]);
    expect(line['degraded']).toBe(false);
    expect(line['weather_refresh']).toMatchObject({ cycle: { dateYmd: '20260813', hour: 6 } });
  });

  it('marks a refresh that reached no index as degraded', () => {
    const f = fixture();
    reportWeatherRefresh(
      completedRun(
        weatherReport({
          steps: [{ step: 0, indexFetched: false, fields: [], error: 'connect timeout' }],
        }),
      ),
      f,
    );

    expect(parsed(f.lines[0])['degraded']).toBe(true);
  });

  it('records a crashed run as its own line', () => {
    const f = fixture();
    reportWeatherRefresh(crashedRun(new Error('wiring exploded')), f);

    expect(parsed(f.lines[0])['weather_refresh_failed']).toEqual({
      error: 'wiring exploded',
      at: T1,
    });
  });
});
