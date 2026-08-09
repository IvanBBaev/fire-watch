/**
 * The adapters the probe surface gets.
 *
 * Its own pool, deliberately — not the ingest pool. Two reasons, and both of them are the
 * difference between a probe that reports an outage and a probe that joins one:
 *
 *   * The ingest pool is sized at one connection and holds it for the length of a cycle.
 *     A health query queued behind a partition scan is a health query that times out while
 *     the system it is asking about is perfectly fine.
 *   * The statement timeout has to be a second, not thirty (OPERATIONS §2.2 rule 5), and a
 *     one-second cap on the ingest pool would abort legitimate archive work.
 *
 * `expected` is the set of rows this deployment claims to run. Today that is the live FIRMS
 * sources, taken from the same function the ingest cycle polls — so the endpoint cannot
 * report on a source nobody polls, and cannot go green by forgetting one.
 */

import {
  isMonitoredFeedId,
  isMonitoredSourceId,
  type FreshnessRowId,
  type MonitoredSourceId,
} from '@fire-watch/contracts';
import type { Pool } from 'pg';

import { systemClock } from '../adapters/clock/system-clock.js';
import {
  createPgDatabaseProbe,
  createPgFreshnessReader,
} from '../adapters/db/pg-freshness-reader.js';
import { createPgPool } from '../adapters/db/pg-pool.js';
import { createHealthServer } from '../adapters/http/health-server.js';
import { liveFirmsSources } from '../core/ingest/firms-poller.js';
import type { ServerConfig } from './config.js';

/** §2.2 rule 5. Half of it is the answer budget; the rest is connect, serialize and write. */
export const HEALTH_STATEMENT_TIMEOUT_MS = 1_000;

/**
 * Two: one for the request in flight, one so a slow query cannot make the *next* probe look
 * like a database outage. More would let a burst of probes become one.
 */
const HEALTH_POOL_MAX = 2;

export interface HealthWiring {
  readonly listen: () => Promise<void>;
  readonly close: () => Promise<void>;
}

export function wireHealthServer(config: ServerConfig): HealthWiring {
  const pool: Pool = createPgPool({
    databaseUrl: config.databaseUrl,
    role: config.databaseRole,
    applicationName: config.applicationName,
    max: HEALTH_POOL_MAX,
    statementTimeoutMs: HEALTH_STATEMENT_TIMEOUT_MS,
    // A probe must fail fast rather than wait out a TCP handshake against a dead host.
    connectionTimeoutMs: HEALTH_STATEMENT_TIMEOUT_MS,
  });

  const app = createHealthServer({
    reader: createPgFreshnessReader(pool),
    probe: createPgDatabaseProbe(pool),
    clock: systemClock,
    expected: expectedRows(),
    ...(config.apiClientIpHeader !== undefined ? { clientIpHeader: config.apiClientIpHeader } : {}),
  });

  return {
    listen: async () => {
      await app.listen({ port: config.apiPort, host: config.apiHost });
    },
    close: async () => {
      try {
        await app.close();
      } finally {
        // Unconditionally, even when the server refuses to close: pg keeps idle clients'
        // sockets ref'd, and a pool that is never ended is a process that never exits.
        await pool.end();
      }
    },
  };
}

/**
 * What this deployment is answerable for. The unregistered feeds and the scheduled jobs are
 * absent because nothing writes them yet (TASKS: C3 for the cloud mask, C4 for the EFFIS
 * and weather feeds and the EFFIS refresh job, C6 for the backup jobs, E3 for the snapshot
 * push); adding them here before the job exists would make every deployment permanently
 * `warn` on rows nobody runs, which is how a warn state stops meaning anything.
 */
export function expectedRows(): readonly FreshnessRowId[] {
  // The filter is not defensive padding: `liveFirmsSources` speaks the registry's language,
  // which still contains `firms:modis`. A retired source must never acquire a budget by
  // accident, so the narrowing happens where the two vocabularies meet.
  return liveFirmsSources().filter(
    (source): source is MonitoredSourceId =>
      isMonitoredFeedId(source) && isMonitoredSourceId(source),
  );
}
