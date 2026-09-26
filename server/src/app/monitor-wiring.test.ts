import { describe, expect, it } from 'vitest';

import type { MonitorCycleReport } from '../core/monitoring/monitor-cycle.js';
import type { JobRun } from '../core/scheduler/repeating-job.js';
import { loadConfig, type Environment } from './config.js';
import { MONITOR_INTERVAL_MS, reportMonitorCycle, wireMonitors } from './monitor-wiring.js';

// A closed port: the wiring must be buildable without anything being reachable.
const ENV: Environment = {
  DATABASE_URL: 'postgres://fire_watch:hunter2@127.0.0.1:1/fire_watch',
  FIRMS_MAP_KEY: 'testtesttesttesttesttesttesttest',
};

const REPORT: MonitorCycleReport = {
  at: '2026-09-23T10:00:00Z',
  readings: {
    outbox_queue_oldest_seconds: { value: 661, status: 'paging', page_above: 600 },
    outbox_pending_rows: { value: 3, status: 'unarmed', page_above: null },
    outbox_claimed_rows: { value: 0, status: 'unarmed', page_above: null },
    outbox_claimed_oldest_seconds: { value: 0, status: 'unarmed', page_above: null },
    outbox_awaiting_approval_oldest_seconds: { value: 0, status: 'unarmed', page_above: null },
    identity_pending_batches: { value: 0, status: 'unarmed', page_above: null },
    identity_oldest_pending_seconds: { value: 0, status: 'unarmed', page_above: null },
    canary_round_trip_seconds: { value: null, status: 'unarmed', page_above: null },
  },
  transitions: [{ key: 'outbox_queue_oldest_seconds', to: 'page' }],
  paging: ['outbox_queue_oldest_seconds'],
};

const run = (
  value: MonitorCycleReport | undefined,
  error: unknown = null,
): JobRun<MonitorCycleReport> => ({ startedAt: 0, finishedAt: 1_000, value, error });

function lines(value: JobRun<MonitorCycleReport>): string[] {
  const out: string[] = [];
  reportMonitorCycle(value, { writeLine: (line) => out.push(line) });
  return out;
}

describe('wireMonitors', () => {
  it('builds without connecting, and pages nobody without a heartbeat URL', async () => {
    const wiring = wireMonitors(loadConfig(ENV, 'fire-watch-test'));
    expect(wiring.paging).toBe(false);
    expect(typeof wiring.cycle.runOnce).toBe('function');
    await wiring.close();
  });

  it('attaches the healthchecks pager when the heartbeat URL is configured', async () => {
    const wiring = wireMonitors(
      loadConfig(
        { ...ENV, FIRE_WATCH_HEARTBEAT_URL: 'https://hc-ping.example/0000-not-a-real-key' },
        'fire-watch-test',
      ),
    );
    expect(wiring.paging).toBe(true);
    await wiring.close();
  });

  it('runs once a minute', () => {
    expect(MONITOR_INTERVAL_MS).toBe(60_000);
  });
});

describe('reportMonitorCycle', () => {
  it('writes one canonical line with the transitions lifted to a top-level pages field', () => {
    const [line, ...rest] = lines(run(REPORT));
    expect(rest).toEqual([]);
    const parsed = JSON.parse(line ?? '') as Record<string, unknown>;
    expect(Object.keys(parsed)).toEqual(['meta_alerts', 'pages']);
    expect(parsed['pages']).toEqual([{ key: 'outbox_queue_oldest_seconds', to: 'page' }]);
    expect(parsed['meta_alerts']).not.toHaveProperty('transitions');
  });

  it('omits pages on a quiet cycle', () => {
    const [line] = lines(run({ ...REPORT, transitions: [] }));
    expect(Object.keys(JSON.parse(line ?? '') as object)).toEqual(['meta_alerts']);
  });

  it('names the error of a failed cycle', () => {
    expect(lines(run(undefined, new Error('db down')))).toEqual([
      '{"meta_alerts_failed":{"at":1000,"error":"db down"}}',
    ]);
  });
});
