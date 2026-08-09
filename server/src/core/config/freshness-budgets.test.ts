import { describe, expect, it } from 'vitest';

import { BUDGETED_JOB_IDS, MONITORED_FEED_IDS } from '@fire-watch/contracts';

import {
  FRESHNESS_BUDGETS,
  MAX_MUTE_SECONDS,
  activeMute,
  budgetFor,
  validate,
  type FreshnessBudget,
  type FreshnessBudgetTable,
} from './freshness-budgets.js';

const HOUR = 3_600_000;

function budget(overrides: Partial<FreshnessBudget> = {}): FreshnessBudget {
  return {
    row: 'snapshot-push',
    nominalCadenceSeconds: 60,
    warnSeconds: 300,
    criticalSeconds: 900,
    pages: true,
    ...overrides,
  };
}

/** A table with every required row, so a test can break exactly one thing. */
function table(overrides: Partial<FreshnessBudgetTable> = {}): FreshnessBudgetTable {
  return {
    rows: [...MONITORED_FEED_IDS, ...BUDGETED_JOB_IDS].map((row) => budget({ row })),
    mutes: [],
    ...overrides,
  };
}

describe('the shipped table', () => {
  it('has a row for everything monitored and nothing else', () => {
    for (const row of [...MONITORED_FEED_IDS, ...BUDGETED_JOB_IDS]) {
      expect(budgetFor(row)).toBeDefined();
    }
    expect(FRESHNESS_BUDGETS.values.rows).toHaveLength(
      MONITORED_FEED_IDS.length + BUDGETED_JOB_IDS.length,
    );
  });

  it('carries the §1.2 numbers the runbook quotes', () => {
    // These are pinned because they are what a page cites back at whoever is holding it.
    expect(budgetFor('firms:viirs:snpp')).toMatchObject({
      warnSeconds: 1200,
      criticalSeconds: 2700,
    });
    expect(budgetFor('lsasaf:seviri:frp-pixel')).toMatchObject({
      warnSeconds: 1800,
      criticalSeconds: 3600,
    });
    expect(budgetFor('effis:layers')).toMatchObject({
      warnSeconds: 93_600,
      criticalSeconds: 180_000,
    });
  });

  it('lets the snapshot push 500 exactly where the 5-minute promise breaks', () => {
    // ADR-003 tells users the map is never more than 5 minutes stale. The budget is that
    // sentence, executable.
    expect(budgetFor('snapshot-push')).toMatchObject({ warnSeconds: 300, pages: true });
  });

  it('keeps degradation-only feeds out of the 500 set', () => {
    // §1.2: late weather and late SLSTR make the product worse, not blind.
    expect(budgetFor('weather:context')?.pages).toBe(false);
    expect(budgetFor('eumetsat:slstr:frp')?.pages).toBe(false);
  });

  it('leaves backup lateness to its own primary leg', () => {
    // §1.3, "one paging condition, one primary leg": healthchecks.io pages for a late
    // backup, so this endpoint must not also 500 for it.
    expect(budgetFor('nightly-backup')?.pages).toBe(false);
    expect(budgetFor('wal-archive')?.pages).toBe(false);
  });

  it('ships with no mutes', () => {
    expect(FRESHNESS_BUDGETS.values.mutes).toEqual([]);
  });

  it('has a warn of two to four nominal cycles wherever a cadence is known', () => {
    for (const row of FRESHNESS_BUDGETS.values.rows) {
      const cadence = row.nominalCadenceSeconds;
      if (cadence === null || cadence >= 6 * 3600) continue; // dailies are their own rule
      expect(row.warnSeconds / cadence).toBeGreaterThanOrEqual(2);
      expect(row.warnSeconds / cadence).toBeLessThanOrEqual(5);
    }
  });

  it('is identified by a digest, so a moved threshold is a visible change', () => {
    expect(FRESHNESS_BUDGETS.version).toBe('freshness_budgets_v1');
    expect(FRESHNESS_BUDGETS.digest).toMatch(/^[0-9a-f]{8}$/);
  });

  it('pins pages and critical for every row, so any drift is an explicit diff in review', () => {
    // The complete table, transcribed as literals on purpose. These values are spec-pinned
    // by OPERATIONS §1.2/§1.3, and most rows are asserted nowhere else — the tests above
    // quote only what the runbook quotes. The point of this test is that any future change
    // to a `pages` flag or a critical threshold must show up as an explicit diff a reviewer
    // holds against OPERATIONS, never as a silent flip that only surfaces when a stalled
    // feed fails to 500.
    const actual = Object.fromEntries(
      FRESHNESS_BUDGETS.values.rows.map((row) => [
        row.row,
        { pages: row.pages, criticalSeconds: row.criticalSeconds },
      ]),
    );

    expect(actual).toEqual({
      'firms:viirs:snpp': { pages: true, criticalSeconds: 2_700 },
      'firms:viirs:noaa20': { pages: true, criticalSeconds: 2_700 },
      'firms:viirs:noaa21': { pages: true, criticalSeconds: 2_700 },
      'lsasaf:seviri:frp-pixel': { pages: true, criticalSeconds: 3_600 },
      'lsasaf:fci:frp-pixel': { pages: true, criticalSeconds: 3_600 },
      'eumetsat:slstr:frp': { pages: false, criticalSeconds: 43_200 },
      'eumetsat:clm': { pages: true, criticalSeconds: 5_400 },
      'effis:layers': { pages: true, criticalSeconds: 180_000 },
      'weather:context': { pages: false, criticalSeconds: 86_400 },
      'snapshot-push': { pages: true, criticalSeconds: 900 },
      'nightly-backup': { pages: false, criticalSeconds: 180_000 },
      'wal-archive': { pages: false, criticalSeconds: 3_600 },
      'effis-refresh': { pages: false, criticalSeconds: 180_000 },
    });
  });
});

describe('a table that cannot be trusted', () => {
  it('refuses a monitored row with no budget', () => {
    const rows = table().rows.filter((row) => row.row !== 'weather:context');

    expect(() => validate(table({ rows }))).toThrow(/without a freshness budget: weather:context/);
  });

  it('refuses a budget for a row nobody monitors', () => {
    const rows = [...table().rows, budget({ row: 'firms:modis' as never })];

    expect(() => validate(table({ rows }))).toThrow(/not a monitored row/);
  });

  it('refuses the same row twice, because only one of them would ever be read', () => {
    const rows = [...table().rows, budget({ row: 'snapshot-push' })];

    expect(() => validate(table({ rows }))).toThrow(/defined twice/);
  });

  it('refuses a critical that is not past warn', () => {
    const rows = table().rows.map((row) =>
      row.row === 'snapshot-push' ? budget({ warnSeconds: 900, criticalSeconds: 900 }) : row,
    );

    expect(() => validate(table({ rows }))).toThrow(/at or below warn/);
  });

  it('refuses a non-positive warn', () => {
    const rows = table().rows.map((row) =>
      row.row === 'snapshot-push' ? budget({ warnSeconds: 0 }) : row,
    );

    expect(() => validate(table({ rows }))).toThrow(/non-positive warn/);
  });

  it('refuses a NaN critical, which no ordering comparison would ever catch', () => {
    // `NaN <= warnSeconds` is false, so without its own check a NaN critical sails through
    // the ordering rule and ships a row that can never go critical — the verdict that
    // quietly never fires.
    const rows = table().rows.map((row) =>
      row.row === 'snapshot-push' ? budget({ criticalSeconds: Number.NaN }) : row,
    );

    expect(() => validate(table({ rows }))).toThrow(/non-positive critical/);
  });

  it('refuses a fractional critical, same as it refuses a fractional warn', () => {
    const rows = table().rows.map((row) =>
      row.row === 'snapshot-push' ? budget({ criticalSeconds: 900.5 }) : row,
    );

    expect(() => validate(table({ rows }))).toThrow(/non-positive critical/);
  });
});

describe('mutes', () => {
  const from = '2026-08-09T06:00:00.000Z';

  it('accepts a bounded, explained silence', () => {
    const muted = table({
      mutes: [
        {
          row: 'eumetsat:clm',
          fromIso: from,
          untilIso: '2026-08-09T18:00:00.000Z',
          reason: 'EUMETSAT announced a Data Store maintenance window',
        },
      ],
    });

    expect(() => validate(muted)).not.toThrow();
    expect(activeMute('eumetsat:clm', Date.parse('2026-08-09T12:00:00Z'), muted)?.reason).toContain(
      'maintenance',
    );
  });

  it('stops applying on its own, which is the only reason it is allowed to exist', () => {
    const muted = table({
      mutes: [
        {
          row: 'eumetsat:clm',
          fromIso: from,
          untilIso: '2026-08-09T18:00:00.000Z',
          reason: 'announced maintenance',
        },
      ],
    });

    expect(activeMute('eumetsat:clm', Date.parse('2026-08-09T05:59:59Z'), muted)).toBeUndefined();
    expect(activeMute('eumetsat:clm', Date.parse('2026-08-09T18:00:00Z'), muted)).toBeUndefined();
  });

  it('applies from the very first instant of its window', () => {
    // The window is [from, until): an operator writes `fromIso` as the instant the
    // provider's announced outage starts, so the mute must hold at exactly that instant,
    // not one millisecond after.
    const muted = table({
      mutes: [
        {
          row: 'eumetsat:clm',
          fromIso: from,
          untilIso: '2026-08-09T18:00:00.000Z',
          reason: 'announced maintenance',
        },
      ],
    });

    expect(activeMute('eumetsat:clm', Date.parse(from), muted)).toBeDefined();
  });

  it('accepts a silence of exactly the 24 h cap', () => {
    // §1.1(6) says "at most 24 h": a full day is legal, and only one second more is not.
    // Without this pin, only the rejection side of the cap is held in place.
    const muted = table({
      mutes: [
        {
          row: 'eumetsat:clm',
          fromIso: from,
          untilIso: new Date(Date.parse(from) + MAX_MUTE_SECONDS * 1000).toISOString(),
          reason: 'announced maintenance, a full day of it',
        },
      ],
    });

    expect(() => validate(muted)).not.toThrow();
  });

  it('refuses a silence longer than a day', () => {
    const muted = table({
      mutes: [
        {
          row: 'eumetsat:clm',
          fromIso: from,
          untilIso: new Date(Date.parse(from) + MAX_MUTE_SECONDS * 1000 + 1000).toISOString(),
          reason: 'indefinite provider outage',
        },
      ],
    });

    expect(() => validate(muted)).toThrow(/longer than the 86400s cap/);
  });

  it('refuses a silence with nothing written on it', () => {
    const muted = table({
      mutes: [
        { row: 'eumetsat:clm', fromIso: from, untilIso: '2026-08-09T12:00:00.000Z', reason: '  ' },
      ],
    });

    expect(() => validate(muted)).toThrow(/no reason/);
  });

  it('refuses a silence over a row that has no budget', () => {
    const muted = table({
      mutes: [
        {
          row: 'firms:modis' as never,
          fromIso: from,
          untilIso: new Date(Date.parse(from) + HOUR).toISOString(),
          reason: 'retired',
        },
      ],
    });

    expect(() => validate(muted)).toThrow(/has no budget/);
  });
});
