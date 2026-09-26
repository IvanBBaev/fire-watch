import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { FreshnessRowId } from '@fire-watch/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AlertEvaluationCycleReport } from '../core/alerts/evaluation-cycle.js';
import type { IngestCycleReport } from '../core/ingest/ingest-cycle.js';
import { META_ALERT_KEYS, type MetaAlertKey } from '../core/monitoring/meta-alert-params.js';
import type { MonitorCycleReport, MonitorReadingReport } from '../core/monitoring/monitor-cycle.js';
import { VirtualClock } from '../core/ports/clock.js';
import type { JobRun } from '../core/scheduler/repeating-job.js';
import type { DispatchJobReport } from './dispatch-wiring.js';
import {
  alertEvaluationObserver,
  createMetricsListener,
  createProcessMetrics,
  dispatchObserver,
  freshnessCollector,
  ingestObserver,
  instrumentHeartbeat,
  loopObserver,
  monitorObserver,
  observeAlertEvaluation,
  observeLoop,
  transportCollector,
  writeBackupTextfile,
} from './metrics-wiring.js';

const AT = Date.parse('2026-09-25T10:00:00Z');

function run<T>(value: T | undefined, error: unknown = null): JobRun<T> {
  return { startedAt: AT, finishedAt: AT + 2_500, value, error };
}

describe('instrumentHeartbeat', () => {
  it('records the success instant, then delegates', async () => {
    const registry = createProcessMetrics();
    const inner = { succeeded: vi.fn(() => Promise.resolve()) };
    const heartbeat = instrumentHeartbeat(inner, registry, new VirtualClock(AT + 900), () => {});
    await heartbeat.succeeded('ingest-cycle');
    expect(inner.succeeded).toHaveBeenCalledWith('ingest-cycle');
    expect(await registry.render()).toContain(
      `fw_job_last_success_timestamp_seconds{job_id="ingest-cycle"} ${String(AT / 1000)}\n`,
    );
  });
});

describe('observeLoop', () => {
  it('records runs, finish time and duration, then returns the reporter unchanged', async () => {
    const registry = createProcessMetrics();
    const report = vi.fn(() => Promise.resolve());
    const wrapped = observeLoop(registry, 'identity', report, () => {});
    const ok = run(1);
    await wrapped(ok);
    await wrapped(run(undefined, new Error('boom')));
    expect(report).toHaveBeenCalledTimes(2);
    expect(report).toHaveBeenCalledWith(ok);
    const text = await registry.render();
    expect(text).toContain('fw_loop_runs_total{loop="identity",outcome="ok"} 1\n');
    expect(text).toContain('fw_loop_runs_total{loop="identity",outcome="error"} 1\n');
    expect(text).toContain(
      `fw_loop_last_finished_timestamp_seconds{loop="identity"} ${String(Math.floor((AT + 2500) / 1000))}\n`,
    );
    expect(text).toContain('fw_loop_last_duration_seconds{loop="identity"} 2.5\n');
  });

  it('never lets a recording failure reach the loop, and still reports', () => {
    const registry = createProcessMetrics();
    const errors: unknown[] = [];
    const report = vi.fn();
    const wrapped = observeLoop(
      registry,
      'x',
      report,
      (e) => errors.push(e),
      () => {
        throw new Error('observer bug');
      },
    );
    expect(() => wrapped(run(1))).not.toThrow();
    expect(report).toHaveBeenCalledOnce();
    expect(errors).toHaveLength(1);
  });

  it('passes a throwing reporter through, so the loop still counts it as a failure', () => {
    const wrapped = observeLoop(
      createProcessMetrics(),
      'x',
      () => {
        throw new Error('reporter');
      },
      () => {},
    );
    expect(() => wrapped(run(1))).toThrow('reporter');
  });
});

describe('loopObserver', () => {
  it('is observeLoop with the registry and error sink bound', async () => {
    const registry = createProcessMetrics();
    const report = vi.fn();
    const observe = loopObserver(registry, () => {});
    const wrapped = observe<number>('r2_mirror_push', report);
    const ok = run(1);
    await wrapped(ok);
    expect(report).toHaveBeenCalledWith(ok);
    expect(await registry.render()).toContain(
      'fw_loop_runs_total{loop="r2_mirror_push",outcome="ok"} 1\n',
    );
  });
});

describe('dispatchObserver', () => {
  function dispatched(ttl: number, unapproved = 0): DispatchJobReport {
    // Only `dropped` is read; the rest of the report is not the observer's business.
    return {
      dropped: { expired_unapproved: unapproved, ttl_expired: ttl },
    } as unknown as DispatchJobReport;
  }

  it('creates both drop series at zero on the first cycle, then adds each drop', async () => {
    const registry = createProcessMetrics();
    const observe = dispatchObserver(registry);
    observe(run(dispatched(0)));
    let text = await registry.render();
    expect(text).toContain('fw_alert_sends_dropped_total{reason="expired_unapproved"} 0\n');
    expect(text).toContain('fw_alert_sends_dropped_total{reason="ttl_expired"} 0\n');
    observe(run(dispatched(2)));
    observe(run(dispatched(1)));
    text = await registry.render();
    expect(text).toContain('fw_alert_sends_dropped_total{reason="ttl_expired"} 3\n');
    expect(text).toContain('fw_alert_sends_dropped_total{reason="expired_unapproved"} 0\n');
  });

  it('creates the series at zero and adds nothing for a cycle that threw', async () => {
    const registry = createProcessMetrics();
    dispatchObserver(registry)(run<DispatchJobReport>(undefined, new Error('db down')));
    expect(await registry.render()).toContain(
      'fw_alert_sends_dropped_total{reason="ttl_expired"} 0\n',
    );
  });
});

describe('alertEvaluationObserver', () => {
  function evaluated(overBudget: number, manual = 0): AlertEvaluationCycleReport {
    // Only `deferred` is read; the rest of the report is not the observer's business.
    return {
      deferred: { over_budget_b: overBudget, manual_approval: manual },
    } as unknown as AlertEvaluationCycleReport;
  }

  it('creates both deferral series at zero on the first cycle, then adds each deferral', async () => {
    const registry = createProcessMetrics();
    const observe = alertEvaluationObserver(registry);
    observe(run(evaluated(0)));
    let text = await registry.render();
    expect(text).toContain('fw_alert_sends_deferred_total{reason="over_budget_b"} 0\n');
    expect(text).toContain('fw_alert_sends_deferred_total{reason="manual_approval"} 0\n');
    observe(run(evaluated(2, 1)));
    observe(run(evaluated(3)));
    text = await registry.render();
    expect(text).toContain('fw_alert_sends_deferred_total{reason="over_budget_b"} 5\n');
    expect(text).toContain('fw_alert_sends_deferred_total{reason="manual_approval"} 1\n');
  });

  it('creates the series at zero and adds nothing for a cycle that threw', async () => {
    const registry = createProcessMetrics();
    alertEvaluationObserver(registry)(
      run<AlertEvaluationCycleReport>(undefined, new Error('db down')),
    );
    expect(await registry.render()).toContain(
      'fw_alert_sends_deferred_total{reason="over_budget_b"} 0\n',
    );
  });
});

describe('observeAlertEvaluation', () => {
  it('records the loop run and the deferral counter, then calls the reporter', async () => {
    const registry = createProcessMetrics();
    const report = vi.fn(() => Promise.resolve());
    const wrapped = observeAlertEvaluation(registry, report, () => {});
    const ok = run({
      deferred: { over_budget_b: 4, manual_approval: 0 },
    } as unknown as AlertEvaluationCycleReport);
    await wrapped(ok);
    expect(report).toHaveBeenCalledWith(ok);
    const text = await registry.render();
    expect(text).toContain('fw_loop_runs_total{loop="alert_evaluation",outcome="ok"} 1\n');
    expect(text).toContain('fw_alert_sends_deferred_total{reason="over_budget_b"} 4\n');
  });

  it('is what the worker wires the alert_evaluation loop through (A1.12 has no other producer)', async () => {
    // A source guard, because the worker's composition is not unit-testable without a
    // database: replace the wrapper with a bare observeLoop and the deferral counter
    // silently stops being produced while every other test stays green.
    const worker = await readFile(new URL('./worker.ts', import.meta.url), 'utf8');
    const loop = worker.slice(worker.indexOf("'alert_evaluation',"));
    expect(loop).toMatch(/^'alert_evaluation',[\s\S]*?report: observeAlertEvaluation\(\s*metrics,/);
    expect(worker).not.toMatch(/observeLoop\(\s*metrics,\s*'alert_evaluation'/);
  });
});

describe('transportCollector', () => {
  it('exports the tier, the open streams and every reject reason at scrape time', async () => {
    const registry = createProcessMetrics();
    let transport: 'sse' | 'poll' = 'sse';
    registry.addCollector(
      transportCollector(() => ({
        transport,
        connections: 7,
        rejected: { not_offered: 0, not_ready: 1, capacity: 2, client_cap: 0 },
      })),
    );
    let text = await registry.render();
    expect(text).toContain('fw_degradation_tier 0\n');
    expect(text).toContain('fw_sse_connections 7\n');
    expect(text).toContain('fw_sse_rejected_total{reason="capacity"} 2\n');
    expect(text).toContain('fw_sse_rejected_total{reason="not_offered"} 0\n');
    transport = 'poll';
    text = await registry.render();
    expect(text).toContain('fw_degradation_tier 1\n');
  });

  it('exports nothing from a read that throws, without failing the scrape', async () => {
    const registry = createProcessMetrics();
    registry.addCollector(
      transportCollector(() => {
        throw new Error('hub gone');
      }),
    );
    const text = await registry.render();
    expect(text).not.toContain('fw_degradation_tier ');
  });
});

describe('ingestObserver', () => {
  it('adds each source attempt and its counts, and nothing for a cycle that threw', async () => {
    const registry = createProcessMetrics();
    const observe = ingestObserver(registry);
    const report = {
      startedAt: AT,
      finishedAt: AT,
      sources: [{ source: 'firms:viirs:snpp', outcome: 'stored', received: 3, inserted: 2 }],
    } as unknown as IngestCycleReport;
    observe(run(report));
    observe(run(report));
    observe(run<IngestCycleReport>(undefined, new Error('x')));
    const text = await registry.render();
    expect(text).toContain('fw_source_fetch_total{source="firms:viirs:snpp",outcome="stored"} 2\n');
    expect(text).toContain('fw_source_records_fetched_total{source="firms:viirs:snpp"} 6\n');
    expect(text).toContain('fw_source_records_inserted_total{source="firms:viirs:snpp"} 4\n');
  });
});

describe('monitorObserver', () => {
  const reading = (value: number | null): MonitorReadingReport => ({
    value,
    status: value === null ? 'no_data' : 'ok',
    page_above: null,
  });
  const report: MonitorCycleReport = {
    at: '2026-09-25T10:00:00.000Z',
    readings: Object.fromEntries(META_ALERT_KEYS.map((k) => [k, reading(42)])) as Record<
      MetaAlertKey,
      MonitorReadingReport
    >,
    transitions: [],
    paging: [],
  };

  it('exports the readings and clears them all when a cycle throws', async () => {
    const registry = createProcessMetrics();
    const observe = monitorObserver(registry);
    observe(run(report));
    expect(await registry.render()).toContain('fw_notification_queue_oldest_seconds 42\n');
    observe(run<MonitorCycleReport>(undefined, new Error('db down')));
    const text = await registry.render();
    expect(text).not.toContain('fw_notification_queue_oldest_seconds');
    expect(text).not.toContain('fw_meta_alert_paging');
  });
});

describe('freshnessCollector', () => {
  const expected: readonly FreshnessRowId[] = ['firms:viirs:snpp'];
  const clock = new VirtualClock(AT);

  it('exports the verdict with collector_up 1', async () => {
    const collect = freshnessCollector({
      reader: {
        readObservations: () =>
          Promise.resolve([
            {
              row: 'firms:viirs:snpp',
              lastAttemptAt: AT - 60_000,
              lastSuccessAt: AT - 60_000,
              lastDataAt: AT - 60_000,
              consecutiveFailures: 0,
            },
          ]),
      },
      expected,
      clock,
    });
    const samples = await collect();
    expect(samples).toContainEqual({ name: 'fw_freshness_collector_up', labels: {}, value: 1 });
    expect(samples).toContainEqual({
      name: 'fw_freshness_age_seconds',
      labels: { row: 'firms:viirs:snpp' },
      value: 60,
    });
  });

  it('exports only collector_up 0 when the reader fails', async () => {
    const collect = freshnessCollector({
      reader: { readObservations: () => Promise.reject(new Error('down')) },
      expected,
      clock,
    });
    expect(await collect()).toEqual([{ name: 'fw_freshness_collector_up', labels: {}, value: 0 }]);
  });
});

describe('createMetricsListener', () => {
  it('serves /metrics on its own loopback port and closes', async () => {
    const registry = createProcessMetrics();
    registry.addCollector(() => [{ name: 'fw_freshness_collector_up', labels: {}, value: 1 }]);
    const listener = createMetricsListener(
      { port: 0, host: '127.0.0.1', bearerToken: null },
      registry,
    );
    await listener.listen();
    await listener.close();
  });

  it('owns an event-loop lag sampler from listen to close and exports its p99 per scrape', async () => {
    const registry = createProcessMetrics();
    const stop = vi.fn();
    const readings = [120, null];
    const listener = createMetricsListener(
      { port: 0, host: '127.0.0.1', bearerToken: null },
      registry,
      { lagSampler: () => ({ sampleP99Ms: () => readings.shift() ?? null, stop }) },
    );
    expect(await registry.render()).not.toContain('fw_event_loop_lag_p99_seconds ');
    await listener.listen();
    expect(await registry.render()).toContain('fw_event_loop_lag_p99_seconds 0.12\n');
    expect(await registry.render()).not.toContain('fw_event_loop_lag_p99_seconds ');
    await listener.close();
    expect(stop).toHaveBeenCalledOnce();
  });
});

describe('writeBackupTextfile', () => {
  let dir: string | null = null;
  afterEach(async () => {
    if (dir !== null) await rm(dir, { recursive: true, force: true });
    dir = null;
  });

  it('writes the exposition atomically and leaves no temporary file', async () => {
    dir = await mkdtemp(join(tmpdir(), 'fw-metrics-'));
    const path = await writeBackupTextfile(
      dir,
      [{ relation: 'public.detections', set: 'main', rows: 7, bytes: 8192 }],
      AT + 999,
    );
    expect(path).toBe(join(dir, 'fire_watch_backup.prom'));
    expect(await readdir(dir)).toEqual(['fire_watch_backup.prom']);
    const text = await readFile(path, 'utf8');
    expect(text).toContain(
      `fw_job_last_success_timestamp_seconds{job_id="nightly-backup"} ${String(AT / 1000)}\n`,
    );
    expect(text).toContain('fw_backup_table_rows{relation="public.detections",set="main"} 7\n');
  });

  it('cleans up and rethrows when the directory is missing', async () => {
    await expect(writeBackupTextfile('/nonexistent/fw-metrics', [], AT)).rejects.toThrow();
  });
});
