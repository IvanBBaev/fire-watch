#!/usr/bin/env node
/**
 * The erasure drill (TASKS I7; ADR-004 D8; OPERATIONS §6.2 rules 5, 7, 9): seed a
 * synthetic `drill-…@example.invalid` account with a row in every table the erasure plan
 * names, erase it through the production eraser, re-read every table, probe that a write
 * for the erased account is refused, and — with `--audit-backups` — check every personal
 * backup artifact is due to expire by the erasure's deadline. One command; one record.
 *
 *   node server/dist/app/erasure-drill-cli.js --environment=staging
 *   node server/dist/app/erasure-drill-cli.js --environment=staging --audit-backups
 *   node server/dist/app/erasure-drill-cli.js --environment=laptop --confirm-not-production
 *
 * It refuses a DATABASE_URL (or bucket) that does not name itself non-production; see
 * `drill-config.ts`. The record lands in `docs/drills/records/` (or `--record-dir`) and
 * is reviewed and committed by the operator (docs/drills/README.md).
 *
 * Exit codes: 0 — passed; 1 — failed; 3 — incomplete (a leg could not be exercised);
 * 2 — misconfiguration or a refused target. stdout gets one canonical-JSON summary line.
 */

import { systemClock } from '../adapters/clock/system-clock.js';
import { createPgAccountEraser } from '../adapters/db/pg-account-erasure.js';
import { observeErasure, seedDrillAccount } from '../adapters/db/pg-erasure-drill.js';
import { createPgPool } from '../adapters/db/pg-pool.js';
import { SET_PREFIX } from '../core/backup/backup-keys.js';
import { drillVerdict } from '../core/drills/drill-record.js';
import { runErasureDrill } from '../core/drills/erasure-drill.js';
import { describeRestoreConfig, loadRestoreConfig } from './backup-config.js';
import { createConfiguredBackupStore } from './backup-stores.js';
import { ConfigError } from './config.js';
import {
  guardDrillTarget,
  loadErasureDrillEnv,
  parseErasureDrillArgs,
  storeLabel,
} from './drill-config.js';
import {
  DEFAULT_RECORD_DIR,
  DRILL_EXIT_CODES,
  drillSummaryLine,
  writeDrillRecord,
} from './drill-output.js';
import { processLog } from './logging.js';

const EXIT_MISCONFIGURED = 2;

const log = processLog();

async function main(): Promise<number> {
  const args = parseErasureDrillArgs(process.argv.slice(2));
  const env = loadErasureDrillEnv(process.env);
  const restoreConfig = args.auditBackups ? loadRestoreConfig(process.env) : null;
  const guarded = guardDrillTarget(
    {
      databaseUrl: env.databaseUrl,
      bucket: restoreConfig === null ? null : storeLabel(restoreConfig.store),
    },
    args.confirmNotProduction,
  );
  log.note({
    starting: {
      drill: 'erasure',
      environment: args.environment,
      role: env.role,
      ...guarded.target,
      ...(restoreConfig === null ? { audit_backups: false } : describeRestoreConfig(restoreConfig)),
      target_override: guarded.override !== null,
    },
  });

  const pool = createPgPool({
    databaseUrl: env.databaseUrl,
    role: env.role,
    applicationName: 'fire-watch-erasure-drill',
    max: 2,
  });
  try {
    const reader =
      restoreConfig === null
        ? null
        : createConfiguredBackupStore(restoreConfig.store, systemClock, () => undefined);
    const record = await runErasureDrill(
      { environment: args.environment, target: guarded.target, targetOverride: guarded.override },
      {
        clock: systemClock,
        seed: () => seedDrillAccount(pool, { nowMs: systemClock.now() }),
        erase: createPgAccountEraser(pool),
        observe: (seed) => observeErasure(pool, seed),
        listPersonalBackups: reader === null ? null : () => reader.list(`${SET_PREFIX.personal}/`),
      },
    );
    const path = await writeDrillRecord(record, args.recordDir ?? DEFAULT_RECORD_DIR);
    log.line(drillSummaryLine(record, path));
    return DRILL_EXIT_CODES[drillVerdict(record)];
  } finally {
    await pool.end();
  }
}

process.exitCode = await main().catch((error: unknown) => {
  log.fatal(error);
  return error instanceof ConfigError ? EXIT_MISCONFIGURED : 1;
});
