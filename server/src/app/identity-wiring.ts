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
 * The pass predictor is the static pass table, the only one there is; its null-cloud
 * evidence and the unarmed declarations are core-side facts the cycle report already
 * reflects (no transitions from an empty cloud field), not something this module can
 * choose. No heartbeat: `identity` is not a budgeted job id in C5, and inventing one would
 * be a founder decision about paging — the per-cycle line is the evidence until then.
 */

import { systemClock } from '../adapters/clock/system-clock.js';
import { createPgClusteringStore } from '../adapters/db/pg-clustering-store.js';
import { createPgPool } from '../adapters/db/pg-pool.js';
import { CLUSTERING_PARAMS } from '../core/clustering/clustering-params.js';
import type { IdentityCycleDeps } from '../core/identity/identity-cycle.js';
import { staticPassPredictor } from '../core/lifecycle/static-pass-predictor.js';
import type { ServerConfig } from './config.js';

export const IDENTITY_CYCLE_INTERVAL_MS = 60_000;

export const IDENTITY_MAX_BATCHES_PER_CYCLE = 24;

/** Two: the batch-or-tick transaction and the pending read never overlap within a cycle. */
const IDENTITY_POOL_MAX = 2;

export interface IdentityWiring {
  readonly deps: IdentityCycleDeps;
  /** Releases the pool. Always called from a `finally`. */
  close(): Promise<void>;
}

export function wireIdentity(config: ServerConfig): IdentityWiring {
  const pool = createPgPool({
    databaseUrl: config.databaseUrl,
    role: config.databaseRole,
    applicationName: config.applicationName,
    max: IDENTITY_POOL_MAX,
  });

  return {
    deps: {
      store: createPgClusteringStore(pool, CLUSTERING_PARAMS),
      clock: systemClock,
      config: CLUSTERING_PARAMS,
      predictor: staticPassPredictor(),
      maxBatchesPerCycle: IDENTITY_MAX_BATCHES_PER_CYCLE,
    },
    close: () => pool.end(),
  };
}
