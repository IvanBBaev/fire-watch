#!/usr/bin/env node
/**
 * The backup/restore + RTO drill (TASKS J2; OPERATIONS §6.3; runbook 02): take a backup
 * now with the production job, restore that very artifact (and its personal companion,
 * unless `--main-only`) into a new scratch database, verify it — migrations present,
 * rule 8, the erasure horizon, and every table's row count against the gauges the backup
 * recorded inside its snapshot — and time the RTO path, manual steps included as the
 * operator reports them. One command; one record.
 *
 *   node server/dist/app/restore-drill-cli.js --environment=staging \
 *     --manual-step=provision_vm:18 --manual-step=deploy_stack:12 \
 *     --manual-step=restore_secrets:6 --manual-step=promote_and_boot:9 \
 *     --manual-step=flip_origin:4
 *   node server/dist/app/restore-drill-cli.js --environment=staging --main-only
 *   node server/dist/app/restore-drill-cli.js --environment=staging --restore-only
 *
 * Configuration: the backup side's (`BACKUP_AGE_RECIPIENT`, the store, PGDATABASE …) and
 * the restore side's (`FIRE_WATCH_RESTORE_…`), exactly as `backup-cli.ts` and
 * `restore-cli.ts` read them; `--restore-only` needs the restore side alone. The drill's
 * backup never pings the nightly check and never touches the nightly gauge ledger.
 *
 * It refuses a database or bucket that does not name itself non-production (see
 * `drill-config.ts`), never restores over an existing database, and leaves the scratch
 * database in place for the operator to inspect and drop.
 *
 * Exit codes: 0 — passed; 1 — failed (or the RTO exceeded); 3 — incomplete (manual steps
 * not reported, or a leg not exercised); 2 — misconfiguration or a refused target.
 */

import { readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { NO_BACKUP_PINGER } from '../adapters/backup/healthchecks-backup-pinger.js';
import {
  createFsRestoreWorkspace,
  createPgDumpAgeProducer,
  createPgRestoreTarget,
  createPsqlBackupDatabase,
  type PgConnection,
} from '../adapters/backup/pg-backup-tools.js';
import { createProcessRunner } from '../adapters/backup/process-runner.js';
import { systemClock } from '../adapters/clock/system-clock.js';
import { runBackup } from '../core/backup/backup-run.js';
import { runRestore } from '../core/backup/restore-run.js';
import { drillVerdict } from '../core/drills/drill-record.js';
import { captureRowCounts, runRestoreDrill } from '../core/drills/restore-drill.js';
import {
  describeBackupConfig,
  describeRestoreConfig,
  loadBackupConfig,
  loadRestoreConfig,
} from './backup-config.js';
import { createConfiguredBackupStore } from './backup-stores.js';
import { ConfigError } from './config.js';
import { guardDrillTarget, parseRestoreDrillArgs, storeLabel } from './drill-config.js';
import {
  DEFAULT_RECORD_DIR,
  DRILL_EXIT_CODES,
  drillSummaryLine,
  writeDrillRecord,
} from './drill-output.js';
import { processLog } from './logging.js';

const EXIT_MISCONFIGURED = 2;

/** `server/db/migrations`, from `server/dist/app/` and from `server/src/app/` alike. */
const MIGRATIONS_DIR = fileURLToPath(new URL('../../db/migrations', import.meta.url));

const log = processLog();

async function main(): Promise<number> {
  const args = parseRestoreDrillArgs(process.argv.slice(2), systemClock.now());
  const restoreConfig = loadRestoreConfig(process.env);
  const backupConfig = args.restoreOnly ? null : loadBackupConfig(process.env);
  const guarded = guardDrillTarget(
    {
      databaseName: backupConfig?.database ?? null,
      bucket: storeLabel(backupConfig?.store ?? restoreConfig.store),
    },
    args.confirmNotProduction,
  );
  if (backupConfig !== null && storeLabel(backupConfig.store) !== storeLabel(restoreConfig.store)) {
    throw new ConfigError(
      'the backup and restore stores differ: the drill must restore the artifact it just uploaded',
    );
  }
  log.note({
    starting: {
      drill: 'restore',
      environment: args.environment,
      database: args.database,
      main_only: args.mainOnly,
      restore_only: args.restoreOnly,
      key: args.key ?? 'newest',
      ...(backupConfig === null ? {} : describeBackupConfig(backupConfig)),
      ...describeRestoreConfig(restoreConfig),
      target_override: guarded.override !== null,
    },
  });

  const runner = createProcessRunner();
  const writeLine = (line: string): void => {
    log.line(line);
  };
  const store = createConfiguredBackupStore(restoreConfig.store, systemClock, (key) => {
    log.note({ swept: key });
  });

  let takeBackup = null;
  if (backupConfig !== null) {
    const connection: PgConnection = {
      execPrefix: backupConfig.pg.execPrefix,
      user: backupConfig.pg.user,
      database: backupConfig.database,
    };
    const writer = createConfiguredBackupStore(backupConfig.store, systemClock, (key) => {
      log.note({ swept: key });
    });
    takeBackup = () =>
      runBackup(
        { dryRun: false, keepLocalMain: 0 },
        {
          database: createPsqlBackupDatabase(runner, connection),
          producer: createPgDumpAgeProducer(runner, {
            connection,
            ageRecipient: backupConfig.ageRecipient,
            stagingDir: backupConfig.stagingDir,
          }),
          writer,
          // A drill is not the nightly job: it neither pings its check nor moves its ledger.
          pinger: NO_BACKUP_PINGER,
          clock: systemClock,
          writeLine,
        },
      );
  }

  const localMigrationFiles = (await readdir(MIGRATIONS_DIR)).filter((name) =>
    name.endsWith('.sql'),
  );
  const workspace = createFsRestoreWorkspace(restoreConfig.workDir);

  const record = await runRestoreDrill(
    {
      environment: args.environment,
      target: guarded.target,
      database: args.database,
      mainOnly: args.mainOnly,
      requestedKey: args.key,
      manualMinutes: args.manualMinutes,
      targetOverride: guarded.override,
    },
    {
      clock: systemClock,
      backup: takeBackup,
      async restore(mainKey) {
        await workspace.prepare();
        const captured = captureRowCounts(
          createPgRestoreTarget(runner, {
            connection: {
              execPrefix: restoreConfig.pg.execPrefix,
              user: restoreConfig.pg.user,
              database: restoreConfig.maintenanceDatabase,
            },
            ageIdentityFile: restoreConfig.ageIdentityFile,
          }),
        );
        const summary = await runRestore(
          { database: args.database, mainKey, mainOnly: args.mainOnly, localMigrationFiles },
          { reader: store, target: captured.target, workspace, clock: systemClock, writeLine },
        );
        return { summary, restoredCounts: captured.counts() };
      },
    },
  );
  const path = await writeDrillRecord(record, args.recordDir ?? DEFAULT_RECORD_DIR);
  log.line(drillSummaryLine(record, path));
  return DRILL_EXIT_CODES[drillVerdict(record)];
}

process.exitCode = await main().catch((error: unknown) => {
  log.fatal(error);
  return error instanceof ConfigError ? EXIT_MISCONFIGURED : 1;
});
