/**
 * The worker's F18 loop: fetch MTG LI LFL products from the EUMETSAT Data Store, decode
 * them in the sandboxed child, and keep the last nine hours in the state dir the lightning
 * route reads (TASKS F18; DATA-SOURCES §F18).
 *
 * Wired only when the EUMETSAT credentials are configured (`config.lightning`), which
 * `loadConfig` already refuses without `FIRE_WATCH_STATE_DIR`. Without credentials nothing
 * is fetched, and the route answers 503 because no document exists — fail closed.
 *
 * After each refresh the same cycle answers the per-event lightning context (migration
 * 022) against the document it just wrote, on its own small pool. Without credentials
 * the pass never runs; the context route then says `pending`, and `no_data` once the
 * window has aged out — never a count.
 */

import { createEumetsatDataStoreClient } from '../adapters/lightning/eumetsat-datastore-client.js';
import { createPgLightningContextStore } from '../adapters/db/pg-lightning-context-store.js';
import { createPgPool } from '../adapters/db/pg-pool.js';
import { createMtgLiDecoder } from '../adapters/sandbox/mtg-li-decoder.js';
import { createFsFeedStatusStore } from '../adapters/storage/fs-feed-status-store.js';
import { createFsPayloadStore } from '../adapters/storage/fs-payload-store.js';
import { POLLING_BBOX } from '../core/config/polling-bbox.js';
import { canonicalJson } from '../core/determinism/canonical-json.js';
import {
  runLightningContextPass,
  type LightningContextDeps,
  type LightningContextReport,
} from '../core/lightning/lightning-context.js';
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
import type { LightningConfig, ServerConfig } from './config.js';
import type { LoopObserver } from './metrics-wiring.js';

export const LIGHTNING_LOOP = 'lightning_refresh';

/** The refresh, plus the context pass when a database is wired. */
export type LightningWiring = LightningRefreshDeps & {
  readonly context?: {
    readonly deps: LightningContextDeps;
    /** Releases the pool. Called once the loop has stopped. */
    close(): Promise<void>;
  };
};

/** What one cycle reports: the refresh, and the context pass (`null` when not wired). */
export type LightningCycleReport = LightningRefreshReport & {
  readonly context: LightningContextReport | null;
};

export function wireLightningRefresh(
  lightning: LightningConfig,
  stateDir: string,
  clock: Clock,
  database?: Pick<ServerConfig, 'databaseUrl' | 'databaseRole' | 'applicationName'>,
): LightningWiring {
  const store = createFsPayloadStore(stateDir);
  const refresh: LightningRefreshDeps = {
    client: createEumetsatDataStoreClient({
      credentials: lightning.credentials,
      baseUrl: lightning.baseUrl,
      clock,
    }),
    decoder: createMtgLiDecoder({ clip: POLLING_BBOX.values }),
    payloads: store,
    reader: store,
    clock,
    feedStatus: createFsFeedStatusStore(stateDir),
  };
  if (database === undefined) return refresh;
  // Nothing connects here: the pool opens a socket only when a query asks for one.
  const pool = createPgPool({
    databaseUrl: database.databaseUrl,
    role: database.databaseRole,
    applicationName: database.applicationName,
  });
  return {
    ...refresh,
    context: {
      deps: { store: createPgLightningContextStore(pool), reader: store, clock },
      close: () => pool.end(),
    },
  };
}

export interface LightningLoopRuntime {
  readonly clock: Clock;
  readonly sleeper: Sleeper;
  writeLine(line: string): void;
  readonly observe?: LoopObserver;
}

/** One canonical-JSON line per cycle; degraded while a fetch, search, write or the context pass fails. */
export function reportLightningRefresh(
  run: JobRun<LightningCycleReport>,
  deps: { writeLine(line: string): void },
): void {
  if (run.value === undefined) {
    const error = run.error instanceof Error ? run.error.message : String(run.error);
    deps.writeLine(canonicalJson({ lightning_refresh_failed: { error, at: run.finishedAt } }));
    return;
  }
  const degraded = lightningRefreshFailed(run.value) || (run.value.context?.error ?? null) !== null;
  deps.writeLine(canonicalJson({ lightning_refresh: run.value, degraded }));
}

/** One cycle: the refresh, then the context pass against the document it just wrote. */
export async function runLightningCycle(deps: LightningWiring): Promise<LightningCycleReport> {
  const refresh = await runLightningRefresh(deps);
  const context =
    deps.context === undefined ? null : await runLightningContextPass(deps.context.deps);
  return { ...refresh, context };
}

export function startLightningLoops(
  deps: LightningWiring,
  runtime: LightningLoopRuntime,
  signal: AbortSignal,
): [name: string, stats: Promise<JobStats>][] {
  const observe: LoopObserver = runtime.observe ?? ((_loop, report) => report);
  const stats = runRepeatedly({
    intervalMs: LIGHTNING_REFRESH_INTERVAL_MS,
    clock: runtime.clock,
    sleeper: runtime.sleeper,
    signal,
    run: () => runLightningCycle(deps),
    report: observe(LIGHTNING_LOOP, (run: JobRun<LightningCycleReport>) => {
      reportLightningRefresh(run, runtime);
    }),
  });
  const context = deps.context;
  return [[LIGHTNING_LOOP, context === undefined ? stats : stats.finally(() => context.close())]];
}
