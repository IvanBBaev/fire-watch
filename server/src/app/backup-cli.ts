#!/usr/bin/env node
/**
 * The nightly backup (TASKS C6; OPERATIONS §6.2): two age-encrypted pg_dump artifacts from
 * one exported snapshot — the main set and the personal set — uploaded under their
 * retention keys, then the `nightly-backup` check pinged.
 *
 *   node server/dist/app/backup-cli.js             # the nightly run (systemd timer)
 *   node server/dist/app/backup-cli.js --dry-run   # read the registry, print the plan
 *
 * Configuration: see `backup-config.ts`. The Postgres tools run inside the database
 * container (`docker compose exec -T postgres` by default), so run it from the compose
 * directory; `age` runs on the host.
 *
 * Paging: a failed run pings `<heartbeat>/nightly-backup/fail`, and a run that never
 * happens is caught by the check's own grace period. A failure before the pinger exists
 * (misconfiguration) is paged by the unit's OnFailure= hook. A dry run never pings.
 *
 * Gauges: a `table_gauges` line carries every table's rows (counted inside the snapshot)
 * and bytes, and a `table_shrinkage` line compares them with the previous successful night,
 * kept in `<staging dir>/table-gauges.json`. Neither can fail the run.
 *
 * Exit codes: 0 — uploaded (or planned); 1 — the run failed; 2 — misconfiguration. The
 * starting line and notes go to stderr; stdout gets canonical-JSON progress lines.
 */

import { join } from 'node:path';

import { systemClock } from '../adapters/clock/system-clock.js';
import {
  createHealthchecksBackupPinger,
  NO_BACKUP_PINGER,
} from '../adapters/backup/healthchecks-backup-pinger.js';
import {
  createLocalFsGaugeLedger,
  TABLE_GAUGE_LEDGER_FILE,
} from '../adapters/backup/local-fs-gauge-ledger.js';
import {
  createPgDumpAgeProducer,
  createPsqlBackupDatabase,
  type PgConnection,
} from '../adapters/backup/pg-backup-tools.js';
import { createProcessRunner } from '../adapters/backup/process-runner.js';
import { runBackup } from '../core/backup/backup-run.js';
import { canonicalJson } from '../core/determinism/canonical-json.js';
import { describeBackupConfig, loadBackupConfig, parseBackupArgs } from './backup-config.js';
import { createConfiguredBackupStore } from './backup-stores.js';
import { ConfigError } from './config.js';
import { processLog } from './logging.js';
import { loadMetricsTextfileDir } from './metrics-config.js';
import { writeBackupTextfile } from './metrics-wiring.js';

const EXIT_MISCONFIGURED = 2;

const log = processLog();

async function main(): Promise<number> {
  const args = parseBackupArgs(process.argv.slice(2));
  const config = loadBackupConfig(process.env);
  const textfileDir = loadMetricsTextfileDir(process.env);
  log.note({ starting: { ...describeBackupConfig(config), dry_run: args.dryRun } });
  if (config.heartbeatUrl === null && !args.dryRun) {
    log.note({ warning: 'FIRE_WATCH_HEARTBEAT_URL is unset: this backup is unmonitored' });
  }

  const runner = createProcessRunner();
  const connection: PgConnection = {
    execPrefix: config.pg.execPrefix,
    user: config.pg.user,
    database: config.database,
  };
  const pinger =
    config.heartbeatUrl === null || args.dryRun
      ? NO_BACKUP_PINGER
      : createHealthchecksBackupPinger({
          pingBaseUrl: config.heartbeatUrl,
          onError: (reason) => {
            log.note({ ping_error: reason });
          },
        });

  const summary = await runBackup(
    { dryRun: args.dryRun, keepLocalMain: config.keepLocalMain },
    {
      database: createPsqlBackupDatabase(runner, connection),
      producer: createPgDumpAgeProducer(runner, {
        connection,
        ageRecipient: config.ageRecipient,
        stagingDir: config.stagingDir,
      }),
      writer: createConfiguredBackupStore(config.store, systemClock, (key) => {
        log.note({ swept: key });
      }),
      pinger,
      gaugeLedger: createLocalFsGaugeLedger(join(config.stagingDir, TABLE_GAUGE_LEDGER_FILE)),
      clock: systemClock,
      writeLine: (line) => {
        log.line(line);
      },
    },
  );
  log.line(
    canonicalJson({
      backup_summary: {
        mode: summary.mode,
        taken_at: summary.takenAt,
        unclassified: summary.plan.unclassified,
        uploaded: summary.uploaded.map((u) => ({ set: u.set, keys: u.keys, bytes: u.bytes })),
        // The full per-table gauges are the `table_gauges` progress line; the summary says
        // whether they exist and names what shrank, which is what a reader scans for.
        tables_gauged: summary.tableGauges?.gauges.length ?? null,
        tables_shrunk: summary.shrinkage?.shrunk.map((s) => s.relation) ?? null,
        tables_vanished: summary.shrinkage?.vanished ?? null,
      },
    }),
  );

  // C5: the success instant and table gauges for Alloy's textfile collector. After the
  // heartbeat, and never fatal: the backup itself succeeded, and a textfile that failed to
  // land shows up off-box as a stale timestamp, which is exactly the right alert.
  if (textfileDir !== null && summary.mode === 'backup') {
    try {
      const path = await writeBackupTextfile(
        textfileDir,
        summary.tableGauges?.gauges ?? [],
        systemClock.now(),
      );
      log.note({ metrics_textfile: path });
    } catch (error: unknown) {
      log.note({ metrics_textfile_failed: { reason: String(error) } });
    }
  }
  return 0;
}

process.exitCode = await main().catch((error: unknown) => {
  log.fatal(error);
  return error instanceof ConfigError ? EXIT_MISCONFIGURED : 1;
});
