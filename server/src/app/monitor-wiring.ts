/**
 * Wiring and per-cycle report for the meta-alert monitor loop (TASKS J1; GATES L-8).
 *
 * Kept out of `worker.ts` for the same reason as the other loops: the worker's hookup is
 * a handful of lines, and what the monitor is built from — and what one cycle prints — is
 * testable here.
 *
 * The pager rides on the heartbeat's ping key: with `FIRE_WATCH_HEARTBEAT_URL` set, the
 * monitor pings the `meta-alerts` check every cycle; without it, the monitor still runs and
 * logs its readings but pages nobody. The check must exist in healthchecks.io before the
 * first deploy that carries this loop, or every ping 404s (logged, never fatal).
 *
 * No canary: its probe needs an operator channel through the gateway, which is a founder
 * decision (see `core/ports/canary-probe.ts`). The reading reports `null` until then.
 */

import { systemClock } from '../adapters/clock/system-clock.js';
import { createPgMonitorReader } from '../adapters/db/pg-monitor-reader.js';
import { createPgPool } from '../adapters/db/pg-pool.js';
import { createHealthchecksMetaPager } from '../adapters/monitoring/healthchecks-meta-pager.js';
import { activeWindowMs, CLUSTERING_PARAMS } from '../core/clustering/clustering-params.js';
import { canonicalJson } from '../core/determinism/canonical-json.js';
import { META_ALERT_RULES } from '../core/monitoring/meta-alert-params.js';
import {
  createMonitorCycle,
  type MonitorCycle,
  type MonitorCycleReport,
} from '../core/monitoring/monitor-cycle.js';
import { noopMetaAlertPager, type MetaAlertPager } from '../core/ports/meta-alert-pager.js';
import type { JobRun } from '../core/scheduler/repeating-job.js';
import type { ServerConfig } from './config.js';

export { MONITOR_INTERVAL_MS } from '../core/monitoring/meta-alert-params.js';

/** Two aggregate queries a cycle, run concurrently; more connections would sit idle. */
export const MONITOR_POOL_MAX = 2;

export interface MonitorWiring {
  readonly cycle: MonitorCycle;
  /** Whether a real pager is attached — logged once at start-up by the worker. */
  readonly paging: boolean;
  /** Releases the pool. Always called from a `finally`. */
  close(): Promise<void>;
}

export interface MonitorWiringOptions {
  /** Told about a meta-alert ping that did not land; the reason is already redacted. */
  readonly onPagerError?: (reason: string) => void;
}

export function wireMonitors(
  config: ServerConfig,
  options: MonitorWiringOptions = {},
): MonitorWiring {
  const pool = createPgPool({
    databaseUrl: config.databaseUrl,
    role: config.databaseRole,
    applicationName: config.applicationName,
    max: MONITOR_POOL_MAX,
  });
  const pager = buildPager(config.heartbeatPingBaseUrl, options.onPagerError);
  const cycle = createMonitorCycle({
    reader: createPgMonitorReader(pool),
    pager,
    clock: systemClock,
    rules: META_ALERT_RULES,
    identityWindowMs: activeWindowMs(CLUSTERING_PARAMS.values),
    canary: null,
  });
  return { cycle, paging: pager !== noopMetaAlertPager, close: () => pool.end() };
}

function buildPager(
  pingBaseUrl: string | null,
  onError: ((reason: string) => void) | undefined,
): MetaAlertPager {
  if (pingBaseUrl === null) return noopMetaAlertPager;
  return createHealthchecksMetaPager(
    onError === undefined ? { pingBaseUrl } : { pingBaseUrl, onError },
  );
}

export interface MonitorReporterDeps {
  /** One canonical-JSON line per cycle, newline excluded; the worker adds it. */
  writeLine(line: string): void;
}

/**
 * One line per cycle. Transitions are lifted to a top-level `pages` field so a log search
 * for pages does not have to parse every reading; a failed cycle names its error, and
 * pages through the dead-man's switch because the pager was never called.
 */
export function reportMonitorCycle(
  run: JobRun<MonitorCycleReport>,
  deps: MonitorReporterDeps,
): void {
  if (run.value === undefined) {
    deps.writeLine(
      canonicalJson({
        meta_alerts_failed: {
          error: run.error instanceof Error ? run.error.message : String(run.error),
          at: run.finishedAt,
        },
      }),
    );
    return;
  }
  const { transitions, ...rest } = run.value;
  deps.writeLine(
    canonicalJson(
      transitions.length === 0 ? { meta_alerts: rest } : { meta_alerts: rest, pages: transitions },
    ),
  );
}
