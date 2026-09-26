/**
 * Wiring and per-run report for the NRT-lag histogram loop (TASKS C9; A23).
 *
 * Kept out of `worker.ts` so the worker's hookup is a handful of lines and the part worth
 * testing — which adapters the recorder gets, and what one run prints — sits where a test
 * can reach it. The lag CLI (`lag-histogram-cli.ts`) builds its recorder from the same
 * pieces, so "I recorded a day by hand" is evidence about the deployed loop.
 *
 * Nothing here connects: `createPgPool` opens a socket only when a query asks for one.
 *
 * The cadence is hourly. A run recomputes today and yesterday (see `lag-recorder.ts`), so
 * the interval only decides how stale today's partial row may be; it has no bearing on
 * correctness, and a missed run is healed by the next one.
 */

import { systemClock } from '../adapters/clock/system-clock.js';
import { createPgLagHistogramStore } from '../adapters/db/pg-lag-histogram-store.js';
import { createPgPool } from '../adapters/db/pg-pool.js';
import { canonicalJson } from '../core/determinism/canonical-json.js';
import { NRT_LAG_HISTOGRAM } from '../core/ingest/lag-histogram-params.js';
import type { LagRecorderDeps, LagRecordReport } from '../core/ingest/lag-recorder.js';
import type { JobRun } from '../core/scheduler/repeating-job.js';
import type { ServerConfig } from './config.js';

export const LAG_HISTOGRAM_INTERVAL_MS = 3_600_000;

export interface LagHistogramWiring {
  readonly deps: LagRecorderDeps;
  /** Releases the pool. Always called from a `finally`. */
  close(): Promise<void>;
}

export function wireLagHistograms(config: ServerConfig): LagHistogramWiring {
  const pool = createPgPool({
    databaseUrl: config.databaseUrl,
    role: config.databaseRole,
    applicationName: config.applicationName,
  });
  const store = createPgLagHistogramStore(pool);
  return {
    deps: { reader: store, store, clock: systemClock, config: NRT_LAG_HISTOGRAM },
    close: () => pool.end(),
  };
}

export interface LagRecordingReporterDeps {
  /** One canonical-JSON line per run, newline excluded; the worker adds it. */
  writeLine(line: string): void;
}

/**
 * No heartbeat leg: the histograms are evidence for a later fixture, not a feed the public
 * page answers for, so a failing run is a log line, not a page.
 */
export function reportLagRecording(
  run: JobRun<LagRecordReport>,
  deps: LagRecordingReporterDeps,
): void {
  if (run.value === undefined) {
    deps.writeLine(
      canonicalJson({
        lag_histograms_failed: {
          error: run.error instanceof Error ? run.error.message : String(run.error),
          at: run.finishedAt,
        },
      }),
    );
    return;
  }
  deps.writeLine(canonicalJson({ lag_histograms: run.value }));
}
