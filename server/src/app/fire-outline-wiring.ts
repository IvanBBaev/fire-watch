/**
 * Wiring and per-run report for the estimated-outline loop (V2-A4).
 *
 * The loop follows the identity loop: identity attaches new detections to events and
 * bumps their `detection_count` / `last_detection_at`; this pass sees those values move
 * and draws the event's outline again. It runs on the identity cadence but as its own
 * loop with its own pool, so a slow outline pass can never delay identity, and an outline
 * failure is a log line rather than a missed identity cycle.
 *
 * Nothing here connects: `createPgPool` opens a socket only when a query asks for one.
 */

import { systemClock } from '../adapters/clock/system-clock.js';
import { createPgFireOutlineStore } from '../adapters/db/pg-fire-outline-store.js';
import { createPgPool } from '../adapters/db/pg-pool.js';
import { FIRE_OUTLINE_PARAMS } from '../core/config/fire-outline.js';
import { canonicalJson } from '../core/determinism/canonical-json.js';
import type {
  FireOutlinePassDeps,
  FireOutlinePassReport,
} from '../core/outlines/fire-outline-pass.js';
import type { JobRun } from '../core/scheduler/repeating-job.js';
import type { ServerConfig } from './config.js';
import { IDENTITY_CYCLE_INTERVAL_MS } from './identity-wiring.js';

/** The identity cadence: an outline is at most one identity cycle behind its event. */
export const FIRE_OUTLINE_INTERVAL_MS = IDENTITY_CYCLE_INTERVAL_MS;

export interface FireOutlineWiring {
  readonly deps: FireOutlinePassDeps;
  /** Releases the pool. Always called from a `finally`. */
  close(): Promise<void>;
}

export function wireFireOutlines(config: ServerConfig): FireOutlineWiring {
  const pool = createPgPool({
    databaseUrl: config.databaseUrl,
    role: config.databaseRole,
    applicationName: config.applicationName,
  });
  return {
    deps: {
      store: createPgFireOutlineStore(pool),
      clock: systemClock,
      params: FIRE_OUTLINE_PARAMS,
    },
    close: () => pool.end(),
  };
}

export interface FireOutlineReporterDeps {
  /** One canonical-JSON line per run, newline excluded; the worker adds it. */
  writeLine(line: string): void;
}

/**
 * No heartbeat leg: the overlay route answers 503 by itself once the pass heartbeat in
 * `fire_outline_pass` goes stale, so a stopped loop is visible on the map, not paged.
 */
export function reportFireOutlinePass(
  run: JobRun<FireOutlinePassReport>,
  deps: FireOutlineReporterDeps,
): void {
  if (run.value === undefined) {
    deps.writeLine(
      canonicalJson({
        fire_outlines_failed: {
          error: run.error instanceof Error ? run.error.message : String(run.error),
          at: run.finishedAt,
        },
      }),
    );
    return;
  }
  deps.writeLine(canonicalJson({ fire_outlines: run.value }));
}
