import { describe, expect, it } from 'vitest';

import { DEFAULT_MIGRATION_LOCK_TIMEOUT_MS } from '../adapters/db/pg-migration-lock.js';
import { ConfigError } from './config.js';
import { dbmateArgs, describeMigrateConfig, loadMigrateConfig } from './migrate-config.js';

const URL = 'postgres://owner:pw@postgres:5432/fire_watch';

describe('loadMigrateConfig', () => {
  it('defaults to dbmate on PATH, the given directory and the default lock wait', () => {
    expect(loadMigrateConfig({ DATABASE_URL: URL }, '/app/db/migrations')).toEqual({
      databaseUrl: URL,
      dbmateBin: 'dbmate',
      migrationsDir: '/app/db/migrations',
      lockTimeoutMs: DEFAULT_MIGRATION_LOCK_TIMEOUT_MS,
    });
  });

  it('takes overrides', () => {
    const config = loadMigrateConfig(
      {
        DATABASE_URL: URL,
        FIRE_WATCH_DBMATE_BIN: '/usr/local/bin/dbmate',
        FIRE_WATCH_MIGRATIONS_DIR: '/srv/migrations',
        FIRE_WATCH_MIGRATION_LOCK_TIMEOUT_MS: '1000',
      },
      '/app/db/migrations',
    );
    expect(config.dbmateBin).toBe('/usr/local/bin/dbmate');
    expect(config.migrationsDir).toBe('/srv/migrations');
    expect(config.lockTimeoutMs).toBe(1000);
  });

  it.each([
    [{}, /DATABASE_URL/],
    [{ DATABASE_URL: URL, FIRE_WATCH_MIGRATIONS_DIR: 'db/migrations' }, /absolute/],
    [{ DATABASE_URL: URL, FIRE_WATCH_DBMATE_BIN: 'bin/dbmate' }, /bare name or absolute/],
    [{ DATABASE_URL: URL, FIRE_WATCH_MIGRATION_LOCK_TIMEOUT_MS: '0' }, /positive integer/],
    [{ DATABASE_URL: URL, FIRE_WATCH_MIGRATION_LOCK_TIMEOUT_MS: '1.5' }, /positive integer/],
  ])('refuses %j', (env, message) => {
    expect(() => loadMigrateConfig(env, '/app/db/migrations')).toThrow(ConfigError);
    expect(() => loadMigrateConfig(env, '/app/db/migrations')).toThrow(message);
  });
});

describe('dbmateArgs', () => {
  it('applies pending files without dumping the schema', () => {
    const config = loadMigrateConfig({ DATABASE_URL: URL }, '/app/db/migrations');
    expect(dbmateArgs(config)).toEqual([
      '--no-dump-schema',
      '--migrations-dir',
      '/app/db/migrations',
      'up',
    ]);
  });
});

describe('describeMigrateConfig', () => {
  it('never names the database URL', () => {
    const config = loadMigrateConfig({ DATABASE_URL: URL }, '/app/db/migrations');
    expect(JSON.stringify(describeMigrateConfig(config))).not.toContain('pw');
  });
});
