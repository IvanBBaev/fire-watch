import { describe, expect, it } from 'vitest';

import {
  DEFAULT_PG_EXEC,
  describeBackupConfig,
  describeRestoreConfig,
  loadBackupConfig,
  loadRestoreConfig,
  parseBackupArgs,
  parseRestoreArgs,
} from './backup-config.js';
import { ConfigError } from './config.js';

const RECIPIENT = `age1${'q'.repeat(58)}`;
const KEY_ID = 'AKIDEXAMPLE0123456789';
const SECRET = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';
const PING = 'https://hc-ping.com/abcdefghijklmnopqrstuv';

const R2 = {
  FIRE_WATCH_BACKUP_R2_ENDPOINT: 'https://acct.eu.r2.cloudflarestorage.com',
  FIRE_WATCH_BACKUP_R2_BUCKET: 'fire-watch-backups',
  FIRE_WATCH_BACKUP_R2_ACCESS_KEY_ID: KEY_ID,
  FIRE_WATCH_BACKUP_R2_SECRET_ACCESS_KEY: SECRET,
};

function thrown(fn: () => unknown): ConfigError {
  try {
    fn();
  } catch (error) {
    if (error instanceof ConfigError) return error;
    throw error;
  }
  throw new Error('expected a ConfigError');
}

describe('loadBackupConfig', () => {
  it('reads the production shape with its defaults', () => {
    const config = loadBackupConfig({ ...R2, BACKUP_AGE_RECIPIENT: RECIPIENT });
    expect(config).toEqual({
      store: {
        kind: 'r2',
        endpoint: 'https://acct.eu.r2.cloudflarestorage.com',
        bucket: 'fire-watch-backups',
        accessKeyId: KEY_ID,
        secretAccessKey: SECRET,
      },
      ageRecipient: RECIPIENT,
      pg: { execPrefix: DEFAULT_PG_EXEC, user: 'postgres' },
      database: 'fire_watch',
      stagingDir: '/var/backups/fire-watch',
      keepLocalMain: 1,
      heartbeatUrl: null,
    });
  });

  it('accepts a local store, host tools, keep=0 and a ping URL', () => {
    const config = loadBackupConfig({
      FIRE_WATCH_BACKUP_LOCAL_DIR: '/mnt/backup',
      BACKUP_AGE_RECIPIENT: RECIPIENT,
      FIRE_WATCH_BACKUP_PG_EXEC: 'none',
      BACKUP_KEEP_LOCAL: '0',
      FIRE_WATCH_HEARTBEAT_URL: `${PING}/`,
    });
    expect(config.store).toEqual({ kind: 'local', directory: '/mnt/backup' });
    expect(config.pg.execPrefix).toEqual([]);
    expect(config.keepLocalMain).toBe(0);
    expect(config.heartbeatUrl).toBe(PING);
  });

  it('refuses a missing, partial or doubled store', () => {
    expect(thrown(() => loadBackupConfig({ BACKUP_AGE_RECIPIENT: RECIPIENT })).message).toMatch(
      /no backup store/,
    );
    const partial = thrown(() =>
      loadBackupConfig({ ...R2, FIRE_WATCH_BACKUP_R2_BUCKET: '', BACKUP_AGE_RECIPIENT: RECIPIENT }),
    );
    expect(partial.message).toMatch(/missing: FIRE_WATCH_BACKUP_R2_BUCKET$/);
    expect(
      thrown(() =>
        loadBackupConfig({
          ...R2,
          FIRE_WATCH_BACKUP_LOCAL_DIR: '/mnt/b',
          BACKUP_AGE_RECIPIENT: RECIPIENT,
        }),
      ).message,
    ).toMatch(/exclusive/);
    expect(
      thrown(() =>
        loadBackupConfig({ FIRE_WATCH_BACKUP_LOCAL_DIR: 'rel', BACKUP_AGE_RECIPIENT: RECIPIENT }),
      ).message,
    ).toMatch(/absolute/);
  });

  it('never echoes a secret in its errors', () => {
    const cases = [
      { ...R2, FIRE_WATCH_BACKUP_R2_SECRET_ACCESS_KEY: 'short!' },
      { ...R2, FIRE_WATCH_BACKUP_R2_SECRET_ACCESS_KEY: KEY_ID },
      { ...R2, FIRE_WATCH_BACKUP_R2_ENDPOINT: 'http://acct.r2.example' },
      { ...R2, FIRE_WATCH_HEARTBEAT_URL: 'https://hc-ping.com' },
    ];
    for (const env of cases) {
      const message = thrown(() =>
        loadBackupConfig({ ...env, BACKUP_AGE_RECIPIENT: RECIPIENT }),
      ).message;
      expect(message).not.toContain(SECRET);
      expect(message).not.toContain(KEY_ID);
      expect(message).not.toContain('short!');
    }
  });

  it('refuses a bad recipient, identifiers, exec words and keep flag', () => {
    const base = { ...R2, BACKUP_AGE_RECIPIENT: RECIPIENT };
    expect(thrown(() => loadBackupConfig(R2)).message).toMatch(/BACKUP_AGE_RECIPIENT/);
    expect(
      thrown(() => loadBackupConfig({ ...base, BACKUP_AGE_RECIPIENT: 'age1bOb' })).message,
    ).toMatch(/not an age/);
    expect(thrown(() => loadBackupConfig({ ...base, PGDATABASE: 'x;y' })).message).toMatch(
      /PGDATABASE/,
    );
    expect(
      thrown(() => loadBackupConfig({ ...base, FIRE_WATCH_BACKUP_PG_EXEC: 'sh -c "x;y"' })).message,
    ).toMatch(/plain words/);
    expect(thrown(() => loadBackupConfig({ ...base, BACKUP_KEEP_LOCAL: '2' })).message).toMatch(
      /0 or 1/,
    );
    expect(
      loadBackupConfig({ ...base, FIRE_WATCH_BACKUP_PG_EXEC: 'docker exec -i fw-db' }).pg
        .execPrefix,
    ).toEqual(['docker', 'exec', '-i', 'fw-db']);
  });

  it('describes itself without credentials or the ping URL', () => {
    const described = JSON.stringify(
      describeBackupConfig(
        loadBackupConfig({
          ...R2,
          BACKUP_AGE_RECIPIENT: RECIPIENT,
          FIRE_WATCH_HEARTBEAT_URL: PING,
        }),
      ),
    );
    expect(described).toContain('acct.eu.r2.cloudflarestorage.com');
    for (const secret of [SECRET, KEY_ID, PING, RECIPIENT]) {
      expect(described).not.toContain(secret);
    }
  });
});

describe('loadRestoreConfig', () => {
  const READ = {
    FIRE_WATCH_RESTORE_R2_ENDPOINT: 'https://acct.eu.r2.cloudflarestorage.com',
    FIRE_WATCH_RESTORE_R2_BUCKET: 'fire-watch-backups',
    FIRE_WATCH_RESTORE_R2_ACCESS_KEY_ID: KEY_ID,
    FIRE_WATCH_RESTORE_R2_SECRET_ACCESS_KEY: SECRET,
  };

  it('uses its own read credential, never the backup one', () => {
    const env = { ...R2, FIRE_WATCH_RESTORE_AGE_IDENTITY: '/root/fw-age.key' };
    expect(thrown(() => loadRestoreConfig(env)).message).toMatch(/FIRE_WATCH_RESTORE_R2_ENDPOINT/);
    const config = loadRestoreConfig({
      ...READ,
      FIRE_WATCH_RESTORE_AGE_IDENTITY: '/root/fw-age.key',
    });
    expect(config.store.kind).toBe('r2');
    expect(config.maintenanceDatabase).toBe('postgres');
    expect(config.workDir).toBe('/var/backups/fire-watch/restore');
  });

  it('requires an absolute identity path and keeps it out of the description', () => {
    expect(thrown(() => loadRestoreConfig(READ)).message).toMatch(/AGE_IDENTITY/);
    expect(
      thrown(() => loadRestoreConfig({ ...READ, FIRE_WATCH_RESTORE_AGE_IDENTITY: 'key.txt' }))
        .message,
    ).toMatch(/absolute/);
    const described = JSON.stringify(
      describeRestoreConfig(
        loadRestoreConfig({
          FIRE_WATCH_RESTORE_LOCAL_DIR: '/mnt/backup',
          FIRE_WATCH_RESTORE_AGE_IDENTITY: '/root/fw-age.key',
        }),
      ),
    );
    expect(described).not.toContain('fw-age.key');
    expect(described).toContain('/mnt/backup');
  });
});

describe('argument parsing', () => {
  it('backup takes only --dry-run', () => {
    expect(parseBackupArgs([])).toEqual({ dryRun: false });
    expect(parseBackupArgs(['--dry-run'])).toEqual({ dryRun: true });
    expect(() => parseBackupArgs(['--force'])).toThrow(ConfigError);
  });

  it('restore needs a database and takes a key and --main-only', () => {
    expect(parseRestoreArgs(['--database=fw_restore_drill'])).toEqual({
      database: 'fw_restore_drill',
      mainKey: null,
      mainOnly: false,
    });
    expect(
      parseRestoreArgs(['--database=fw_x', '--key=fw-main/daily/a.dump.age', '--main-only']),
    ).toEqual({ database: 'fw_x', mainKey: 'fw-main/daily/a.dump.age', mainOnly: true });
    expect(() => parseRestoreArgs([])).toThrow(/--database is required/);
    expect(() => parseRestoreArgs(['--database=fw_x', '--key='])).toThrow(ConfigError);
    expect(() => parseRestoreArgs(['--db=fw_x'])).toThrow(ConfigError);
  });
});
