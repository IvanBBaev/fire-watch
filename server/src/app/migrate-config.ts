/**
 * Configuration for the deploy's migration one-shot (`migrate-cli.ts`; review 27 E-5,
 * OPERATIONS §9.3 rule 3). In its own module, away from the entrypoint, so tests can
 * exercise it without importing a file whose top level runs `main()`.
 *
 *   * DATABASE_URL — required. The **login** user, not `fire_watch_app`: migrations create
 *     tables, roles and grants, so this connection deliberately takes no startup role.
 *   * FIRE_WATCH_DBMATE_BIN — optional, default `dbmate` (on PATH in the image).
 *   * FIRE_WATCH_MIGRATIONS_DIR — optional, default `server/db/migrations` resolved from
 *     the compiled CLI's own location, so it works from any working directory.
 *   * FIRE_WATCH_MIGRATION_LOCK_TIMEOUT_MS — optional, default
 *     {@link DEFAULT_MIGRATION_LOCK_TIMEOUT_MS}: how long to wait for a concurrent run.
 */

import { isAbsolute } from 'node:path';

import { DEFAULT_MIGRATION_LOCK_TIMEOUT_MS } from '../adapters/db/pg-migration-lock.js';
import type { Environment } from './config.js';
import { ConfigError } from './config.js';

export interface MigrateConfig {
  readonly databaseUrl: string;
  readonly dbmateBin: string;
  readonly migrationsDir: string;
  readonly lockTimeoutMs: number;
}

export function loadMigrateConfig(env: Environment, defaultMigrationsDir: string): MigrateConfig {
  const databaseUrl = env['DATABASE_URL'];
  if (databaseUrl === undefined || databaseUrl === '') {
    throw new ConfigError('missing required environment variable(s): DATABASE_URL');
  }
  const migrationsDir = nonBlank(env['FIRE_WATCH_MIGRATIONS_DIR']) ?? defaultMigrationsDir;
  if (!isAbsolute(migrationsDir)) {
    throw new ConfigError(
      `FIRE_WATCH_MIGRATIONS_DIR must be an absolute path, got ${JSON.stringify(migrationsDir)}`,
    );
  }
  const dbmateBin = nonBlank(env['FIRE_WATCH_DBMATE_BIN']) ?? 'dbmate';
  // A relative path would resolve against whatever the working directory happens to be.
  if (!isAbsolute(dbmateBin) && dbmateBin.includes('/')) {
    throw new ConfigError(
      `FIRE_WATCH_DBMATE_BIN must be a bare name or absolute path, got ${JSON.stringify(dbmateBin)}`,
    );
  }
  return {
    databaseUrl,
    dbmateBin,
    migrationsDir,
    lockTimeoutMs: readTimeout(env['FIRE_WATCH_MIGRATION_LOCK_TIMEOUT_MS']),
  };
}

/** The dbmate invocation: forward-only, no schema dump (the image has no writable tree). */
export function dbmateArgs(config: MigrateConfig): readonly string[] {
  return ['--no-dump-schema', '--migrations-dir', config.migrationsDir, 'up'];
}

/** Safe to log: the database URL carries the password and is never part of it. */
export function describeMigrateConfig(config: MigrateConfig): Record<string, unknown> {
  return {
    dbmate: config.dbmateBin,
    migrations_dir: config.migrationsDir,
    lock_timeout_ms: config.lockTimeoutMs,
  };
}

function readTimeout(raw: string | undefined): number {
  const value = nonBlank(raw);
  if (value === undefined) return DEFAULT_MIGRATION_LOCK_TIMEOUT_MS;
  if (!/^[1-9][0-9]*$/.test(value)) {
    throw new ConfigError(
      `FIRE_WATCH_MIGRATION_LOCK_TIMEOUT_MS must be a positive integer, got ${JSON.stringify(value)}`,
    );
  }
  return Number(value);
}

function nonBlank(raw: string | undefined): string | undefined {
  const value = raw?.trim();
  return value === undefined || value === '' ? undefined : value;
}
