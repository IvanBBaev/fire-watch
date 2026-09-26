#!/usr/bin/env node
/**
 * The worker: ingestion running continuously (TASKS C1, "live rows landing continuously").
 *
 *   node server/dist/app/worker.js
 *
 * Scheduling is in-process by contract (OPERATIONS §9.1) — never in the API process, never
 * in cron. Two things follow from that: the job can report its own outcome on every cycle,
 * which is what C5's heartbeat and freshness budgets attach to, and an overrun is a longer
 * gap rather than a second copy of the cycle racing the first.
 *
 * Shutdown is cooperative: SIGTERM aborts the pause immediately and lets an in-flight cycle
 * finish. If the supervisor loses patience and sends SIGKILL first, nothing is corrupted —
 * the cycle is idempotent by construction (deterministic `detection_uid`, ON CONFLICT DO
 * NOTHING), so the next run re-polls the same window and the re-sent rows are a no-op.
 *
 * One canonical-JSON line per cycle goes to stdout, so the container log is greppable by
 * source and two cycles can be diffed.
 *
 * The identity loop (TASKS D1/D4) runs beside ingestion on its own pool and cadence: it
 * turns ingested batches into registry events and ticks their lifecycle through the
 * EventStatusStore, so `seq` moves and the event stream has something to carry (E1). It is
 * always wired — unlike the refresh loops it needs nothing beyond the database — and its
 * stats are collected by name, because the set of loops now depends on configuration and
 * a positional destructure would silently attribute one loop's stats to another.
 *
 * The C9 lag-histogram loop is always wired too, hourly, on its own pool. The alert
 * dispatch loop (H4/H5) is off unless FIRE_WATCH_ALERT_DISPATCH_ENABLED=true; it opens and
 * closes its own pool and joins the stats under `dispatch`. The J1 meta-alert loop runs
 * every minute on its own small pool and pages through the healthchecks `meta-alerts` check
 * when a heartbeat URL is configured. The E3 R2 mirror (T2) pushes the snapshot and checks
 * its public age every minute, only when the FIRE_WATCH_R2_* group is configured. The D8
 * loop checks hourly whether the last closed ISO week has a stored QA report and builds it
 * if not. The I4 erasure purge runs daily; every retention is unarmed until ratified, so
 * today it reports and deletes nothing.
 */

import { systemClock } from '../adapters/clock/system-clock.js';
import { createHealthchecksHeartbeat } from '../adapters/monitoring/healthchecks-heartbeat.js';
import { systemSleeper } from '../adapters/scheduler/system-sleeper.js';
import { runAlertDigestCycle } from '../core/alerts/digest-pass.js';
import { runAlertEvaluationCycle } from '../core/alerts/evaluation-cycle.js';
import { runEffisRefresh } from '../core/effis/effis-refresh.js';
import { runIdentityCycle } from '../core/identity/identity-cycle.js';
import { recordLagHistograms } from '../core/ingest/lag-recorder.js';
import { runIngestCycle } from '../core/ingest/ingest-cycle.js';
import { runWeeklyQaReport } from '../core/qa/weekly-report-job.js';
import { noopHeartbeat, type Heartbeat } from '../core/ports/heartbeat.js';
import { runRepeatedly, type JobStats } from '../core/scheduler/repeating-job.js';
import { runWeatherRefresh } from '../core/weather/weather-refresh.js';
import {
  reportAlertEvaluationCycle,
  reportAlertEvaluationDisabled,
} from './alert-evaluation-reporter.js';
import { reportAlertDigestCycle, reportAlertDigestDisabled } from './alert-digest-reporter.js';
import { wireAlertDigest } from './alert-digest-wiring.js';
import { wireAlertEvaluation } from './alert-evaluation-wiring.js';
import { ConfigError, describeConfig, loadConfig } from './config.js';
import { reportCycle } from './cycle-reporter.js';
import { startDispatchJob } from './dispatch-wiring.js';
import { reportIdentityCycle } from './identity-reporter.js';
import { IDENTITY_CYCLE_INTERVAL_MS, wireIdentity } from './identity-wiring.js';
import { wireIngest } from './ingest-wiring.js';
import {
  LAG_HISTOGRAM_INTERVAL_MS,
  reportLagRecording,
  wireLagHistograms,
} from './lag-histogram-wiring.js';
import {
  ERASURE_PURGE_INTERVAL_MS,
  reportErasurePurge,
  runErasurePurge,
  wireErasurePurge,
} from './erasure-purge-wiring.js';
import { processLog } from './logging.js';
import { describeMetricsConfig, loadMetricsConfig } from './metrics-config.js';
import {
  createMetricsListener,
  createProcessMetrics,
  dispatchObserver,
  ingestObserver,
  instrumentHeartbeat,
  loopObserver,
  monitorObserver,
  observeAlertDigest,
  observeAlertEvaluation,
  observeLoop,
  type MetricsErrorSink,
} from './metrics-wiring.js';
import { QA_REPORT_INTERVAL_MS, reportQaWeekly, wireQaReport } from './qa-report-wiring.js';
import { describeR2MirrorConfig, loadR2MirrorConfig } from './r2-mirror-config.js';
import { startR2MirrorLoops, wireR2Mirror } from './r2-mirror-wiring.js';
import { MONITOR_INTERVAL_MS, reportMonitorCycle, wireMonitors } from './monitor-wiring.js';
import { reportEffisRefresh, reportWeatherRefresh } from './refresh-reporter.js';
import {
  EFFIS_REFRESH_INTERVAL_MS,
  WEATHER_REFRESH_INTERVAL_MS,
  wireRefreshJobs,
} from './refresh-wiring.js';

const APPLICATION_NAME = 'fire-watch-worker';

/** A misconfiguration is not a data problem, and the exit code says which one it was. */
const EXIT_MISCONFIGURED = 2;

/**
 * Built before `main()`, from the environment rather than the config, so that the fatal
 * handler below is redacting from the first line — including the line that says config
 * could not be read (C8).
 */
const log = processLog();

async function main(): Promise<number> {
  const config = loadConfig(process.env, APPLICATION_NAME);
  log.note({ starting: describeConfig(config) });

  const controller = new AbortController();
  const stop = (signal: NodeJS.Signals): void => {
    // The first signal of either kind starts the drain and stands down BOTH handlers, so
    // the second signal — SIGTERM or SIGINT alike — reaches the default handler and ends
    // the process. An operator whose Ctrl+C follows the supervisor's SIGTERM gets to be
    // obeyed, not swallowed by a leftover handler re-aborting an aborted controller.
    process.removeListener('SIGTERM', stop);
    process.removeListener('SIGINT', stop);
    log.note({ stopping: { signal } });
    controller.abort();
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);

  // C5: the internal /metrics listener, off unless FIRE_WATCH_METRICS_PORT is set. The
  // registry is always built, so the hookups below are unconditional and cost nothing.
  const metricsConfig = loadMetricsConfig(process.env, config.apiPort);
  log.note({ metrics: describeMetricsConfig(metricsConfig) });
  const metrics = createProcessMetrics();
  const onMetricsError: MetricsErrorSink = (error) => {
    log.note({ metrics_record_failed: { reason: String(error) } });
  };
  const heartbeat = instrumentHeartbeat(
    buildHeartbeat(config.heartbeatPingBaseUrl),
    metrics,
    systemClock,
    onMetricsError,
  );
  const wiring = wireIngest(config);
  const refresh = wireRefreshJobs(config);
  const identity = wireIdentity(config);
  const lag = wireLagHistograms(config);
  // H3: disabled with named blockers until cadence, routing (H2/D7) and the zone keyring
  // are all in place; a malformed keyring is still a ConfigError.
  // H3: the digest pass that pays the evaluation loop's defers — same regime, its own
  // blockers (digest routing is H2/D7 too).
  const alertDigest = wireAlertDigest(config, process.env, { routing: null });
  const alertEval = wireAlertEvaluation(config, process.env, {
    routing: null,
    digestEnabled: alertDigest.enabled,
  });
  const qa = wireQaReport(config);
  const purge = wireErasurePurge(config);
  const r2 = loadR2MirrorConfig(process.env, config.staticSnapshotUrl);
  log.note({ r2_mirror: describeR2MirrorConfig(r2) });
  const mirror = wireR2Mirror(config, r2);
  const monitors = wireMonitors(config, {
    onPagerError: (reason) => {
      log.note({ meta_alert_ping_failed: { reason } });
    },
  });
  // The reporters serialize their own canonical-JSON line; the sink redacts it. A cycle
  // report carries whatever an adapter's error message carried, so the redaction has to
  // sit here rather than in each reporter.
  const writeLine = (line: string): void => {
    log.line(line);
  };

  const metricsListener =
    metricsConfig === null ? null : createMetricsListener(metricsConfig, metrics);

  try {
    await metricsListener?.listen();
    // Off unless FIRE_WATCH_ALERT_DISPATCH_ENABLED=true. Throws ConfigError before any loop
    // starts when enabled without a state dir, because the kill switch lives there.
    const dispatch = startDispatchJob(
      config,
      {
        writeLine,
        observe: (report) =>
          observeLoop(metrics, 'dispatch', report, onMetricsError, dispatchObserver(metrics)),
      },
      controller.signal,
    );
    if (dispatch === null) {
      log.note({ dispatch_disabled: { reason: 'FIRE_WATCH_ALERT_DISPATCH_ENABLED is not true' } });
    }
    if (!monitors.paging) {
      log.note({ meta_alerts_unpaged: { reason: 'FIRE_WATCH_HEARTBEAT_URL is not set' } });
    }

    // The always-on loops (ingest, identity, lag histograms, monitors, QA report, erasure purge)
    // plus the optional ones: dispatch, alert evaluation, the two C4 refresh loops and the R2
    // mirror. Independent loops on independent cadences, sharing one abort signal: a
    // slow EFFIS GetMap must not delay a FIRMS poll, and one SIGTERM drains all of them.
    const loops: [name: string, stats: Promise<JobStats>][] = [];
    loops.push(
      [
        'ingest',
        runRepeatedly({
          intervalMs: config.pollIntervalMs,
          clock: systemClock,
          sleeper: systemSleeper,
          signal: controller.signal,
          run: () => runIngestCycle(wiring.deps),
          report: observeLoop(
            metrics,
            'ingest',
            (run) => reportCycle(run, { heartbeat, writeLine }),
            onMetricsError,
            ingestObserver(metrics),
          ),
        }),
      ],
      [
        'identity',
        runRepeatedly({
          intervalMs: IDENTITY_CYCLE_INTERVAL_MS,
          clock: systemClock,
          sleeper: systemSleeper,
          signal: controller.signal,
          run: () => runIdentityCycle(identity.deps),
          report: observeLoop(
            metrics,
            'identity',
            (run) => {
              reportIdentityCycle(run, { writeLine });
            },
            onMetricsError,
          ),
        }),
      ],
      [
        'lag_histograms',
        runRepeatedly({
          intervalMs: LAG_HISTOGRAM_INTERVAL_MS,
          clock: systemClock,
          sleeper: systemSleeper,
          signal: controller.signal,
          run: () => recordLagHistograms(lag.deps),
          report: observeLoop(
            metrics,
            'lag_histograms',
            (run) => {
              reportLagRecording(run, { writeLine });
            },
            onMetricsError,
          ),
        }),
      ],
      [
        'monitors',
        runRepeatedly({
          intervalMs: MONITOR_INTERVAL_MS,
          clock: systemClock,
          sleeper: systemSleeper,
          signal: controller.signal,
          run: () => monitors.cycle.runOnce(),
          report: observeLoop(
            metrics,
            'monitors',
            (run) => {
              reportMonitorCycle(run, { writeLine });
            },
            onMetricsError,
            monitorObserver(metrics),
          ),
        }),
      ],
      [
        'qa_weekly_report',
        runRepeatedly({
          intervalMs: QA_REPORT_INTERVAL_MS,
          clock: systemClock,
          sleeper: systemSleeper,
          signal: controller.signal,
          run: () => runWeeklyQaReport(qa.deps),
          report: observeLoop(
            metrics,
            'qa_weekly_report',
            (run) => {
              reportQaWeekly(run, { writeLine });
            },
            onMetricsError,
          ),
        }),
      ],
      [
        'erasure_purge',
        runRepeatedly({
          intervalMs: ERASURE_PURGE_INTERVAL_MS,
          clock: systemClock,
          sleeper: systemSleeper,
          signal: controller.signal,
          run: () => runErasurePurge(purge.deps),
          report: observeLoop(
            metrics,
            'erasure_purge',
            (run) => {
              reportErasurePurge(run, { writeLine });
            },
            onMetricsError,
          ),
        }),
      ],
    );
    if (dispatch !== null) loops.push(['dispatch', dispatch]);
    if (alertEval.enabled) {
      loops.push([
        'alert_evaluation',
        runRepeatedly({
          intervalMs: alertEval.intervalMs,
          clock: systemClock,
          sleeper: systemSleeper,
          signal: controller.signal,
          run: () => runAlertEvaluationCycle(alertEval.deps),
          report: observeAlertEvaluation(
            metrics,
            (run) => {
              reportAlertEvaluationCycle(run, { writeLine });
            },
            onMetricsError,
          ),
        }),
      ]);
    } else {
      reportAlertEvaluationDisabled(alertEval, { writeLine });
    }
    if (alertDigest.enabled) {
      loops.push([
        'alert_digest',
        runRepeatedly({
          intervalMs: alertDigest.intervalMs,
          clock: systemClock,
          sleeper: systemSleeper,
          signal: controller.signal,
          run: () => runAlertDigestCycle(alertDigest.deps),
          report: observeAlertDigest(
            metrics,
            (run) => {
              reportAlertDigestCycle(run, { writeLine });
            },
            onMetricsError,
          ),
        }),
      ]);
    } else {
      reportAlertDigestDisabled(alertDigest, { writeLine });
    }
    if (refresh === null) {
      // Visible, because "the FWI layer never updates" must be traceable to this line
      // rather than to a loop that silently was not wired.
      log.note({ refresh_disabled: { reason: 'FIRE_WATCH_STATE_DIR is not set' } });
    } else {
      loops.push(
        [
          'effis',
          runRepeatedly({
            intervalMs: EFFIS_REFRESH_INTERVAL_MS,
            clock: systemClock,
            sleeper: systemSleeper,
            signal: controller.signal,
            run: () => runEffisRefresh(refresh.effisDeps),
            report: observeLoop(
              metrics,
              'effis',
              (run) => reportEffisRefresh(run, { heartbeat, writeLine }),
              onMetricsError,
            ),
          }),
        ],
        [
          'weather',
          runRepeatedly({
            intervalMs: WEATHER_REFRESH_INTERVAL_MS,
            clock: systemClock,
            sleeper: systemSleeper,
            signal: controller.signal,
            run: () => runWeatherRefresh(refresh.weatherDeps),
            report: observeLoop(
              metrics,
              'weather',
              (run) => {
                reportWeatherRefresh(run, { writeLine });
              },
              onMetricsError,
            ),
          }),
        ],
      );
    }

    if (mirror.kind === 'disabled') {
      log.note({ r2_mirror_disabled: { reason: mirror.reason } });
    } else {
      if (mirror.monitorDisabledReason !== null) {
        log.note({ r2_mirror_age_disabled: { reason: mirror.monitorDisabledReason } });
      }
      loops.push(
        ...startR2MirrorLoops(
          mirror,
          {
            clock: systemClock,
            sleeper: systemSleeper,
            heartbeat,
            writeLine,
            observe: loopObserver(metrics, onMetricsError),
          },
          controller.signal,
        ),
      );
    }

    const stats = await Promise.all(loops.map(([, loop]) => loop));
    log.note({
      stopped: Object.fromEntries(loops.map(([name], i) => [name, stats[i]])),
    });
    // A worker that was asked to stop stopped: that is a success, whatever the cycles did.
    // Whether the data is fresh enough is a question for the freshness budgets (C5), not
    // for the exit code of a process that ran for four months.
    return 0;
  } finally {
    await Promise.all([
      wiring.close(),
      identity.close(),
      lag.close(),
      monitors.close(),
      qa.close(),
      purge.close(),
      alertEval.enabled ? alertEval.close() : Promise.resolve(),
      alertDigest.enabled ? alertDigest.close() : Promise.resolve(),
      mirror.kind === 'enabled' ? mirror.close() : Promise.resolve(),
      metricsListener === null ? Promise.resolve() : metricsListener.close(),
    ]);
  }
}

/**
 * A dead-man's switch when one is configured, and an honest nothing when one is not
 * (OPERATIONS §3). A developer box that silently pinged production's check would make the
 * one monitor that is supposed to survive our whole VM report on somebody's laptop.
 */
function buildHeartbeat(pingBaseUrl: string | null): Heartbeat {
  if (pingBaseUrl === null) return noopHeartbeat;
  return createHealthchecksHeartbeat({
    pingBaseUrl,
    // The reason is redacted twice over: by the adapter, which knows the ping URL, and
    // again by the sink, which knows every secret in the environment.
    onError: (job, reason) => {
      log.note({ heartbeat_failed: { job, reason } });
    },
  });
}

process.exitCode = await main().catch((error: unknown) => {
  log.fatal(error);
  return error instanceof ConfigError ? EXIT_MISCONFIGURED : 1;
});
