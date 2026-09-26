import { describe, expect, it } from 'vitest';

import { backupObjectKey } from '../backup/backup-keys.js';
import type { BackupRunSummary } from '../backup/backup-run.js';
import type { RestoreTarget } from '../backup/ports.js';
import type { RestoreRunSummary } from '../backup/restore-run.js';
import type { RelationRowCount } from '../backup/restore-verify.js';
import { epochMsFromIso, VirtualClock } from '../ports/clock.js';
import { drillVerdict } from './drill-record.js';
import {
  captureRowCounts,
  dailyMainKey,
  runRestoreDrill,
  type RestoreDrillDeps,
  type RestoreDrillOptions,
} from './restore-drill.js';

const TAKEN_MS = epochMsFromIso('2026-09-25T10:00:00Z');
const MAIN = backupObjectKey('main', 'daily', TAKEN_MS).key;
const PERSONAL = backupObjectKey('personal', 'daily', TAKEN_MS).key;

const COUNTS: RelationRowCount[] = [
  { relation: 'fire_events', backupClass: 'main', rows: 50 },
  { relation: 'accounts', backupClass: 'personal', rows: 2 },
];

function backupSummary(overrides: Partial<BackupRunSummary> = {}): BackupRunSummary {
  return {
    mode: 'backup',
    takenAt: '2026-09-25T10:00:00.000Z',
    plan: { takenAtMs: TAKEN_MS, snapshotId: 's', artifacts: [], unclassified: [] },
    uploaded: [
      { set: 'main', keys: [MAIN], bytes: 1000, sha256: 'a' },
      { set: 'personal', keys: [PERSONAL], bytes: 300, sha256: 'b' },
    ],
    tableGauges: {
      gauges: [
        { relation: 'fire_events', rows: 50, bytes: 1, set: 'main' },
        { relation: 'accounts', rows: 2, bytes: 1, set: 'personal' },
      ],
      unplanned: [],
    },
    shrinkage: null,
    ...overrides,
  };
}

function restoreSummary(overrides: Partial<RestoreRunSummary> = {}): RestoreRunSummary {
  return {
    ok: true,
    database: 'fw_restore_drill',
    mainKey: MAIN,
    takenAt: '2026-09-25T10:00:00.000Z',
    artifactAgeDays: 0,
    companion: { key: PERSONAL, status: 'restored' },
    migrations: {
      ok: true,
      applied: ['001', '014'],
      local: ['001', '014'],
      missing: [],
      unknown: [],
      latestApplied: '014',
    },
    personalRows: { ok: true, personalRestored: true, leaked: [], personalRows: 2, mainRows: 50 },
    retention: {
      listed: 2,
      expireCount: 0,
      pastErasureHorizonCount: 0,
      unrecognizedCount: 0,
      oldestPersonalAgeDays: 0,
    },
    findings: [],
    ...overrides,
  };
}

const ALL_MANUAL = {
  provision_vm: 30,
  deploy_stack: 20,
  restore_secrets: 10,
  promote_and_boot: 15,
  flip_origin: 5,
};

function options(overrides: Partial<RestoreDrillOptions> = {}): RestoreDrillOptions {
  return {
    environment: 'staging',
    target: { pg_database: 'fire_watch_staging' },
    database: 'fw_restore_drill',
    mainOnly: false,
    requestedKey: null,
    manualMinutes: ALL_MANUAL,
    targetOverride: null,
    ...overrides,
  };
}

function deps(
  clock: VirtualClock,
  overrides: Partial<RestoreDrillDeps> = {},
  summary: RestoreRunSummary = restoreSummary(),
): RestoreDrillDeps & { readonly restored: (string | null)[] } {
  const restored: (string | null)[] = [];
  return {
    clock,
    backup: () => {
      clock.advanceMinutes(4);
      return Promise.resolve(backupSummary());
    },
    restore: (key) => {
      restored.push(key);
      clock.advanceMinutes(12);
      return Promise.resolve({ summary, restoredCounts: COUNTS });
    },
    restored,
    ...overrides,
  };
}

describe('runRestoreDrill', () => {
  it('passes a full drill: backup, restore of that artifact, gauges equal, RTO met', async () => {
    const clock = new VirtualClock('2026-09-25T10:00:00Z');
    const d = deps(clock);
    const record = await runRestoreDrill(options(), d);
    expect(d.restored).toEqual([MAIN]);
    expect(record.checks.filter((c) => c.status !== 'pass')).toEqual([]);
    expect(record.steps.map((s) => s.id)).toEqual([
      'take_backup',
      'provision_vm',
      'deploy_stack',
      'restore_secrets',
      'restore_database',
      'promote_and_boot',
      'flip_origin',
    ]);
    // 30 + 20 + 10 + 12 (measured) + 15 + 5; the backup is not on the path.
    expect(record.rto).toMatchObject({ status: 'met', measuredMinutes: 92 });
    expect(drillVerdict(record)).toBe('passed');
    expect(record.finishedAt).toBe('2026-09-25T10:16:00Z');
    expect(record.facts['restored_main_key']).toBe(MAIN);
  });

  it('is incomplete when the operator reported no manual steps', async () => {
    const record = await runRestoreDrill(
      options({ manualMinutes: {} }),
      deps(new VirtualClock(TAKEN_MS)),
    );
    expect(record.rto?.status).toBe('incomplete');
    expect(record.rto?.missing).toHaveLength(5);
    expect(drillVerdict(record)).toBe('incomplete');
  });

  it('fails when a restored table differs from its dump-time gauge', async () => {
    const clock = new VirtualClock(TAKEN_MS);
    const record = await runRestoreDrill(
      options(),
      deps(clock, {
        restore: () =>
          Promise.resolve({
            summary: restoreSummary(),
            restoredCounts: [
              { relation: 'fire_events', backupClass: 'main', rows: 49 },
              COUNTS[1]!,
            ],
          }),
      }),
    );
    const rows = record.checks.find((c) => c.id === 'row_counts_match_gauges');
    expect(rows?.status).toBe('fail');
    expect(rows?.detail).toContain('fire_events: expected 50, restored 49');
    expect(drillVerdict(record)).toBe('failed');
  });

  it('on --main-only expects the companion skipped and personal tables empty', async () => {
    const summary = restoreSummary({
      companion: { key: PERSONAL, status: 'skipped' },
      personalRows: {
        ok: true,
        personalRestored: false,
        leaked: [],
        personalRows: 0,
        mainRows: 50,
      },
    });
    const record = await runRestoreDrill(
      options({ mainOnly: true }),
      deps(
        new VirtualClock(TAKEN_MS),
        {
          restore: () =>
            Promise.resolve({
              summary,
              restoredCounts: [
                COUNTS[0]!,
                { relation: 'accounts', backupClass: 'personal', rows: 0 },
              ],
            }),
        },
        summary,
      ),
    );
    expect(record.checks.filter((c) => c.status !== 'pass')).toEqual([]);
  });

  it('fails the companion check when the drill backup restored without it', async () => {
    const summary = restoreSummary({ companion: { key: PERSONAL, status: 'absent' } });
    const record = await runRestoreDrill(options(), deps(new VirtualClock(TAKEN_MS), {}, summary));
    expect(record.checks.find((c) => c.id === 'companion')?.status).toBe('fail');
  });

  it('restore-only: skips the backup, passes --key through, gauges not_run, expired companion accepted', async () => {
    const summary = restoreSummary({ companion: { key: PERSONAL, status: 'expired' } });
    const d = deps(new VirtualClock(TAKEN_MS), { backup: null }, summary);
    const record = await runRestoreDrill(options({ requestedKey: MAIN }), d);
    expect(d.restored).toEqual([MAIN]);
    expect(record.steps[0]).toMatchObject({ id: 'take_backup', status: 'skipped' });
    const status = Object.fromEntries(record.checks.map((c) => [c.id, c.status]));
    expect(status).toMatchObject({
      backup_uploaded: 'not_run',
      restored_drill_artifact: 'not_run',
      companion: 'pass',
      row_counts_match_gauges: 'not_run',
    });
    expect(drillVerdict(record)).toBe('incomplete');
  });

  it('records a failed backup, skips the restore and still returns a record', async () => {
    const record = await runRestoreDrill(
      options(),
      deps(new VirtualClock(TAKEN_MS), {
        backup: () => Promise.reject(new Error('pg_dump exited 1')),
      }),
    );
    expect(record.steps.find((s) => s.id === 'take_backup')?.status).toBe('failed');
    expect(record.steps.find((s) => s.id === 'restore_database')?.status).toBe('skipped');
    expect(record.findings).toContain('backup failed: pg_dump exited 1');
    expect(drillVerdict(record)).toBe('failed');
  });

  it('records a failed restore as a failed RTO', async () => {
    const record = await runRestoreDrill(
      options(),
      deps(new VirtualClock(TAKEN_MS), {
        restore: () => Promise.reject(new Error('sha256 mismatch')),
      }),
    );
    expect(record.rto?.status).toBe('failed');
    expect(record.findings).toContain('restore failed: sha256 mismatch');
    expect(record.checks.find((c) => c.id === 'restore_verified')?.status).toBe('not_run');
  });

  it('flags a restore that picked another artifact, and registry gaps from the backup', async () => {
    const other = backupObjectKey('main', 'daily', TAKEN_MS - 86_400_000).key;
    const record = await runRestoreDrill(
      options(),
      deps(
        new VirtualClock(TAKEN_MS),
        {
          backup: () =>
            Promise.resolve(
              backupSummary({
                plan: {
                  takenAtMs: TAKEN_MS,
                  snapshotId: 's',
                  artifacts: [],
                  unclassified: ['new_table'],
                },
              }),
            ),
        },
        restoreSummary({ mainKey: other }),
      ),
    );
    expect(record.checks.find((c) => c.id === 'restored_drill_artifact')?.status).toBe('fail');
    expect(record.findings.join(' ')).toContain('new_table');
  });

  it('fails the retention leg on a personal artifact past the horizon', async () => {
    const summary = restoreSummary({
      retention: {
        listed: 3,
        expireCount: 1,
        pastErasureHorizonCount: 1,
        unrecognizedCount: 0,
        oldestPersonalAgeDays: 31,
      },
    });
    const record = await runRestoreDrill(options(), deps(new VirtualClock(TAKEN_MS), {}, summary));
    expect(record.checks.find((c) => c.id === 'retention_leg')?.status).toBe('fail');
  });
});

describe('dailyMainKey', () => {
  it('picks the daily main key, not the weekly or the personal one', () => {
    const weekly = backupObjectKey('main', 'weekly', TAKEN_MS).key;
    const summary = backupSummary({
      uploaded: [
        { set: 'personal', keys: [PERSONAL], bytes: 1, sha256: 'x' },
        { set: 'main', keys: [weekly, MAIN], bytes: 1, sha256: 'y' },
      ],
    });
    expect(dailyMainKey(summary)).toBe(MAIN);
    expect(dailyMainKey(backupSummary({ uploaded: [] }))).toBeNull();
  });
});

describe('captureRowCounts', () => {
  it('passes every call through and keeps the counts the restore read', async () => {
    const calls: string[] = [];
    const target: RestoreTarget = {
      createDatabase: (name) => {
        calls.push(`create ${name}`);
        return Promise.resolve();
      },
      restore: () => {
        calls.push('restore');
        return Promise.resolve();
      },
      appliedMigrations: () => Promise.resolve(['001']),
      rowCounts: () => Promise.resolve(COUNTS),
    };
    const captured = captureRowCounts(target);
    expect(captured.counts()).toBeNull();
    await captured.target.createDatabase('fw_restore_drill');
    expect(await captured.target.appliedMigrations('fw_restore_drill')).toEqual(['001']);
    await captured.target.rowCounts('fw_restore_drill');
    expect(calls).toEqual(['create fw_restore_drill']);
    expect(captured.counts()).toEqual(COUNTS);
  });
});
