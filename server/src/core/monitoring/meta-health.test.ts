import { describe, expect, it } from 'vitest';

import type { JobRun } from '../scheduler/repeating-job.js';
import { META_ALERT_KEYS } from './meta-alert-params.js';
import {
  evaluateMetaHealth,
  META_HEALTH_STALE_AFTER_INTERVALS,
  type MetaHealthInput,
} from './meta-health.js';
import type { MonitorCycleReport, MonitorReadingReport } from './monitor-cycle.js';

const INTERVAL = 60_000;
const T0 = Date.parse('2026-10-22T10:00:00Z');

function report(paging: MonitorCycleReport['paging']): MonitorCycleReport {
  const readings = Object.fromEntries(
    META_ALERT_KEYS.map((key): [string, MonitorReadingReport] => [
      key,
      { value: 0, status: paging.includes(key) ? 'paging' : 'unarmed', page_above: null },
    ]),
  ) as MonitorCycleReport['readings'];
  return { at: '2026-10-22T10:00:00Z', advanced: true, readings, transitions: [], paging };
}

const ok = (finishedAt: number, paging: MonitorCycleReport['paging'] = []) =>
  ({
    startedAt: finishedAt - 50,
    finishedAt,
    value: report(paging),
    error: null,
  }) satisfies JobRun<MonitorCycleReport>;

const failed = (finishedAt: number): JobRun<MonitorCycleReport> => ({
  startedAt: finishedAt - 50,
  finishedAt,
  value: undefined,
  error: new Error('connect ECONNREFUSED postgres://u:secret@db'),
});

function at(input: Partial<MetaHealthInput>): ReturnType<typeof evaluateMetaHealth> {
  return evaluateMetaHealth({ last: null, startedAt: T0, now: T0, intervalMs: INTERVAL, ...input });
}

describe('evaluateMetaHealth', () => {
  it('answers 200 ok with the readings when the last run paged nothing', () => {
    const verdict = at({ last: ok(T0 + 1_000), now: T0 + 31_000 });
    expect(verdict.statusCode).toBe(200);
    expect(verdict.body).toMatchObject({
      status: 'ok',
      generatedAt: '2026-10-22T10:00:31Z',
      lastRunAt: '2026-10-22T10:00:01Z',
      ageSeconds: 30,
      staleAfterSeconds: 180,
      paging: [],
    });
    expect(Object.keys(verdict.body.readings ?? {})).toEqual([...META_ALERT_KEYS]);
  });

  it('answers 500 paging and names the keys when the last run is paging', () => {
    const verdict = at({ last: ok(T0, ['outbox_queue_oldest_seconds']), now: T0 + 1_000 });
    expect(verdict.statusCode).toBe(500);
    expect(verdict.body.status).toBe('paging');
    expect(verdict.body.paging).toEqual(['outbox_queue_oldest_seconds']);
    expect(verdict.body.readings?.outbox_queue_oldest_seconds.status).toBe('paging');
  });

  it('answers 500 failed with no readings and no error text when the last run threw', () => {
    const verdict = at({ last: failed(T0), now: T0 + 1_000 });
    expect(verdict.statusCode).toBe(500);
    expect(verdict.body).toMatchObject({ status: 'failed', paging: [], readings: null });
    expect(JSON.stringify(verdict.body)).not.toContain('secret');
  });

  it('answers 200 starting before the first run, inside the stale window', () => {
    const verdict = at({ now: T0 + 2 * INTERVAL });
    expect(verdict.statusCode).toBe(200);
    expect(verdict.body).toMatchObject({
      status: 'starting',
      lastRunAt: null,
      ageSeconds: 120,
      readings: null,
    });
  });

  it('answers 500 stale once no run finished for the stale window, whatever the last run said', () => {
    const window = INTERVAL * META_HEALTH_STALE_AFTER_INTERVALS;
    expect(at({ now: T0 + window }).body.status).toBe('starting');
    expect(at({ now: T0 + window + 1 }).body.status).toBe('stale');
    for (const last of [ok(T0), ok(T0, ['canary_round_trip_seconds']), failed(T0)]) {
      expect(at({ last, now: T0 + window }).body.status).not.toBe('stale');
      const verdict = at({ last, now: T0 + window + 1 });
      expect(verdict.statusCode).toBe(500);
      expect(verdict.body.status).toBe('stale');
    }
  });

  it('never reports a negative age for a run stamped after now', () => {
    expect(at({ last: ok(T0 + 5_000), now: T0 }).body.ageSeconds).toBe(0);
  });

  it('refuses a non-positive interval', () => {
    expect(() => at({ intervalMs: 0 })).toThrow(RangeError);
    expect(() => at({ intervalMs: Number.NaN })).toThrow(RangeError);
  });
});
