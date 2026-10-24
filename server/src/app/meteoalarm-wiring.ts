/**
 * The worker's V2-B3 loop: poll MeteoAlarm's national feeds into the state dir the
 * MeteoAlarm overlay route reads (DATA-SOURCES-EXTENDED §J11).
 *
 * Only wired when `FIRE_WATCH_STATE_DIR` is set; without it the route is not registered
 * either (`health-wiring.ts`). The refresh job holds its validators and CAP cache in memory,
 * so one job object lives for the whole loop.
 */

import { createMeteoalarmHttpClient } from '../adapters/meteoalarm/meteoalarm-http-client.js';
import { createFsFeedStatusStore } from '../adapters/storage/fs-feed-status-store.js';
import { createFsPayloadStore } from '../adapters/storage/fs-payload-store.js';
import { canonicalJson } from '../core/determinism/canonical-json.js';
import {
  METEOALARM_REFRESH_INTERVAL_MS,
  meteoalarmRefreshFailed,
  type MeteoalarmRefreshDeps,
  type MeteoalarmRefreshReport,
  createMeteoalarmRefresh,
} from '../core/meteoalarm/meteoalarm-refresh.js';
import type { Clock } from '../core/ports/clock.js';
import type { Sleeper } from '../core/ports/sleeper.js';
import { runRepeatedly, type JobRun, type JobStats } from '../core/scheduler/repeating-job.js';
import type { LoopObserver } from './metrics-wiring.js';

export const METEOALARM_LOOP = 'meteoalarm_refresh';

export function wireMeteoalarmRefresh(stateDir: string, clock: Clock): MeteoalarmRefreshDeps {
  return {
    client: createMeteoalarmHttpClient(),
    payloads: createFsPayloadStore(stateDir),
    clock,
    feedStatus: createFsFeedStatusStore(stateDir),
  };
}

export interface MeteoalarmLoopRuntime {
  readonly clock: Clock;
  readonly sleeper: Sleeper;
  writeLine(line: string): void;
  readonly observe?: LoopObserver;
}

/** One canonical-JSON line per cycle. */
export function reportMeteoalarmRefresh(
  run: JobRun<MeteoalarmRefreshReport>,
  deps: { writeLine(line: string): void },
): void {
  if (run.value === undefined) {
    const error = run.error instanceof Error ? run.error.message : String(run.error);
    deps.writeLine(canonicalJson({ meteoalarm_refresh_failed: { error, at: run.finishedAt } }));
    return;
  }
  deps.writeLine(
    canonicalJson({ meteoalarm_refresh: run.value, degraded: meteoalarmRefreshFailed(run.value) }),
  );
}

export function startMeteoalarmLoops(
  deps: MeteoalarmRefreshDeps,
  runtime: MeteoalarmLoopRuntime,
  signal: AbortSignal,
): [name: string, stats: Promise<JobStats>][] {
  const observe: LoopObserver = runtime.observe ?? ((_loop, report) => report);
  const refresh = createMeteoalarmRefresh(deps);
  return [
    [
      METEOALARM_LOOP,
      runRepeatedly({
        intervalMs: METEOALARM_REFRESH_INTERVAL_MS,
        clock: runtime.clock,
        sleeper: runtime.sleeper,
        signal,
        run: () => refresh.run(),
        report: observe(METEOALARM_LOOP, (run: JobRun<MeteoalarmRefreshReport>) => {
          reportMeteoalarmRefresh(run, runtime);
        }),
      }),
    ],
  ];
}
