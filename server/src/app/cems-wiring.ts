/**
 * The worker's V2-E3 loop: read the Copernicus EMS Rapid Mapping activation list into the
 * state dir the CEMS route reads (TASKS V2-E3; DATA-SOURCES §V2-E3).
 *
 * Only wired when `FIRE_WATCH_STATE_DIR` is set; without it the route is not registered
 * either (`health-wiring.ts`), so the two can never disagree about where the list lives.
 * The source needs no credentials, so there is no further gate.
 */

import { createCemsHttpClient } from '../adapters/cems/cems-http-client.js';
import { createFsFeedStatusStore } from '../adapters/storage/fs-feed-status-store.js';
import { createFsPayloadStore } from '../adapters/storage/fs-payload-store.js';
import {
  CEMS_REFRESH_INTERVAL_MS,
  cemsRefreshFailed,
  runCemsRefresh,
  type CemsRefreshDeps,
  type CemsRefreshReport,
} from '../core/cems/cems-refresh.js';
import { canonicalJson } from '../core/determinism/canonical-json.js';
import type { Clock } from '../core/ports/clock.js';
import type { Sleeper } from '../core/ports/sleeper.js';
import { runRepeatedly, type JobRun, type JobStats } from '../core/scheduler/repeating-job.js';
import type { LoopObserver } from './metrics-wiring.js';

export const CEMS_LOOP = 'cems_refresh';

export function wireCemsRefresh(stateDir: string, clock: Clock): CemsRefreshDeps {
  return {
    client: createCemsHttpClient({ clock }),
    payloads: createFsPayloadStore(stateDir),
    clock,
    feedStatus: createFsFeedStatusStore(stateDir),
  };
}

export interface CemsLoopRuntime {
  readonly clock: Clock;
  readonly sleeper: Sleeper;
  writeLine(line: string): void;
  readonly observe?: LoopObserver;
}

/** One canonical-JSON line per cycle. */
export function reportCemsRefresh(
  run: JobRun<CemsRefreshReport>,
  deps: { writeLine(line: string): void },
): void {
  if (run.value === undefined) {
    const error = run.error instanceof Error ? run.error.message : String(run.error);
    deps.writeLine(canonicalJson({ cems_refresh_failed: { error, at: run.finishedAt } }));
    return;
  }
  deps.writeLine(
    canonicalJson({ cems_refresh: run.value, degraded: cemsRefreshFailed(run.value) }),
  );
}

export function startCemsLoops(
  deps: CemsRefreshDeps,
  runtime: CemsLoopRuntime,
  signal: AbortSignal,
): [name: string, stats: Promise<JobStats>][] {
  const observe: LoopObserver = runtime.observe ?? ((_loop, report) => report);
  return [
    [
      CEMS_LOOP,
      runRepeatedly({
        intervalMs: CEMS_REFRESH_INTERVAL_MS,
        clock: runtime.clock,
        sleeper: runtime.sleeper,
        signal,
        run: () => runCemsRefresh(deps),
        report: observe(CEMS_LOOP, (run: JobRun<CemsRefreshReport>) => {
          reportCemsRefresh(run, runtime);
        }),
      }),
    ],
  ];
}
