#!/usr/bin/env node
/**
 * The restore (TASKS C6; OPERATIONS §6.3; runbook 02): the newest (or a named) main
 * artifact and — unless it is past the personal retention, or `--main-only` — its personal
 * companion, downloaded, sha256-checked, decrypted on the host and restored into a **new
 * scratch database**, then verified: migrations present, personal tables empty on a
 * main-only restore (rule 8), no artifact older than the erasure horizon restored.
 *
 *   node server/dist/app/restore-cli.js --database=fw_restore_drill
 *   node server/dist/app/restore-cli.js --database=fw_restore_drill --main-only
 *   node server/dist/app/restore-cli.js --database=fw_restore_0924 --key=fw-main/daily/…
 *
 * It never restores into an existing database, and refuses the production name: promoting
 * a verified scratch database is a deliberate, separate operator step (runbook 02 §5).
 *
 * Configuration: see `backup-config.ts` — the **read** credential, never the VM's
 * write-only one, and the age identity file.
 *
 * Exit codes: 0 — restored and verified; 1 — failed, or restored with findings; 2 —
 * misconfiguration. stdout gets canonical-JSON progress lines and one summary line.
 */

import { readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import {
  createFsRestoreWorkspace,
  createPgRestoreTarget,
} from '../adapters/backup/pg-backup-tools.js';
import { createProcessRunner } from '../adapters/backup/process-runner.js';
import { systemClock } from '../adapters/clock/system-clock.js';
import { runRestore } from '../core/backup/restore-run.js';
import { canonicalJson } from '../core/determinism/canonical-json.js';
import { describeRestoreConfig, loadRestoreConfig, parseRestoreArgs } from './backup-config.js';
import { createConfiguredBackupStore } from './backup-stores.js';
import { ConfigError } from './config.js';
import { processLog } from './logging.js';

const EXIT_MISCONFIGURED = 2;

/** `server/db/migrations`, from `server/dist/app/` and from `server/src/app/` alike. */
const MIGRATIONS_DIR = fileURLToPath(new URL('../../db/migrations', import.meta.url));

const log = processLog();

async function main(): Promise<number> {
  const args = parseRestoreArgs(process.argv.slice(2));
  const config = loadRestoreConfig(process.env);
  log.note({
    starting: {
      ...describeRestoreConfig(config),
      database: args.database,
      key: args.mainKey ?? 'newest',
      main_only: args.mainOnly,
    },
  });

  const workspace = createFsRestoreWorkspace(config.workDir);
  await workspace.prepare();
  const summary = await runRestore(
    {
      database: args.database,
      mainKey: args.mainKey,
      mainOnly: args.mainOnly,
      localMigrationFiles: (await readdir(MIGRATIONS_DIR)).filter((name) => name.endsWith('.sql')),
    },
    {
      // A restore never sweeps: the reader is only ever listed and downloaded from.
      reader: createConfiguredBackupStore(config.store, systemClock, () => undefined),
      target: createPgRestoreTarget(createProcessRunner(), {
        connection: {
          execPrefix: config.pg.execPrefix,
          user: config.pg.user,
          database: config.maintenanceDatabase,
        },
        ageIdentityFile: config.ageIdentityFile,
      }),
      workspace,
      clock: systemClock,
      writeLine: (line) => {
        log.line(line);
      },
    },
  );
  log.line(canonicalJson({ restore_summary: summary }));
  return summary.ok ? 0 : 1;
}

process.exitCode = await main().catch((error: unknown) => {
  log.fatal(error);
  return error instanceof ConfigError ? EXIT_MISCONFIGURED : 1;
});
