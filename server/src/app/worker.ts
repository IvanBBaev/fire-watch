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
 */

import { systemClock } from '../adapters/clock/system-clock.js';
import { createHealthchecksHeartbeat } from '../adapters/monitoring/healthchecks-heartbeat.js';
import { systemSleeper } from '../adapters/scheduler/system-sleeper.js';
import { canonicalJson } from '../core/determinism/canonical-json.js';
import { runIngestCycle } from '../core/ingest/ingest-cycle.js';
import { noopHeartbeat, type Heartbeat } from '../core/ports/heartbeat.js';
import { runRepeatedly } from '../core/scheduler/repeating-job.js';
import { ConfigError, describeConfig, loadConfig } from './config.js';
import { reportCycle } from './cycle-reporter.js';
import { wireIngest } from './ingest-wiring.js';

const APPLICATION_NAME = 'fire-watch-worker';

/** A misconfiguration is not a data problem, and the exit code says which one it was. */
const EXIT_MISCONFIGURED = 2;

async function main(): Promise<number> {
  const config = loadConfig(process.env, APPLICATION_NAME);
  process.stderr.write(`${canonicalJson({ starting: describeConfig(config) })}\n`);

  const controller = new AbortController();
  const stop = (signal: NodeJS.Signals): void => {
    // The first signal of either kind starts the drain and stands down BOTH handlers, so
    // the second signal — SIGTERM or SIGINT alike — reaches the default handler and ends
    // the process. An operator whose Ctrl+C follows the supervisor's SIGTERM gets to be
    // obeyed, not swallowed by a leftover handler re-aborting an aborted controller.
    process.removeListener('SIGTERM', stop);
    process.removeListener('SIGINT', stop);
    process.stderr.write(`${canonicalJson({ stopping: { signal } })}\n`);
    controller.abort();
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);

  const heartbeat = buildHeartbeat(config.heartbeatPingBaseUrl);
  const wiring = wireIngest(config);
  try {
    const stats = await runRepeatedly({
      intervalMs: config.pollIntervalMs,
      clock: systemClock,
      sleeper: systemSleeper,
      signal: controller.signal,
      run: () => runIngestCycle(wiring.deps),
      report: (run) =>
        reportCycle(run, {
          heartbeat,
          writeLine: (line) => {
            process.stdout.write(`${line}\n`);
          },
        }),
    });

    process.stderr.write(`${canonicalJson({ stopped: stats })}\n`);
    // A worker that was asked to stop stopped: that is a success, whatever the cycles did.
    // Whether the data is fresh enough is a question for the freshness budgets (C5), not
    // for the exit code of a process that ran for four months.
    return 0;
  } finally {
    await wiring.close();
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
    // The reason is already redacted by the adapter; the URL never reaches this line.
    onError: (job, reason) =>
      process.stderr.write(`${canonicalJson({ heartbeat_failed: { job, reason } })}\n`),
  });
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

process.exitCode = await main().catch((error: unknown) => {
  process.stderr.write(`${describeError(error)}\n`);
  return error instanceof ConfigError ? EXIT_MISCONFIGURED : 1;
});
