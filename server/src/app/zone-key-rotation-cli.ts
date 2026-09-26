#!/usr/bin/env node
/**
 * Zone-centre key rotation by hand (TASKS I2; 05 §5.3.2): re-seal every zone centre still
 * under a retired key with the active key.
 *
 *   FIRE_WATCH_ZONE_KEY_ID=k2 FIRE_WATCH_ZONE_KEY=… FIRE_WATCH_ZONE_KEYS_RETIRED=k1:… \
 *     node server/dist/app/zone-key-rotation-cli.js [--batch-size=N] [--max-batches=N] [--dry-run]
 *
 * The sequence: deploy the API with the new key active and the old one retired, run this
 * until it exits 0, then drop the retired key. Re-running is always safe — the job is
 * idempotent and resumable (see `core/zones/rotate-zone-centre-keys.ts`).
 *
 * Output is one canonical-JSON report on stdout: key ids and counts only, never a zone id,
 * a coordinate or a ciphertext. The starting line goes to stderr.
 *
 * Exit codes: 0 — complete, every sealed row names the active key; 1 — rows that could not
 * be opened remain (see `failedByKeyId`), or the run failed; 2 — misconfiguration;
 * 3 — incomplete but clean: `--max-batches` or `--dry-run` stopped it, or a row raced; run
 * again.
 */

import { createAesGcmZoneCipher } from '../adapters/crypto/aes-gcm-zone-cipher.js';
import { createPgPool } from '../adapters/db/pg-pool.js';
import { createPgZoneCentreRekeyStore } from '../adapters/db/pg-zone-centre-rekey-store.js';
import { canonicalJson } from '../core/determinism/canonical-json.js';
import { rotateZoneCentreKeys } from '../core/zones/rotate-zone-centre-keys.js';
import { ConfigError } from './config.js';
import { processLog } from './logging.js';
import {
  describeZoneKeyRotationConfig,
  loadZoneKeyRotationConfig,
  parseZoneKeyRotationArgs,
  zoneKeyRotationExitCode,
} from './zone-key-rotation-config.js';

const EXIT_FAILED = 1;
const EXIT_MISCONFIGURED = 2;

const log = processLog();

async function main(): Promise<number> {
  const args = parseZoneKeyRotationArgs(process.argv.slice(2));
  const config = loadZoneKeyRotationConfig(process.env);

  log.note({
    starting: {
      ...describeZoneKeyRotationConfig(config),
      batch_size: args.batchSize,
      max_batches: args.maxBatches,
      dry_run: args.dryRun,
    },
  });

  const pool = createPgPool({
    databaseUrl: config.databaseUrl,
    role: config.databaseRole,
    applicationName: 'fire-watch-zone-key-rotation',
  });

  try {
    const report = await rotateZoneCentreKeys(
      {
        store: createPgZoneCentreRekeyStore(pool),
        cipher: createAesGcmZoneCipher(config.keyring),
        activeKeyId: config.keyring.active.id,
      },
      args,
    );
    log.line(canonicalJson({ zone_key_rotation: report }));
    return zoneKeyRotationExitCode(report);
  } finally {
    await pool.end();
  }
}

process.exitCode = await main().catch((error: unknown) => {
  log.fatal(error);
  return error instanceof ConfigError ? EXIT_MISCONFIGURED : EXIT_FAILED;
});
