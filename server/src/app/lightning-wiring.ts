/**
 * The worker's F18 loop: fetch MTG LI LFL products from the EUMETSAT Data Store, decode
 * them in the sandboxed child, and keep the last six hours in the state dir the lightning
 * route reads (TASKS F18; DATA-SOURCES §F18).
 *
 * Wired only when the EUMETSAT credentials are configured (`config.lightning`), which
 * `loadConfig` already refuses without `FIRE_WATCH_STATE_DIR`. Without credentials nothing
 * is fetched, and the route answers 503 because no document exists — fail closed.
 */

import { createEumetsatDataStoreClient } from '../adapters/lightning/eumetsat-datastore-client.js';
import { createMtgLiDecoder } from '../adapters/sandbox/mtg-li-decoder.js';
import { createFsPayloadStore } from '../adapters/storage/fs-payload-store.js';
import { POLLING_BBOX } from '../core/config/polling-bbox.js';
import { canonicalJson } from '../core/determinism/canonical-json.js';
import {
  LIGHTNING_REFRESH_INTERVAL_MS,
  lightningRefreshFailed,
  runLightningRefresh,
  type LightningRefreshDeps,
  type LightningRefreshReport,
} from '../core/lightning/lightning-refresh.js';
import type { Clock } from '../core/ports/clock.js';
import type { Sleeper } from '../core/ports/sleeper.js';
import { runRepeatedly, type JobRun, type JobStats } from '../core/scheduler/repeating-job.js';
import type { LightningConfig } from './config.js';
import type { LoopObserver } from './metrics-wiring.js';

export const LIGHTNING_LOOP = 'lightning_refresh';

export function wireLightningRefresh(
  lightning: LightningConfig,
  stateDir: string,
  clock: Clock,
): LightningRefreshDeps {
  const store = createFsPayloadStore(stateDir);
  return {
    client: createEumetsatDataStoreClient({
      credentials: lightning.credentials,
      baseUrl: lightning.baseUrl,
      clock,
    }),
    decoder: createMtgLiDecoder({ clip: POLLING_BBOX.values }),
    payloads: store,
    reader: store,
    clock,
  };
}

export interface LightningLoopRuntime {
  readonly clock: Clock;
  readonly sleeper: Sleeper;
  writeLine(line: string): void;
  readonly observe?: LoopObserver;
}

/** One canonical-JSON line per cycle; degraded while a fetch, search or write fails. */
export function reportLightningRefresh(
  run: JobRun<LightningRefreshReport>,
  deps: { writeLine(line: string): void },
): void {
  if (run.value === undefined) {
    const error = run.error instanceof Error ? run.error.message : String(run.error);
    deps.writeLine(canonicalJson({ lightning_refresh_failed: { error, at: run.finishedAt } }));
    return;
  }
  deps.writeLine(
    canonicalJson({ lightning_refresh: run.value, degraded: lightningRefreshFailed(run.value) }),
  );
}

export function startLightningLoops(
  deps: LightningRefreshDeps,
  runtime: LightningLoopRuntime,
  signal: AbortSignal,
): [name: string, stats: Promise<JobStats>][] {
  const observe: LoopObserver = runtime.observe ?? ((_loop, report) => report);
  return [
    [
      LIGHTNING_LOOP,
      runRepeatedly({
        intervalMs: LIGHTNING_REFRESH_INTERVAL_MS,
        clock: runtime.clock,
        sleeper: runtime.sleeper,
        signal,
        run: () => runLightningRefresh(deps),
        report: observe(LIGHTNING_LOOP, (run: JobRun<LightningRefreshReport>) => {
          reportLightningRefresh(run, runtime);
        }),
      }),
    ],
  ];
}
