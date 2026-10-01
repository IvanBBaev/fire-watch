/**
 * The worker's F15 loop: refresh the pass platforms' orbital elements from CelesTrak into
 * the state dir the passes route reads (TASKS F15; DATA-SOURCES §F15).
 *
 * Only wired when `FIRE_WATCH_STATE_DIR` is set, like the other refresh jobs; without it
 * the passes route is not registered either (`health-wiring.ts`), so the two can never
 * disagree about where the elements live.
 */

import { createCelestrakHttpClient } from '../adapters/celestrak/celestrak-http-client.js';
import { createFsFeedStatusStore } from '../adapters/storage/fs-feed-status-store.js';
import { createFsPayloadStore } from '../adapters/storage/fs-payload-store.js';
import { canonicalJson } from '../core/determinism/canonical-json.js';
import {
  runTleRefresh,
  TLE_REFRESH_INTERVAL_MS,
  tleRefreshFailed,
  type TleRefreshDeps,
  type TleRefreshReport,
} from '../core/passes/tle-refresh.js';
import type { Clock } from '../core/ports/clock.js';
import type { Sleeper } from '../core/ports/sleeper.js';
import { runRepeatedly, type JobRun, type JobStats } from '../core/scheduler/repeating-job.js';
import type { LoopObserver } from './metrics-wiring.js';

export const TLE_LOOP = 'tle_refresh';

export function wirePassesRefresh(stateDir: string, clock: Clock): TleRefreshDeps {
  return {
    client: createCelestrakHttpClient({ clock }),
    payloads: createFsPayloadStore(stateDir),
    clock,
    feedStatus: createFsFeedStatusStore(stateDir),
  };
}

export interface PassesLoopRuntime {
  readonly clock: Clock;
  readonly sleeper: Sleeper;
  writeLine(line: string): void;
  readonly observe?: LoopObserver;
}

/** One canonical-JSON line per cycle; a halt is `degraded` every cycle until cleared. */
export function reportTleRefresh(
  run: JobRun<TleRefreshReport>,
  deps: { writeLine(line: string): void },
): void {
  if (run.value === undefined) {
    const error = run.error instanceof Error ? run.error.message : String(run.error);
    deps.writeLine(canonicalJson({ tle_refresh_failed: { error, at: run.finishedAt } }));
    return;
  }
  deps.writeLine(canonicalJson({ tle_refresh: run.value, degraded: tleRefreshFailed(run.value) }));
}

export function startPassesLoops(
  deps: TleRefreshDeps,
  runtime: PassesLoopRuntime,
  signal: AbortSignal,
): [name: string, stats: Promise<JobStats>][] {
  const observe: LoopObserver = runtime.observe ?? ((_loop, report) => report);
  return [
    [
      TLE_LOOP,
      runRepeatedly({
        intervalMs: TLE_REFRESH_INTERVAL_MS,
        clock: runtime.clock,
        sleeper: runtime.sleeper,
        signal,
        run: () => runTleRefresh(deps),
        report: observe(TLE_LOOP, (run: JobRun<TleRefreshReport>) => {
          reportTleRefresh(run, runtime);
        }),
      }),
    ],
  ];
}
