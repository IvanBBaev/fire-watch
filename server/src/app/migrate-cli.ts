#!/usr/bin/env node
/**
 * The deploy's migration one-shot (review 27 E-5; OPERATIONS §9.3 rule 3):
 *
 *   node server/dist/app/migrate-cli.js
 *
 * Takes the migration advisory lock (`adapters/db/pg-migration-lock.ts`), runs
 * `dbmate up` while holding it, and releases it. Compose runs this as the `migrate`
 * service: `deploy.sh` runs it before restarting the worker, and the worker depends on it
 * completing, so a cold boot of the stack migrates too. Two runs at once serialise on the
 * lock; the second finds nothing left to apply.
 *
 * Exit codes: 0 — the schema is current; 1 — dbmate or the lock failed; 2 —
 * misconfiguration. dbmate's own output passes through unchanged.
 */

import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import pg from 'pg';

import { withMigrationLock } from '../adapters/db/pg-migration-lock.js';
import { ConfigError } from './config.js';
import { dbmateArgs, describeMigrateConfig, loadMigrateConfig } from './migrate-config.js';
import { processLog } from './logging.js';

const EXIT_MISCONFIGURED = 2;

const log = processLog();

/** `server/dist/app/` → `server/db/migrations`. */
const DEFAULT_MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../db/migrations');

async function main(): Promise<number> {
  const config = loadMigrateConfig(process.env, DEFAULT_MIGRATIONS_DIR);
  log.note({ starting: { migrate: describeMigrateConfig(config) } });

  const client = new pg.Client({
    connectionString: config.databaseUrl,
    application_name: 'fire-watch-migrate',
  });
  const code = await withMigrationLock(
    client,
    () =>
      new Promise<number>((resolve, reject) => {
        const child = spawn(config.dbmateBin, dbmateArgs(config), {
          stdio: 'inherit',
          env: process.env,
        });
        child.on('error', reject);
        child.on('exit', (exitCode, signal) => {
          resolve(exitCode ?? (signal === null ? 1 : 128));
        });
      }),
    config.lockTimeoutMs,
  );
  log.note({ migrate: { dbmate_exit: code } });
  return code === 0 ? 0 : 1;
}

process.exitCode = await main().catch((error: unknown) => {
  log.fatal(error);
  return error instanceof ConfigError ? EXIT_MISCONFIGURED : 1;
});
