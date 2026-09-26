import { describe, expect, it } from 'vitest';

import { epochMsFromIso, VirtualClock } from '../ports/clock.js';
import { backupObjectKey } from './backup-keys.js';
import type { FetchedArtifact, RestoreTarget } from './ports.js';
import type { RelationRowCount } from './restore-verify.js';
import {
  runRestore,
  selectMain,
  type RestoreRunDeps,
  type RestoreRunOptions,
} from './restore-run.js';

const DAY = 86_400_000;
const NOW = '2026-09-24T09:00:00Z';
const NOW_MS = epochMsFromIso(NOW);
const MIGRATIONS = ['001_initial.sql', '002_more.sql'];

function nightKeys(daysAgo: number, tiers: readonly ('daily' | 'weekly')[] = ['daily']) {
  const at = epochMsFromIso('2026-09-24T02:20:00Z') - daysAgo * DAY;
  return {
    main: tiers.map((t) => backupObjectKey('main', t, at).key),
    personal: backupObjectKey('personal', 'daily', at).key,
  };
}

interface Harness {
  readonly deps: RestoreRunDeps;
  readonly events: string[];
  readonly lines: string[];
  readonly discarded: string[];
}

function harness(options: {
  readonly objects: readonly string[];
  readonly corrupt?: string;
  readonly unrecorded?: string;
  readonly rows?: readonly RelationRowCount[];
  readonly applied?: readonly string[];
  readonly failRestore?: boolean;
}): Harness {
  const events: string[] = [];
  const lines: string[] = [];
  const discarded: string[] = [];
  const target: RestoreTarget = {
    createDatabase: (name) => {
      events.push(`create ${name}`);
      return Promise.resolve();
    },
    restore: ({ artifactPath, pgRestoreArgs }) => {
      events.push(`restore ${artifactPath} ${pgRestoreArgs.join(' ')}`);
      return options.failRestore === true
        ? Promise.reject(new Error('pg_restore exited 1'))
        : Promise.resolve();
    },
    appliedMigrations: () => Promise.resolve(options.applied ?? ['001', '002']),
    rowCounts: () =>
      Promise.resolve(
        options.rows ?? [
          { relation: 'detections', backupClass: 'main', rows: 5 },
          { relation: 'accounts', backupClass: 'personal', rows: 0 },
          { relation: 'schema_migrations', backupClass: null, rows: 2 },
        ],
      ),
  };
  const deps: RestoreRunDeps = {
    clock: new VirtualClock(NOW),
    writeLine: (line) => lines.push(line),
    target,
    workspace: {
      pathFor: (fileName) => `/work/${fileName}`,
      discard: (path) => {
        discarded.push(path);
        return Promise.resolve();
      },
    },
    reader: {
      list: (prefix) =>
        Promise.resolve(
          options.objects
            .filter((k) => k.startsWith(prefix))
            .map((key) => ({ key, lastModifiedMs: null, sizeBytes: 1000 })),
        ),
      download: (key, path): Promise<FetchedArtifact | null> => {
        events.push(`download ${key}`);
        if (!options.objects.includes(key)) return Promise.resolve(null);
        return Promise.resolve({
          key,
          path,
          bytes: 1000,
          sha256: key === options.corrupt ? 'f'.repeat(64) : 'a'.repeat(64),
          recordedSha256: key === options.unrecorded ? null : 'a'.repeat(64),
        });
      },
    },
  };
  return { deps, events, lines, discarded };
}

const BASE: RestoreRunOptions = {
  database: 'fw_restore_drill',
  mainKey: null,
  mainOnly: false,
  localMigrationFiles: MIGRATIONS,
};

describe('selectMain', () => {
  it('picks the newest main artifact, preferring daily on a tie', () => {
    const sunday = nightKeys(4, ['weekly', 'daily']);
    const older = nightKeys(5);
    const picked = selectMain(null, [...older.main, ...sunday.main, sunday.personal]);
    expect(picked.key).toBe(sunday.main[1]);
    expect(picked.tier).toBe('daily');
  });

  it('honours a requested key and refuses a personal or foreign one', () => {
    const n = nightKeys(2);
    expect(selectMain(n.main[0] ?? '', []).key).toBe(n.main[0]);
    expect(() => selectMain(n.personal, [])).toThrow(/not a main-set/);
    expect(() => selectMain('fw-main/readme', [])).toThrow(/not a main-set/);
    expect(() => selectMain(null, [n.personal])).toThrow(/no main-set/);
  });
});

describe('runRestore', () => {
  it('restores main then its personal companion, verifies, discards downloads', async () => {
    const n = nightKeys(0);
    const h = harness({
      objects: [...n.main, n.personal],
      rows: [
        { relation: 'detections', backupClass: 'main', rows: 5 },
        { relation: 'accounts', backupClass: 'personal', rows: 3 },
      ],
    });
    const summary = await runRestore(BASE, h.deps);

    expect(summary.ok).toBe(true);
    expect(summary.companion.status).toBe('restored');
    expect(summary.companion.key).toBe(n.personal);
    expect(h.events).toEqual([
      `download ${n.main[0] ?? ''}`,
      `download ${n.personal}`,
      'create fw_restore_drill',
      'restore /work/fire-watch-main-20260924T022000Z.dump.age --exit-on-error --single-transaction',
      'restore /work/fire-watch-personal-20260924T022000Z.dump.age --exit-on-error --single-transaction --data-only',
    ]);
    expect(h.discarded).toEqual([
      '/work/fire-watch-main-20260924T022000Z.dump.age',
      '/work/fire-watch-personal-20260924T022000Z.dump.age',
    ]);
    const verdict = JSON.parse(h.lines.at(-1) ?? '{}') as { restore: { verdict: { ok: boolean } } };
    expect(verdict.restore.verdict.ok).toBe(true);
  });

  it('main-only leaves personal tables empty and counts schema_migrations as main (rule 8)', async () => {
    const n = nightKeys(0);
    const h = harness({ objects: [...n.main, n.personal] });
    const summary = await runRestore({ ...BASE, mainOnly: true }, h.deps);
    expect(summary.ok).toBe(true);
    expect(summary.companion.status).toBe('skipped');
    expect(summary.personalRows.leaked).toEqual([]);
    expect(summary.personalRows.mainRows).toBe(7);
    expect(h.events.some((e) => e.includes('personal'))).toBe(false);
  });

  it('never restores a companion at or past the personal retention (erasure-aware)', async () => {
    const n = nightKeys(28, ['weekly']);
    const h = harness({ objects: [...n.main, n.personal] });
    const summary = await runRestore({ ...BASE, mainKey: n.main[0] ?? '' }, h.deps);
    expect(summary.artifactAgeDays).toBe(28);
    expect(summary.companion.status).toBe('expired');
    expect(h.events.some((e) => e.includes(n.personal))).toBe(false);
    // The bucket still holding it past its lifecycle is reported, not restored.
    expect(summary.retention.expireCount).toBeGreaterThan(0);
  });

  it('reports an absent companion and restores main alone', async () => {
    const n = nightKeys(3);
    const h = harness({ objects: n.main });
    const summary = await runRestore(BASE, h.deps);
    expect(summary.ok).toBe(true);
    expect(summary.companion.status).toBe('absent');
  });

  it('fails the verdict when personal rows appear without their companion', async () => {
    const n = nightKeys(0);
    const h = harness({
      objects: n.main,
      rows: [
        { relation: 'detections', backupClass: 'main', rows: 5 },
        { relation: 'accounts', backupClass: 'personal', rows: 1 },
      ],
    });
    const summary = await runRestore(BASE, h.deps);
    expect(summary.ok).toBe(false);
    expect(summary.personalRows.leaked).toEqual(['accounts']);
    expect(summary.findings[0]).toMatch(/rule 8/);
  });

  it('fails the verdict on a missing migration', async () => {
    const n = nightKeys(0);
    const h = harness({ objects: n.main, applied: ['001'] });
    const summary = await runRestore(BASE, h.deps);
    expect(summary.ok).toBe(false);
    expect(summary.findings).toEqual(['migrations missing from the restore: 002']);
  });

  it('fails the verdict when the bucket holds personal artifacts past the horizon', async () => {
    const n = nightKeys(0);
    const stale = nightKeys(31);
    const h = harness({ objects: [...n.main, n.personal, stale.personal] });
    const summary = await runRestore(BASE, h.deps);
    expect(summary.retention.pastErasureHorizonCount).toBe(1);
    expect(summary.ok).toBe(false);
    expect(summary.findings.at(-1)).toMatch(/30-day erasure horizon/);
  });

  it('refuses a checksum mismatch or a missing checksum before creating the database', async () => {
    const n = nightKeys(0);
    const [firstMain = ''] = n.main;
    for (const opts of [
      { corrupt: firstMain },
      { unrecorded: firstMain },
      { corrupt: n.personal },
    ]) {
      const h = harness({ objects: [...n.main, n.personal], ...opts });
      await expect(runRestore(BASE, h.deps)).rejects.toThrow(/sha256/);
      expect(h.events.some((e) => e.startsWith('create'))).toBe(false);
      expect(h.discarded.length).toBeGreaterThan(0);
    }
  });

  it('discards downloads when pg_restore fails', async () => {
    const n = nightKeys(0);
    const h = harness({ objects: [...n.main, n.personal], failRestore: true });
    await expect(runRestore(BASE, h.deps)).rejects.toThrow(/pg_restore/);
    expect(h.discarded).toHaveLength(2);
  });

  it('refuses a production target before listing anything', async () => {
    const h = harness({ objects: nightKeys(0).main });
    await expect(runRestore({ ...BASE, database: 'fire_watch' }, h.deps)).rejects.toThrow(
      /refusing restore target/,
    );
    expect(h.events).toEqual([]);
  });

  it('refuses a missing requested main key', async () => {
    const n = nightKeys(0);
    const h = harness({ objects: [] });
    await expect(runRestore({ ...BASE, mainKey: n.main[0] ?? '' }, h.deps)).rejects.toThrow(
      /does not exist/,
    );
  });

  it('uses the clock once: ages are from the key, relative to now', async () => {
    const n = nightKeys(10);
    const h = harness({ objects: n.main });
    const summary = await runRestore(BASE, h.deps);
    expect(summary.artifactAgeDays).toBe(
      Math.floor((NOW_MS - epochMsFromIso(summary.takenAt)) / DAY),
    );
    expect(summary.artifactAgeDays).toBe(10);
  });
});
