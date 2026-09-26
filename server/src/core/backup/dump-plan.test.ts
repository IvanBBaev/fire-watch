import { describe, expect, it } from 'vitest';

import { epochMsFromIso } from '../ports/clock.js';
import {
  isValidSnapshotId,
  MIN_MAIN_ARTIFACT_BYTES,
  MIN_PERSONAL_ARTIFACT_BYTES,
  planBackupRun,
  type ClassifiedRelation,
} from './dump-plan.js';

const SNAPSHOT = '00000003-0000001B-1';
const THURSDAY = epochMsFromIso('2026-09-24T02:20:00Z');
const SUNDAY = epochMsFromIso('2026-09-20T02:20:00Z');

const RELATIONS: ClassifiedRelation[] = [
  { relation: 'detections', backupClass: 'main' },
  { relation: 'accounts', backupClass: 'personal' },
  { relation: 'alert_outbox', backupClass: 'personal' },
  { relation: 'schema_migrations', backupClass: 'main' },
];

describe('isValidSnapshotId', () => {
  it('accepts pg_export_snapshot() output only', () => {
    expect(isValidSnapshotId(SNAPSHOT)).toBe(true);
    expect(isValidSnapshotId('00000003-0000001b-1')).toBe(false);
    expect(isValidSnapshotId('00000003-0000001B')).toBe(false);
    expect(isValidSnapshotId('00000003-0000001B-1; DROP')).toBe(false);
  });
});

describe('planBackupRun', () => {
  it('splits main and personal from one snapshot (§6.2 rules 5 and 8)', () => {
    const plan = planBackupRun({ relations: RELATIONS, snapshotId: SNAPSHOT, takenAtMs: THURSDAY });
    expect(plan.snapshotId).toBe(SNAPSHOT);
    expect(plan.unclassified).toEqual([]);
    expect(plan.artifacts).toHaveLength(2);

    const [main, personal] = plan.artifacts;
    expect(main).toEqual({
      set: 'main',
      keys: [
        {
          set: 'main',
          tier: 'daily',
          takenAtMs: THURSDAY,
          key: 'fw-main/daily/2026/09/24/fire-watch-main-20260924T022000Z.dump.age',
        },
      ],
      pgDumpArgs: [
        '--format=custom',
        '--compress=3',
        '--no-password',
        `--snapshot=${SNAPSHOT}`,
        '--exclude-table-data=public.accounts',
        '--exclude-table-data=public.alert_outbox',
      ],
      tablesWithData: ['detections', 'schema_migrations'],
      minBytes: MIN_MAIN_ARTIFACT_BYTES,
    });
    expect(personal).toMatchObject({
      set: 'personal',
      pgDumpArgs: [
        '--format=custom',
        '--compress=3',
        '--no-password',
        `--snapshot=${SNAPSHOT}`,
        '--data-only',
        '--table=public.accounts',
        '--table=public.alert_outbox',
      ],
      tablesWithData: ['accounts', 'alert_outbox'],
      minBytes: MIN_PERSONAL_ARTIFACT_BYTES,
    });
    expect(personal?.keys.map((k) => k.key)).toEqual([
      'fw-personal/daily/2026/09/24/fire-watch-personal-20260924T022000Z.dump.age',
    ]);
  });

  it('never lets a personal table carry rows in the main artifact', () => {
    const plan = planBackupRun({ relations: RELATIONS, snapshotId: SNAPSHOT, takenAtMs: THURSDAY });
    const main = plan.artifacts.find((a) => a.set === 'main');
    const personal = plan.artifacts.find((a) => a.set === 'personal');
    for (const table of personal?.tablesWithData ?? []) {
      expect(main?.tablesWithData).not.toContain(table);
      expect(main?.pgDumpArgs).toContain(`--exclude-table-data=public.${table}`);
    }
  });

  it('treats an unregistered table as personal and reports it (fail-closed)', () => {
    const plan = planBackupRun({
      relations: [...RELATIONS, { relation: 'new_table', backupClass: null }],
      snapshotId: SNAPSHOT,
      takenAtMs: THURSDAY,
    });
    expect(plan.unclassified).toEqual(['new_table']);
    expect(plan.artifacts[0]?.pgDumpArgs).toContain('--exclude-table-data=public.new_table');
    expect(plan.artifacts[1]?.tablesWithData).toContain('new_table');
  });

  it("keeps dbmate's schema_migrations in main when the registry is silent", () => {
    const plan = planBackupRun({
      relations: [
        { relation: 'detections', backupClass: 'main' },
        { relation: 'schema_migrations', backupClass: null },
      ],
      snapshotId: SNAPSHOT,
      takenAtMs: THURSDAY,
    });
    expect(plan.unclassified).toEqual([]);
    expect(plan.artifacts.map((a) => a.set)).toEqual(['main']);
    expect(plan.artifacts[0]?.tablesWithData).toEqual(['detections', 'schema_migrations']);
    // A registry row still wins over the tooling default.
    const registered = planBackupRun({
      relations: [
        { relation: 'detections', backupClass: 'main' },
        { relation: 'schema_migrations', backupClass: 'personal' },
      ],
      snapshotId: SNAPSHOT,
      takenAtMs: THURSDAY,
    });
    expect(registered.artifacts[1]?.tablesWithData).toEqual(['schema_migrations']);
  });

  it('writes the weekly key for main on Sunday, never for personal', () => {
    const plan = planBackupRun({ relations: RELATIONS, snapshotId: SNAPSHOT, takenAtMs: SUNDAY });
    expect(plan.artifacts[0]?.keys.map((k) => k.tier)).toEqual(['daily', 'weekly']);
    expect(plan.artifacts[1]?.keys.map((k) => k.tier)).toEqual(['daily']);
  });

  it('omits the personal artifact when there are no personal tables', () => {
    const plan = planBackupRun({
      relations: [{ relation: 'detections', backupClass: 'main' }],
      snapshotId: SNAPSHOT,
      takenAtMs: THURSDAY,
    });
    expect(plan.artifacts.map((a) => a.set)).toEqual(['main']);
  });

  it('is independent of relation order', () => {
    const a = planBackupRun({ relations: RELATIONS, snapshotId: SNAPSHOT, takenAtMs: THURSDAY });
    const b = planBackupRun({
      relations: [...RELATIONS].reverse(),
      snapshotId: SNAPSHOT,
      takenAtMs: THURSDAY,
    });
    expect(b).toEqual(a);
  });

  it('refuses bad input rather than dumping something unintended', () => {
    const base = { snapshotId: SNAPSHOT, takenAtMs: THURSDAY };
    expect(() => planBackupRun({ ...base, relations: [] })).toThrow(RangeError);
    expect(() => planBackupRun({ ...base, relations: RELATIONS, snapshotId: 'x' })).toThrow(
      /snapshot/,
    );
    for (const relation of ['Accounts', 'a-b', 'a.b', '*', 'x"; drop', '']) {
      expect(() =>
        planBackupRun({ ...base, relations: [{ relation, backupClass: 'personal' }] }),
      ).toThrow(/plain identifier/);
    }
    expect(() =>
      planBackupRun({
        ...base,
        relations: [
          { relation: 'accounts', backupClass: 'personal' },
          { relation: 'accounts', backupClass: 'main' },
        ],
      }),
    ).toThrow(/twice/);
  });
});
