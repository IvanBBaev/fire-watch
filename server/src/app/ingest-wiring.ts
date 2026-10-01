/**
 * The one place that decides which adapters an ingest cycle actually gets.
 *
 * Both entrypoints use it: the worker (`worker.ts`), which polls on a cadence, and the
 * one-shot CLI (`ingest-cli.ts`), which runs a single cycle by hand. Sharing the wiring is
 * what makes "I ran it manually and it worked" evidence about the deployed process rather
 * than about a second, subtly different one.
 *
 * Nothing here connects: `createPgPool` opens a socket only when a query asks for one, so
 * building the wiring is safe even when the database is down — which is the state in which
 * the config log line matters most.
 */

import { detectionUid } from '@fire-watch/contracts/node';

import { systemClock } from '../adapters/clock/system-clock.js';
import { createPgDetectionStore } from '../adapters/db/pg-detection-store.js';
import { createPgPool } from '../adapters/db/pg-pool.js';
import { createPgQuarantineStore } from '../adapters/db/pg-quarantine-store.js';
import { createFirmsHttpClient } from '../adapters/firms/firms-http-client.js';
import { createFirmsKeylessClient } from '../adapters/firms/firms-keyless-client.js';
import type { IngestCycleDeps } from '../core/ingest/ingest-cycle.js';
import type { FirmsAreaClient } from '../core/ports/firms-client.js';
import type { ServerConfig } from './config.js';

export interface IngestWiring {
  readonly deps: IngestCycleDeps;
  /** Releases the pool. Always called from a `finally`, including on a failed cycle. */
  close(): Promise<void>;
}

export function wireIngest(config: ServerConfig): IngestWiring {
  const pool = createPgPool({
    databaseUrl: config.databaseUrl,
    role: config.databaseRole,
    applicationName: config.applicationName,
  });

  return {
    deps: {
      client: wireFirmsClient(config),
      detectionUid,
      store: createPgDetectionStore(pool),
      // The same pool, deliberately: the bookkeeping is not a second system, and giving it
      // its own connections would let the archive and the record of the archive disagree
      // about which of them the database is currently refusing.
      quarantineStore: createPgQuarantineStore(pool),
      clock: systemClock,
    },
    close: () => pool.end(),
  };
}

/**
 * The FIRMS adapter the config asked for. Both implement the same port, so nothing after
 * this line knows — or needs to know — whether the rows came through the keyed Area API
 * or through NASA's public regional files clipped to the same bbox.
 */
export function wireFirmsClient(config: ServerConfig): FirmsAreaClient {
  if (config.firmsMode === 'keyless') {
    return createFirmsKeylessClient({ baseUrl: config.firmsKeylessBaseUrl, clock: systemClock });
  }
  if (config.firmsMapKey === null) {
    // loadConfig refuses this combination; reaching it means a hand-built config.
    throw new Error('FIRMS area mode needs FIRMS_MAP_KEY');
  }
  return createFirmsHttpClient({
    mapKey: config.firmsMapKey,
    baseUrl: config.firmsBaseUrl,
    clock: systemClock,
  });
}
