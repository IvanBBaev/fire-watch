import { describe, expect, it } from 'vitest';

import { epochMsFromIso } from '../core/ports/clock.js';
import { ConfigError } from './config.js';
import {
  DEFAULT_DRILL_DB_ROLE,
  defaultScratchDatabase,
  guardDrillTarget,
  loadErasureDrillEnv,
  parseErasureDrillArgs,
  parseRestoreDrillArgs,
  storeLabel,
} from './drill-config.js';

const NOW = epochMsFromIso('2026-09-25T10:15:00Z');

describe('parseErasureDrillArgs', () => {
  it('requires an environment and reads the flags', () => {
    expect(
      parseErasureDrillArgs([
        '--environment=staging',
        '--audit-backups',
        '--record-dir=/tmp/records',
        '--confirm-not-production',
      ]),
    ).toEqual({
      environment: 'staging',
      auditBackups: true,
      recordDir: '/tmp/records',
      confirmNotProduction: true,
    });
    expect(parseErasureDrillArgs(['--environment=drill-laptop'])).toEqual({
      environment: 'drill-laptop',
      auditBackups: false,
      recordDir: null,
      confirmNotProduction: false,
    });
  });

  it('refuses a missing or malformed environment and unknown flags', () => {
    expect(() => parseErasureDrillArgs([])).toThrow(ConfigError);
    expect(() => parseErasureDrillArgs(['--environment=Staging EU'])).toThrow(/--environment/);
    expect(() => parseErasureDrillArgs(['--environment=staging', '--main-only'])).toThrow(
      /unknown argument/,
    );
    expect(() => parseErasureDrillArgs(['--environment=staging', '--record-dir='])).toThrow(
      /--record-dir/,
    );
  });
});

describe('parseRestoreDrillArgs', () => {
  it('defaults to a timestamped scratch database and a full drill', () => {
    expect(parseRestoreDrillArgs(['--environment=staging'], NOW)).toEqual({
      environment: 'staging',
      recordDir: null,
      confirmNotProduction: false,
      database: 'fw_restore_drill_202609251015',
      mainOnly: false,
      restoreOnly: false,
      key: null,
      manualMinutes: {},
    });
  });

  it('collects manual steps and the restore-only key', () => {
    const args = parseRestoreDrillArgs(
      [
        '--environment=staging',
        '--restore-only',
        '--key=fw-main/daily/x.dump.age',
        '--main-only',
        '--database=fw_scratch_one',
        '--manual-step=provision_vm:18',
        '--manual-step=flip_origin:4.5',
      ],
      NOW,
    );
    expect(args.database).toBe('fw_scratch_one');
    expect(args.key).toBe('fw-main/daily/x.dump.age');
    expect(args.mainOnly).toBe(true);
    expect(args.manualMinutes).toEqual({ provision_vm: 18, flip_origin: 4.5 });
  });

  it('refuses a key without --restore-only, a repeated step and a bad step', () => {
    expect(() => parseRestoreDrillArgs(['--environment=s', '--key=k'], NOW)).toThrow(
      /--restore-only/,
    );
    expect(() =>
      parseRestoreDrillArgs(
        ['--environment=s', '--manual-step=provision_vm:1', '--manual-step=provision_vm:2'],
        NOW,
      ),
    ).toThrow(/twice/);
    expect(() => parseRestoreDrillArgs(['--environment=s', '--manual-step=nope'], NOW)).toThrow(
      ConfigError,
    );
  });

  it('refuses a scratch name that is not one', () => {
    expect(() => parseRestoreDrillArgs(['--environment=s', '--database=fire_watch'], NOW)).toThrow(
      ConfigError,
    );
    expect(() => parseRestoreDrillArgs(['--environment=s', '--database=Bad-Name'], NOW)).toThrow(
      /lower-case/,
    );
  });
});

describe('defaultScratchDatabase', () => {
  it('stamps minutes, UTC', () => {
    expect(defaultScratchDatabase(epochMsFromIso('2026-01-02T03:04:59Z'))).toBe(
      'fw_restore_drill_202601020304',
    );
  });
});

describe('loadErasureDrillEnv', () => {
  it('needs DATABASE_URL and defaults the role', () => {
    expect(() => loadErasureDrillEnv({})).toThrow(/DATABASE_URL/);
    expect(loadErasureDrillEnv({ DATABASE_URL: 'postgres://h/db' })).toEqual({
      databaseUrl: 'postgres://h/db',
      role: DEFAULT_DRILL_DB_ROLE,
    });
    expect(() =>
      loadErasureDrillEnv({ DATABASE_URL: 'postgres://h/db', FIRE_WATCH_DB_ROLE: 'x; drop' }),
    ).toThrow(/FIRE_WATCH_DB_ROLE/);
  });
});

describe('storeLabel', () => {
  it('names the bucket or the directory', () => {
    expect(
      storeLabel({
        kind: 'r2',
        endpoint: 'https://r2',
        bucket: 'fw-staging',
        accessKeyId: 'a',
        secretAccessKey: 's',
      }),
    ).toBe('fw-staging');
    expect(storeLabel({ kind: 'local', directory: '/srv/drill-backups' })).toBe(
      '/srv/drill-backups',
    );
  });
});

describe('guardDrillTarget', () => {
  it('passes a target that names itself non-production', () => {
    const guarded = guardDrillTarget(
      { databaseUrl: 'postgres://u:secret@db.staging.internal/fire_watch' },
      false,
    );
    expect(guarded.override).toBeNull();
    expect(JSON.stringify(guarded.target)).not.toContain('secret');
  });

  it('refuses an unmarked target unless confirmed, and records the override', () => {
    const input = { databaseUrl: 'postgres://u:p@10.0.0.5/fire_watch' };
    expect(() => guardDrillTarget(input, false)).toThrow(/--confirm-not-production/);
    expect(guardDrillTarget(input, true).override).toMatch(/^--confirm-not-production overrode/);
  });

  it('never lets the flag override a production marker', () => {
    expect(() =>
      guardDrillTarget({ databaseUrl: 'postgres://u:p@db.prod.internal/fire_watch' }, true),
    ).toThrow(/refusing a production target/);
    expect(() => guardDrillTarget({ databaseName: 'fire_watch', bucket: 'fw-live' }, true)).toThrow(
      /production/,
    );
  });
});
