import { describe, expect, it } from 'vitest';

import { VirtualClock } from '../ports/clock.js';
import { DRY_RUN_SNAPSHOT_ID, runBackup, type BackupRunDeps } from './backup-run.js';
import type { ClassifiedRelation } from './dump-plan.js';
import type { StagedArtifact, TableGaugeLedger } from './ports.js';
import { BACKUP_RETENTION } from './retention.js';
import type { TableGaugeSnapshot, TableStat } from './table-gauges.js';

const SNAPSHOT = '00000003-0000001B-1';
const RELATIONS: ClassifiedRelation[] = [
  { relation: 'detections', backupClass: 'main' },
  { relation: 'accounts', backupClass: 'personal' },
];

interface Harness {
  readonly deps: BackupRunDeps;
  readonly events: string[];
  readonly lines: string[];
}

function harness(
  options: {
    readonly start?: string;
    readonly bytes?: Partial<Record<string, number>>;
    readonly failUploadOf?: string;
    readonly failDumpOf?: string;
    readonly stats?: readonly TableStat[] | Error;
    readonly ledger?: TableGaugeLedger;
  } = {},
): Harness {
  const events: string[] = [];
  const lines: string[] = [];
  const clock = new VirtualClock(options.start ?? '2026-09-24T02:20:00.640Z');
  const deps: BackupRunDeps = {
    clock,
    writeLine: (line) => lines.push(line),
    database: {
      classifiedRelations: () => {
        events.push('relations');
        return Promise.resolve(RELATIONS);
      },
      appliedMigrations: () => Promise.resolve(['002', '001', '011']),
      tableStats: (snapshotId) => {
        events.push('stats');
        expect(snapshotId).toBe(SNAPSHOT);
        if (options.stats instanceof Error) return Promise.reject(options.stats);
        return Promise.resolve(
          options.stats ?? [
            { relation: 'accounts', rows: 2, bytes: 16_384 },
            { relation: 'detections', rows: 1500, bytes: 2_000_000 },
          ],
        );
      },
      exportSnapshot: () => {
        events.push('snapshot');
        return Promise.resolve({
          snapshotId: SNAPSHOT,
          release: () => {
            events.push('release');
            return Promise.resolve();
          },
        });
      },
    },
    producer: {
      dumpEncrypted: ({ fileName, pgDumpArgs }) => {
        events.push(`dump ${fileName}`);
        if (options.failDumpOf !== undefined && fileName.includes(options.failDumpOf)) {
          return Promise.reject(new Error('pg_dump exited 1'));
        }
        expect(pgDumpArgs).toContain(`--snapshot=${SNAPSHOT}`);
        const set = fileName.includes('-main-') ? 'main' : 'personal';
        const artifact: StagedArtifact = {
          path: `/staging/${fileName}`,
          bytes: options.bytes?.[set] ?? 10_000,
          sha256: set === 'main' ? 'a'.repeat(64) : 'b'.repeat(64),
        };
        return Promise.resolve(artifact);
      },
      pruneStaging: (keep) => {
        events.push(`prune [${keep.join(',')}]`);
        return Promise.resolve();
      },
    },
    writer: {
      upload: (key, artifact, metadata) => {
        events.push(`upload ${key}`);
        if (options.failUploadOf !== undefined && key.includes(options.failUploadOf)) {
          return Promise.reject(new Error('R2 PUT failed: 503'));
        }
        expect(metadata).toEqual({
          'backup-set': key.startsWith('fw-main/') ? 'main' : 'personal',
          'taken-at': expect.stringMatching(/^2026-09-2[04]T02:20:00Z$/) as unknown,
          sha256: artifact.sha256,
          'migration-version': '011',
          format: 'pg-dump-custom+age',
        });
        return Promise.resolve({ etag: '"e"' });
      },
    },
    ...(options.ledger === undefined ? {} : { gaugeLedger: options.ledger }),
    pinger: {
      succeeded: () => {
        events.push('ping ok');
        return Promise.resolve();
      },
      failed: () => {
        events.push('ping fail');
        return Promise.resolve();
      },
    },
  };
  return { deps, events, lines };
}

describe('runBackup', () => {
  it('dumps both sets from one snapshot, releases it before uploading, pings last', async () => {
    const h = harness();
    const summary = await runBackup({ dryRun: false, keepLocalMain: 1 }, h.deps);

    expect(h.events).toEqual([
      'relations',
      'snapshot',
      'stats',
      'dump fire-watch-main-20260924T022000Z.dump.age',
      'dump fire-watch-personal-20260924T022000Z.dump.age',
      'release',
      'upload fw-main/daily/2026/09/24/fire-watch-main-20260924T022000Z.dump.age',
      'upload fw-personal/daily/2026/09/24/fire-watch-personal-20260924T022000Z.dump.age',
      'prune [/staging/fire-watch-main-20260924T022000Z.dump.age]',
      'ping ok',
    ]);
    expect(summary.mode).toBe('backup');
    expect(summary.takenAt).toBe('2026-09-24T02:20:00Z');
    expect(summary.uploaded.map((u) => u.set)).toEqual(['main', 'personal']);
    const last = JSON.parse(h.lines.at(-1) ?? '{}') as unknown;
    expect(last).toEqual({ backup: { done: { taken_at: '2026-09-24T02:20:00Z', artifacts: 2 } } });
  });

  it('never keeps the personal artifact locally, and keeps nothing with keepLocalMain 0', async () => {
    const h = harness();
    await runBackup({ dryRun: false, keepLocalMain: 0 }, h.deps);
    expect(h.events).toContain('prune []');
  });

  it('uploads a Sunday main artifact twice (daily + weekly)', async () => {
    const h = harness({ start: '2026-09-20T02:20:00Z' });
    const summary = await runBackup({ dryRun: false, keepLocalMain: 0 }, h.deps);
    expect(summary.uploaded[0]?.keys).toEqual([
      'fw-main/daily/2026/09/20/fire-watch-main-20260920T022000Z.dump.age',
      'fw-main/weekly/2026/09/20/fire-watch-main-20260920T022000Z.dump.age',
    ]);
    expect(summary.uploaded[1]?.keys).toHaveLength(1);
  });

  it('dry run plans without snapshot, dump, upload or ping', async () => {
    const h = harness();
    const summary = await runBackup({ dryRun: true, keepLocalMain: 1 }, h.deps);
    expect(summary.mode).toBe('dry_run');
    expect(summary.plan.snapshotId).toBe(DRY_RUN_SNAPSHOT_ID);
    expect(summary.uploaded).toEqual([]);
    expect(h.events).toEqual(['relations']);
    expect(h.lines).toHaveLength(1);
    expect(h.lines[0]).toContain('"plan"');
  });

  it('refuses an undersized dump, releases the snapshot, prunes personal and pings /fail', async () => {
    const h = harness({ bytes: { personal: 100 } });
    await expect(runBackup({ dryRun: false, keepLocalMain: 1 }, h.deps)).rejects.toThrow(
      /under the 512-byte floor/,
    );
    expect(h.events.slice(-3)).toEqual([
      'release',
      'prune [/staging/fire-watch-main-20260924T022000Z.dump.age]',
      'ping fail',
    ]);
    expect(h.events.some((e) => e.startsWith('upload'))).toBe(false);
    expect(h.events).not.toContain('ping ok');
  });

  it('pings /fail when an upload fails, never ok', async () => {
    const h = harness({ failUploadOf: 'fw-personal/' });
    await expect(runBackup({ dryRun: false, keepLocalMain: 1 }, h.deps)).rejects.toThrow(/503/);
    expect(h.events).toContain('ping fail');
    expect(h.events).not.toContain('ping ok');
  });

  it('releases the snapshot when a dump fails', async () => {
    const h = harness({ failDumpOf: '-main-' });
    await expect(runBackup({ dryRun: false, keepLocalMain: 1 }, h.deps)).rejects.toThrow(/pg_dump/);
    expect(h.events).toEqual([
      'relations',
      'snapshot',
      'stats',
      'dump fire-watch-main-20260924T022000Z.dump.age',
      'release',
      'prune []',
      'ping fail',
    ]);
  });

  it('refuses a policy that breaks the erasure horizon before touching the database', async () => {
    const h = harness();
    const policy = {
      ...BACKUP_RETENTION,
      sets: {
        ...BACKUP_RETENTION.sets,
        personal: { dailyDays: 35, weeklyDays: null, monthlyDays: null },
      },
    };
    await expect(runBackup({ dryRun: false, keepLocalMain: 1, policy }, h.deps)).rejects.toThrow(
      /retention policy refused/,
    );
    expect(h.events).toEqual(['prune []', 'ping fail']);
  });

  it('does not ping on a failed dry run', async () => {
    const h = harness();
    const deps: BackupRunDeps = {
      ...h.deps,
      database: { ...h.deps.database, classifiedRelations: () => Promise.resolve([]) },
    };
    await expect(runBackup({ dryRun: true, keepLocalMain: 1 }, deps)).rejects.toThrow(
      /no relations/,
    );
    expect(h.events).toEqual([]);
  });
});

function memoryLedger(
  events: string[],
  initial: TableGaugeSnapshot | null,
  failures: { read?: boolean; write?: boolean } = {},
): TableGaugeLedger & { stored: TableGaugeSnapshot | null } {
  const ledger = {
    stored: initial,
    read: () => {
      events.push('ledger read');
      return failures.read === true
        ? Promise.reject(new Error('EACCES'))
        : Promise.resolve(ledger.stored);
    },
    write: (snapshot: TableGaugeSnapshot) => {
      events.push('ledger write');
      if (failures.write === true) return Promise.reject(new Error('ENOSPC'));
      ledger.stored = snapshot;
      return Promise.resolve();
    },
  };
  return ledger;
}

function recordOf(lines: readonly string[], name: string): unknown {
  const line = lines.find((l) => l.startsWith(`{"backup":{"${name}"`));
  return line === undefined ? undefined : (JSON.parse(line) as { backup: unknown }).backup;
}

describe('runBackup table gauges', () => {
  it('reads the gauges inside the snapshot and emits them labelled by set', async () => {
    const h = harness();
    const summary = await runBackup({ dryRun: false, keepLocalMain: 1 }, h.deps);
    expect(summary.tableGauges).toEqual({
      gauges: [
        { relation: 'accounts', set: 'personal', rows: 2, bytes: 16_384 },
        { relation: 'detections', set: 'main', rows: 1500, bytes: 2_000_000 },
      ],
      unplanned: [],
    });
    expect(summary.shrinkage).toBeNull();
    expect(recordOf(h.lines, 'table_gauges')).toEqual({
      table_gauges: {
        gauges: [
          { bytes: 16_384, relation: 'accounts', rows: 2, set: 'personal' },
          { bytes: 2_000_000, relation: 'detections', rows: 1500, set: 'main' },
        ],
        unplanned: [],
      },
    });
    expect(h.events.indexOf('stats')).toBeLessThan(h.events.indexOf('release'));
  });

  it('compares with the previous night, and records tonight only after the uploads', async () => {
    const events: string[] = [];
    const ledger = memoryLedger(events, {
      takenAt: '2026-09-23T02:20:00Z',
      gauges: [
        { relation: 'detections', set: 'main', rows: 2000, bytes: 2_100_000 },
        { relation: 'accounts', set: 'personal', rows: 2, bytes: 16_384 },
        { relation: 'retired_table', set: 'main', rows: 5, bytes: 8192 },
      ],
    });
    const h = harness({ ledger });
    const summary = await runBackup({ dryRun: false, keepLocalMain: 1 }, h.deps);

    expect(summary.shrinkage).toEqual({
      previousTakenAt: '2026-09-23T02:20:00Z',
      shrunk: [{ relation: 'detections', set: 'main', previousRows: 2000, rows: 1500 }],
      vanished: ['retired_table'],
    });
    expect(recordOf(h.lines, 'table_shrinkage')).toEqual({
      table_shrinkage: {
        previous_taken_at: '2026-09-23T02:20:00Z',
        shrunk: [{ previous_rows: 2000, relation: 'detections', rows: 1500, set: 'main' }],
        vanished: ['retired_table'],
      },
    });
    expect(events).toEqual(['ledger read', 'ledger write']);
    expect(h.events.at(-1)).toBe('ping ok');
    expect(ledger.stored).toEqual({
      takenAt: '2026-09-24T02:20:00Z',
      gauges: summary.tableGauges?.gauges,
    });
  });

  it('keeps backing up when the gauges cannot be read, and records no baseline', async () => {
    const events: string[] = [];
    const ledger = memoryLedger(events, null);
    const h = harness({ stats: new Error('statement timeout'), ledger });
    const summary = await runBackup({ dryRun: false, keepLocalMain: 1 }, h.deps);

    expect(summary.uploaded.map((u) => u.set)).toEqual(['main', 'personal']);
    expect(summary.tableGauges).toBeNull();
    expect(recordOf(h.lines, 'table_gauges')).toEqual({
      table_gauges: { error: 'statement timeout' },
    });
    expect(events).toEqual([]);
    expect(h.events).toContain('ping ok');
  });

  it('treats a malformed stat as unreadable gauges, not as a failed backup', async () => {
    const h = harness({ stats: [{ relation: 'accounts', rows: -1, bytes: 0 }] });
    const summary = await runBackup({ dryRun: false, keepLocalMain: 1 }, h.deps);
    expect(summary.tableGauges).toBeNull();
    expect(h.events).toContain('ping ok');
  });

  it('never fails the run over the ledger', async () => {
    const events: string[] = [];
    const h = harness({ ledger: memoryLedger(events, null, { read: true, write: true }) });
    const summary = await runBackup({ dryRun: false, keepLocalMain: 1 }, h.deps);
    expect(summary.shrinkage).toBeNull();
    expect(events).toEqual(['ledger read', 'ledger write']);
    const ledgerLines = h.lines.filter((l) => l.includes('table_gauges_ledger'));
    expect(ledgerLines).toHaveLength(2);
    expect(ledgerLines[1]).toContain('ENOSPC');
    expect(h.events.at(-1)).toBe('ping ok');
  });

  it('does not record a baseline from a failed night', async () => {
    const events: string[] = [];
    const h = harness({
      failUploadOf: 'fw-personal/',
      ledger: memoryLedger(events, null),
    });
    await expect(runBackup({ dryRun: false, keepLocalMain: 1 }, h.deps)).rejects.toThrow(/503/);
    expect(events).toEqual(['ledger read']);
  });

  it('reads no gauges on a dry run', async () => {
    const events: string[] = [];
    const h = harness({ ledger: memoryLedger(events, null) });
    const summary = await runBackup({ dryRun: true, keepLocalMain: 1 }, h.deps);
    expect(summary.tableGauges).toBeNull();
    expect(h.events).not.toContain('stats');
    expect(events).toEqual([]);
  });
});
