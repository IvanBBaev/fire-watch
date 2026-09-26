/**
 * Metrics hookups for the API and the worker (TASKS C5, the Grafana Cloud leg).
 *
 * Every function here *observes*; none changes what a loop does. A loop's report callback
 * is wrapped so the loop's own reporter still runs exactly as before and its failure count
 * (`JobStats.failures`, which counts reports that throw) is untouched: recording a metric
 * can never throw into the loop. A recording failure is a bug in this file, and it is
 * logged, not raised.
 *
 * What is wired, and from where:
 *
 *   * API: the freshness verdict, computed at scrape time from the same reader, expected
 *     rows and budgets as `/api/health/freshness` — so the dashboard and the endpoint
 *     UptimeRobot reads can never disagree. Fleet control at scrape time: the degradation
 *     tier, open streams and the stream route's refusals (`transportCollector`).
 *   * Worker: every heartbeat success (`fw_job_last_success_timestamp_seconds`), run
 *     counts, finish time and duration of every loop the worker starts — the dispatch and
 *     R2 mirror loops through the `observe` hook their wiring takes — the ingest cycle's
 *     per-source counters, the monitors loop's meta-alert readings, the dispatch
 *     cycle's dropped sends (`dispatchObserver`), and the evaluation cycle's deferred
 *     sends (`observeAlertEvaluation`).
 *   * Both: the event-loop lag p99 over the scrape interval, from a sampler the metrics
 *     listener owns (`createMetricsListener`) — never the demotion controller's, whose
 *     every read resets its window.
 *   * Backup CLI: see `writeBackupTextfile` — a one-shot job leaves a `.prom` file.
 *
 * `fw_alert_sends_deferred_total` is produced from the evaluation cycle's `deferred`
 * (rows the outbox newly inserted as `awaiting_approval`), and reads zero while D5's
 * budget B is unarmed — the cycle writes every row `pending` — and the manual broadcast is
 * not wired. Not produced: the `expired_unapproved` drop, because the approval-queue
 * sweeper that would close such rows does not exist (a founder decision, and a query in
 * `adapters/db`); its series is exported at zero by `dispatchObserver`.
 */

import { randomBytes } from 'node:crypto';
import { rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { FreshnessRowId, HeartbeatJobId } from '@fire-watch/contracts';

import { createMetricsServer } from '../adapters/http/metrics-server.js';
import {
  createMetricsRegistry,
  type MetricsRegistry,
} from '../adapters/metrics/metrics-registry.js';
import {
  createEventLoopLagSampler,
  type EventLoopLagSampler,
} from '../adapters/system/event-loop-lag.js';
import type { AlertEvaluationCycleReport } from '../core/alerts/evaluation-cycle.js';
import { noDeferrals } from '../core/alerts/outbox-enqueue.js';
import type { TableGauge } from '../core/backup/table-gauges.js';
import { evaluateFreshness } from '../core/health/freshness.js';
import type { IngestCycleReport } from '../core/ingest/ingest-cycle.js';
import type { MonitorCycleReport } from '../core/monitoring/monitor-cycle.js';
import {
  alertDeferralIncrements,
  alertDropIncrements,
  backupSamples,
  eventLoopLagSamples,
  FRESHNESS_COLLECTOR_UP,
  freshnessSamples,
  ingestIncrements,
  JOB_LAST_SUCCESS,
  LOOP_LAST_DURATION,
  LOOP_LAST_FINISHED,
  LOOP_RUNS,
  META_ALERT_METRICS,
  META_ALERT_SERIES,
  metaAlertSamples,
  METRIC_CATALOG,
  transportSamples,
  type TransportReading,
} from '../core/observability/metric-catalog.js';
import { formatExposition, type MetricSample } from '../core/observability/prometheus-text.js';
import type { Clock } from '../core/ports/clock.js';
import type { FreshnessReader } from '../core/ports/freshness-reader.js';
import type { Heartbeat } from '../core/ports/heartbeat.js';
import type { JobRun } from '../core/scheduler/repeating-job.js';
import type { DispatchJobReport } from './dispatch-wiring.js';
import type { MetricsConfig } from './metrics-config.js';

export function createProcessMetrics(): MetricsRegistry {
  return createMetricsRegistry(METRIC_CATALOG);
}

/** Called with whatever a metrics recording threw; it never reaches the loop. */
export type MetricsErrorSink = (error: unknown) => void;

/**
 * The heartbeat, plus a timestamp per job. The timestamp is set *before* the ping is sent
 * and whether or not the ping lands: it records that the job succeeded, which is true the
 * moment `succeeded` is called — healthchecks.io being unreachable is its own leg's
 * problem, and must not make Grafana think the job stopped too.
 */
export function instrumentHeartbeat(
  inner: Heartbeat,
  registry: MetricsRegistry,
  clock: Clock,
  onError: MetricsErrorSink,
): Heartbeat {
  return {
    succeeded: (job: HeartbeatJobId) => {
      guard(onError, () => {
        registry.setGauge(JOB_LAST_SUCCESS, { job_id: job }, Math.floor(clock.now() / 1000));
      });
      return inner.succeeded(job);
    },
  };
}

/**
 * Wraps a loop's report callback: records the run, feeds `onRun` (a family observer), then
 * hands the run to the original reporter unchanged and returns what it returns.
 */
export function observeLoop<T>(
  registry: MetricsRegistry,
  loop: string,
  report: (run: JobRun<T>) => void | Promise<void>,
  onError: MetricsErrorSink,
  onRun?: (run: JobRun<T>) => void,
): (run: JobRun<T>) => void | Promise<void> {
  return (run) => {
    guard(onError, () => {
      const outcome = run.error === null ? 'ok' : 'error';
      registry.incCounter(LOOP_RUNS, { loop, outcome });
      registry.setGauge(LOOP_LAST_FINISHED, { loop }, Math.floor(run.finishedAt / 1000));
      registry.setGauge(
        LOOP_LAST_DURATION,
        { loop },
        Math.max(0, run.finishedAt - run.startedAt) / 1000,
      );
      onRun?.(run);
    });
    return report(run);
  };
}

/** A loop's report callback, as `runRepeatedly` takes it. */
export type LoopReporter<T> = (run: JobRun<T>) => void | Promise<void>;

/**
 * {@link observeLoop} with the registry and error sink bound, for wiring modules that start
 * their own loops (`startR2MirrorLoops`): they take this as an optional hook and stay free
 * of the registry.
 */
export type LoopObserver = <T>(loop: string, report: LoopReporter<T>) => LoopReporter<T>;

export function loopObserver(registry: MetricsRegistry, onError: MetricsErrorSink): LoopObserver {
  return (loop, report) => observeLoop(registry, loop, report, onError);
}

/**
 * The dispatch cycle's dropped sends (A1.12). Both reasons are created at zero on the first
 * call — that is, the first cycle — so that `increase()` sees the first real drop instead of
 * a series that appears already at 1. A cycle that threw adds nothing: it claimed nothing.
 */
export function dispatchObserver(
  registry: MetricsRegistry,
): (run: JobRun<DispatchJobReport>) => void {
  return (run) => {
    const zero = { expired_unapproved: 0, ttl_expired: 0 };
    for (const increment of alertDropIncrements(run.value?.dropped ?? zero)) {
      registry.incCounter(increment.descriptor, increment.labels, increment.by);
    }
  };
}

/**
 * The evaluation cycle's deferred sends (A1.12). Both reasons are created at zero on the
 * first cycle, as the drop counter's are. A cycle that threw adds nothing: its report is
 * lost, so deferrals in batches it had already committed go uncounted. That undercount is
 * bounded to one failed cycle and is not a silent deferral — `fw_alert_approval_pending_seconds`
 * is read from the table, not from this counter, and still sees the rows.
 */
export function alertEvaluationObserver(
  registry: MetricsRegistry,
): (run: JobRun<AlertEvaluationCycleReport>) => void {
  return (run) => {
    for (const increment of alertDeferralIncrements(run.value?.deferred ?? noDeferrals())) {
      registry.incCounter(increment.descriptor, increment.labels, increment.by);
    }
  };
}

/**
 * The alert evaluation loop's report callback, instrumented: loop metrics plus the
 * deferral counter. One function so the worker cannot wire the loop metrics and forget
 * the counter.
 */
export function observeAlertEvaluation(
  registry: MetricsRegistry,
  report: LoopReporter<AlertEvaluationCycleReport>,
  onError: MetricsErrorSink,
): LoopReporter<AlertEvaluationCycleReport> {
  return observeLoop(
    registry,
    'alert_evaluation',
    report,
    onError,
    alertEvaluationObserver(registry),
  );
}

/** Fleet control at scrape time (API). A read that throws exports nothing that scrape. */
export function transportCollector(read: () => TransportReading): () => MetricSample[] {
  return () => transportSamples(read());
}

/** The ingest cycle's per-source counters. A cycle that threw adds nothing. */
export function ingestObserver(
  registry: MetricsRegistry,
): (run: JobRun<IngestCycleReport>) => void {
  return (run) => {
    if (run.value === undefined) return;
    for (const increment of ingestIncrements(run.value)) {
      registry.incCounter(increment.descriptor, increment.labels, increment.by);
    }
  };
}

/**
 * The monitors loop's readings. Each family is replaced wholesale, and a cycle that threw
 * clears them all: a reading the loop could not take must vanish (so `absent()` and a stale
 * alert can fire), never freeze at the last value it had.
 */
export function monitorObserver(
  registry: MetricsRegistry,
): (run: JobRun<MonitorCycleReport>) => void {
  const families = [...new Set([...META_ALERT_METRICS, ...Object.values(META_ALERT_SERIES)])];
  return (run) => {
    const samples = run.value === undefined ? [] : metaAlertSamples(run.value);
    for (const descriptor of families) {
      registry.replaceFamily(
        descriptor,
        samples.filter((sample) => sample.name === descriptor.name),
      );
    }
  };
}

export interface FreshnessCollectorDeps {
  readonly reader: FreshnessReader;
  readonly expected: readonly FreshnessRowId[];
  readonly clock: Clock;
}

/**
 * The API's freshness verdict at scrape time. A reader failure exports only
 * `fw_freshness_collector_up 0`: the rows vanish rather than repeat a verdict nobody
 * computed, and the collector-down rule pages on the zero.
 */
export function freshnessCollector(deps: FreshnessCollectorDeps): () => Promise<MetricSample[]> {
  return async () => {
    try {
      const observations = await deps.reader.readObservations(deps.expected);
      const { report } = evaluateFreshness({
        now: deps.clock.now(),
        expected: deps.expected,
        observations,
      });
      return [
        { name: FRESHNESS_COLLECTOR_UP.name, labels: {}, value: 1 },
        ...freshnessSamples(report),
      ];
    } catch {
      return [{ name: FRESHNESS_COLLECTOR_UP.name, labels: {}, value: 0 }];
    }
  };
}

export interface MetricsListener {
  readonly listen: () => Promise<void>;
  readonly close: () => Promise<void>;
}

export interface MetricsListenerOptions {
  /** The event-loop lag sampler; the real one unless a test hands in its own. */
  readonly lagSampler?: () => Pick<EventLoopLagSampler, 'sampleP99Ms' | 'stop'>;
}

/**
 * The internal `/metrics` listener on its own port. Never part of the public server.
 *
 * It also owns the process's `fw_event_loop_lag_p99_seconds`: a sampler of its own,
 * started on `listen` and read — which resets it — on every scrape, so the gauge is the
 * p99 since the previous scrape. Owned here because only a process that is scraped needs
 * one, and because the API's demotion sampler must keep its own five-second windows.
 */
export function createMetricsListener(
  config: MetricsConfig,
  registry: MetricsRegistry,
  options: MetricsListenerOptions = {},
): MetricsListener {
  const app = createMetricsServer({ registry, bearerToken: config.bearerToken });
  let lag: Pick<EventLoopLagSampler, 'sampleP99Ms' | 'stop'> | null = null;
  registry.addCollector(() => eventLoopLagSamples(lag?.sampleP99Ms() ?? null));
  return {
    listen: async () => {
      lag = (options.lagSampler ?? createEventLoopLagSampler)();
      await app.listen({ port: config.port, host: config.host });
    },
    close: async () => {
      lag?.stop();
      lag = null;
      await app.close();
    },
  };
}

/**
 * The nightly backup's textfile for Alloy's textfile collector: table gauges plus the
 * success instant. Written to a temporary name and renamed, so the collector never reads a
 * half-written file — a torn read would drop the timestamp and look like a missed backup.
 */
export async function writeBackupTextfile(
  dir: string,
  gauges: readonly TableGauge[],
  finishedAtMs: number,
): Promise<string> {
  const text = formatExposition(METRIC_CATALOG, backupSamples(gauges, finishedAtMs));
  const target = join(dir, 'fire_watch_backup.prom');
  const temporary = join(dir, `.fire_watch_backup.prom.${randomBytes(6).toString('hex')}.tmp`);
  try {
    await writeFile(temporary, text, { encoding: 'utf8', mode: 0o644 });
    await rename(temporary, target);
  } catch (error: unknown) {
    await rm(temporary, { force: true });
    throw error;
  }
  return target;
}

function guard(onError: MetricsErrorSink, record: () => void): void {
  try {
    record();
  } catch (error: unknown) {
    onError(error);
  }
}
