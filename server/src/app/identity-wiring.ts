/**
 * Wiring for the live identity pipeline (TASKS D1/D4): the loop that turns ingested
 * batches into registry events and moves them through the lifecycle, so that something in
 * the running system finally calls the EventStatusStore (E1).
 *
 * ## Its own pool
 *
 * The identity cycle holds one transaction per batch, with the engine running between its
 * statements, and a tick transaction that reads every live event. Sharing the ingest pool
 * would let a long backlog catch-up hold the connections a FIRMS poll needs — the poll is
 * the one job whose delay is unrecoverable (a missed `available_at` is a latency lie), so
 * the identity loop gets two connections of its own instead. Nothing here connects until
 * the first cycle queries, exactly like the ingest wiring.
 *
 * ## Cadence and batch limit
 *
 *   - **Every 60 s.** Independent of the poll interval on purpose: the loop measures
 *     end-of-run to start-of-run, so a minute bounds how long a freshly polled batch waits
 *     to become an event without coupling the two loops' phases. An idle cycle is two
 *     short transactions (the pending read and a tick over the live events), which at
 *     Bulgarian fire counts is negligible.
 *   - **At most 24 batches per cycle.** The three polled VIIRS sources at a 10-minute
 *     poll produce 18 batches an hour, so one cycle clears more than an hour of backlog
 *     while each batch lock is held for milliseconds and the cycle for seconds. The report's `limitReached` is the "behind, not idle"
 *     signal; the next cycle, one minute later, takes the next 24.
 *
 * ## What it does not wire
 *
 * The static hot-source mask (TASKS F16) is read from disk at wiring time — a missing or
 * malformed file still fails boot — and then re-checked at the start of every cycle
 * ({@link IdentityWiring.runCycle}): one `stat`, a read and hash only when the file moved,
 * a swap only when the bytes and the version both moved (`static-source-mask-file.ts`,
 * "Hot reload"). The swap replaces one evaluator reference, and every consumer in the
 * cycle reads `deps.staticSources` once per batch or sweep, so each verdict is taken and
 * stamped against one mask, never a mix. The same tick's static-source sweep then re-judges
 * every live event whose stored verdict names the old version, so a new mask reaches the
 * registry within one cycle plus the sweep limit's convergence — no restart. A rejected
 * file keeps the loaded mask and says so once per distinct reason on stderr.
 *
 * The pass predictor is the static pass table, the only one there is; its null-cloud
 * evidence and the unarmed declarations are core-side facts the cycle report already
 * reflects (no transitions from an empty cloud field), not something this module can
 * choose. No heartbeat: `identity` is not a budgeted job id in C5, and inventing one would
 * be a founder decision about paging — the per-cycle line is the evidence until then.
 */

import type { StaticSourceMask } from '@fire-watch/contracts';

import { systemClock } from '../adapters/clock/system-clock.js';
import { createPgClusteringStore } from '../adapters/db/pg-clustering-store.js';
import { createPgPool } from '../adapters/db/pg-pool.js';
import {
  createStaticSourceMaskReloader,
  type MaskFileSystem,
} from '../adapters/geodata/static-source-mask-file.js';
import { CLUSTERING_PARAMS } from '../core/clustering/clustering-params.js';
import {
  runIdentityCycle,
  type IdentityCycleDeps,
  type IdentityCycleReport,
} from '../core/identity/identity-cycle.js';
import { staticPassPredictor } from '../core/lifecycle/static-pass-predictor.js';
import {
  STATIC_SOURCE_POLICY,
  staticSourceEvaluator,
  type StaticSourceEvaluator,
} from '../core/static-sources/static-source-policy.js';
import type { ServerConfig } from './config.js';

export const IDENTITY_CYCLE_INTERVAL_MS = 60_000;

export const IDENTITY_MAX_BATCHES_PER_CYCLE = 24;

/** Two: the batch-or-tick transaction and the pending read never overlap within a cycle. */
const IDENTITY_POOL_MAX = 2;

export interface IdentityWiring {
  /** `staticSources` always answers the evaluator for the mask currently in force. */
  readonly deps: IdentityCycleDeps;
  /** Re-checks the mask file (hot reload), then runs one identity cycle. */
  runCycle(): Promise<IdentityCycleReport>;
  /** Re-checks the mask file only; what {@link runCycle} does first. Exposed for tests. */
  reloadStaticSources(): void;
  /** Releases the pool. Always called from a `finally`. */
  close(): Promise<void>;
}

export interface IdentityWiringOptions {
  /** Where reload lines go (the worker's stderr `note`); dropped when omitted. */
  readonly note?: (record: Record<string, unknown>) => void;
  /** Test seam for the mask file's `stat`/read. */
  readonly maskFileSystem?: MaskFileSystem;
}

export function wireIdentity(
  config: ServerConfig,
  options: IdentityWiringOptions = {},
): IdentityWiring {
  // Read before the pool exists: a missing mask fails boot without a connection to close.
  const reloader = createStaticSourceMaskReloader(config.staticSourcesPath, options.maskFileSystem);
  const evaluatorFor = (mask: StaticSourceMask): StaticSourceEvaluator =>
    // §3.6 override and §6.2 quarantine (TASKS F16), stamped with both versions (D7).
    staticSourceEvaluator(mask, STATIC_SOURCE_POLICY, CLUSTERING_PARAMS.values.metric);
  let evaluator = evaluatorFor(reloader.current());
  let lastRejection: string | null = null;

  const pool = createPgPool({
    databaseUrl: config.databaseUrl,
    role: config.databaseRole,
    applicationName: config.applicationName,
    max: IDENTITY_POOL_MAX,
  });

  const deps: IdentityCycleDeps = {
    store: createPgClusteringStore(pool, CLUSTERING_PARAMS),
    clock: systemClock,
    config: CLUSTERING_PARAMS,
    predictor: staticPassPredictor(),
    maxBatchesPerCycle: IDENTITY_MAX_BATCHES_PER_CYCLE,
    get staticSources(): StaticSourceEvaluator {
      return evaluator;
    },
  };

  const reloadStaticSources = (): void => {
    const outcome = reloader.check();
    if (outcome.kind === 'reloaded') {
      // The swap: one assignment, between cycles. The next read of `deps.staticSources`
      // is the new evaluator, whole.
      evaluator = evaluatorFor(reloader.current());
      lastRejection = null;
      options.note?.({
        static_source_mask_reloaded: { from: outcome.from, to: outcome.to, path: reloader.path },
      });
    } else if (outcome.kind === 'rejected' && outcome.reason !== lastRejection) {
      lastRejection = outcome.reason;
      options.note?.({
        static_source_mask_reload_rejected: {
          kept: outcome.version,
          reason: outcome.reason,
          path: reloader.path,
        },
      });
    }
  };

  return {
    deps,
    reloadStaticSources,
    runCycle: () => {
      reloadStaticSources();
      return runIdentityCycle(deps);
    },
    close: () => pool.end(),
  };
}
