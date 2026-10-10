#!/usr/bin/env node
/**
 * The F18 lightning-context archive backfill (TASKS F18; DATA-SOURCES §F18).
 *
 *   node server/dist/app/lightning-backfill-cli.js
 *   node server/dist/app/lightning-backfill-cli.js --max-events=20 --max-products=100
 *
 * The worker answers an event's lightning context from the nine-hour document it keeps; an
 * event whose window has aged out of it — the worker was down, the credentials arrived
 * late, the event moved after the window left — is left `unavailable` or unanswered. This
 * job lists those events, fetches the archived LI LFL products covering each window from
 * the EUMETSAT Data Store, decodes them in the sandboxed child, and writes a `complete` row
 * only when every product of the window was read. A window the archive covers in part is
 * reported with its holes and written as nothing: an incomplete count is never a count.
 *
 * Bounded by `--max-events` and `--max-products` (downloads; records already in the state
 * dir are reused and free), and idempotent: run it again to work through a larger backlog.
 *
 * Without the EUMETSAT credentials it says so and exits 2 before listing anything.
 *
 * Exit codes: 0 — every listed event answered; 1 — a failure (store, search, download,
 * authentication); 2 — misconfiguration; 3 — some events are still incomplete (holes, or
 * the budget ran out). The summary is one canonical-JSON line on stdout; the starting line
 * goes to stderr.
 */

import { systemClock } from '../adapters/clock/system-clock.js';
import { createPgLightningContextStore } from '../adapters/db/pg-lightning-context-store.js';
import { createPgPool } from '../adapters/db/pg-pool.js';
import { createEumetsatDataStoreClient } from '../adapters/lightning/eumetsat-datastore-client.js';
import { createMtgLiDecoder } from '../adapters/sandbox/mtg-li-decoder.js';
import { createFsPayloadStore } from '../adapters/storage/fs-payload-store.js';
import { LIGHTNING_CONTEXT, LIGHTNING_CONTEXT_DRIFT } from '../core/config/lightning-context.js';
import { POLLING_BBOX } from '../core/config/polling-bbox.js';
import { canonicalJson } from '../core/determinism/canonical-json.js';
import { runLightningContextBackfill } from '../core/lightning/lightning-context-backfill.js';
import { ConfigError, describeConfig, loadConfig } from './config.js';
import {
  lightningBackfillExitCode,
  parseLightningBackfillArgs,
  requireLightningBackfill,
} from './lightning-backfill-config.js';
import { processLog } from './logging.js';

const APPLICATION_NAME = 'fire-watch-lightning-backfill';
const EXIT_MISCONFIGURED = 2;

/** Redacting from the first line: this job holds the EUMETSAT consumer secret. */
const log = processLog();

async function main(): Promise<number> {
  const limits = parseLightningBackfillArgs(process.argv.slice(2));
  const config = loadConfig(process.env, APPLICATION_NAME);
  const { lightning, stateDir } = requireLightningBackfill(config);

  log.note({
    starting: {
      ...describeConfig(config),
      max_events: limits.maxEvents,
      max_products: limits.maxProducts,
      context_params: LIGHTNING_CONTEXT.version,
      context_params_digest: LIGHTNING_CONTEXT.digest,
      drift: LIGHTNING_CONTEXT_DRIFT,
    },
  });

  const payloads = createFsPayloadStore(stateDir);
  const pool = createPgPool({
    databaseUrl: config.databaseUrl,
    role: config.databaseRole,
    applicationName: APPLICATION_NAME,
  });
  try {
    const report = await runLightningContextBackfill(
      {
        store: createPgLightningContextStore(pool),
        client: createEumetsatDataStoreClient({
          credentials: lightning.credentials,
          baseUrl: lightning.baseUrl,
          clock: systemClock,
        }),
        decoder: createMtgLiDecoder({ clip: POLLING_BBOX.values }),
        payloads,
        reader: payloads,
        clock: systemClock,
      },
      limits,
    );
    log.line(canonicalJson({ lightning_context_backfill: report }));
    return lightningBackfillExitCode(report);
  } finally {
    await pool.end();
  }
}

process.exitCode = await main().catch((error: unknown) => {
  log.fatal(error);
  return error instanceof ConfigError ? EXIT_MISCONFIGURED : 1;
});
