import { describe, expect, it } from 'vitest';

import {
  checkMigrations,
  checkPersonalRows,
  FORBIDDEN_SCRATCH_DATABASES,
  migrationVersionOf,
  scratchDatabaseProblem,
} from './restore-verify.js';

describe('migrationVersionOf', () => {
  it('takes the prefix before the first underscore of NNN_*.sql', () => {
    expect(migrationVersionOf('001_initial_schema.sql')).toBe('001');
    expect(migrationVersionOf('20260101_x.sql')).toBe('20260101');
    expect(migrationVersionOf('README.md')).toBeNull();
    expect(migrationVersionOf('001-initial.sql')).toBeNull();
    expect(migrationVersionOf('001_initial.sql.bak')).toBeNull();
  });
});

describe('checkMigrations', () => {
  const local = ['001_a.sql', '002_b.sql', 'README.md'];

  it('passes when every local version was applied', () => {
    expect(checkMigrations(['001', '002'], local)).toEqual({
      ok: true,
      applied: ['001', '002'],
      local: ['001', '002'],
      missing: [],
      unknown: [],
      latestApplied: '002',
    });
  });

  it('fails on a missing version, reports an unknown one without failing', () => {
    const missing = checkMigrations(['001'], local);
    expect(missing.ok).toBe(false);
    expect(missing.missing).toEqual(['002']);

    const newer = checkMigrations(['001', '002', '003'], local);
    expect(newer.ok).toBe(true);
    expect(newer.unknown).toEqual(['003']);
    expect(newer.latestApplied).toBe('003');
  });

  it('fails when either side is empty', () => {
    expect(checkMigrations([], local).ok).toBe(false);
    expect(checkMigrations(['001'], []).ok).toBe(false);
    expect(checkMigrations([], []).latestApplied).toBeNull();
  });

  it('dedupes and trims', () => {
    expect(checkMigrations([' 001 ', '001', '', '002'], local).applied).toEqual(['001', '002']);
  });
});

describe('checkPersonalRows', () => {
  const counts = [
    { relation: 'detections', backupClass: 'main' as const, rows: 10 },
    { relation: 'accounts', backupClass: 'personal' as const, rows: 0 },
    { relation: 'zones', backupClass: 'personal' as const, rows: 0 },
    { relation: 'unregistered', backupClass: null, rows: 0 },
  ];

  it('passes a main-only restore with empty personal tables (§6.2 rule 8)', () => {
    expect(checkPersonalRows(counts, false)).toEqual({
      ok: true,
      personalRestored: false,
      leaked: [],
      personalRows: 0,
      mainRows: 10,
    });
  });

  it('fails when a personal or unclassified table holds rows without its companion', () => {
    const leaky = [
      ...counts.slice(0, 2),
      { relation: 'zones', backupClass: 'personal' as const, rows: 3 },
      { relation: 'unregistered', backupClass: null, rows: 1 },
    ];
    const check = checkPersonalRows(leaky, false);
    expect(check.ok).toBe(false);
    expect(check.leaked).toEqual(['unregistered', 'zones']);
    expect(check.personalRows).toBe(4);
  });

  it('expects rows when the personal companion was restored', () => {
    const full = counts.map((c) => (c.backupClass === 'main' ? c : { ...c, rows: 2 }));
    const check = checkPersonalRows(full, true);
    expect(check.ok).toBe(true);
    expect(check.personalRows).toBe(6);
  });
});

describe('scratchDatabaseProblem', () => {
  it('accepts names marked as scratch', () => {
    for (const name of ['fw_restore_drill', 'scratch', 'drill_2026', 'fw_scratch']) {
      expect(scratchDatabaseProblem(name)).toBeNull();
    }
  });

  it('refuses production and system databases', () => {
    for (const name of FORBIDDEN_SCRATCH_DATABASES) {
      expect(scratchDatabaseProblem(name)).not.toBeNull();
    }
  });

  it('refuses names that are not identifiers or not marked', () => {
    for (const name of [
      'FW_RESTORE',
      'fw-restore',
      '',
      'restored_prod',
      'fire_watch_copy',
      'a'.repeat(64),
    ]) {
      expect(scratchDatabaseProblem(name)).not.toBeNull();
    }
  });
});
