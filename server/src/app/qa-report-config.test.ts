import { describe, expect, it } from 'vitest';

import { ConfigError, DEFAULT_POLL_INTERVAL_MS } from './config.js';
import {
  describeQaReportConfig,
  loadQaReportConfig,
  parseQaReportArgs,
  reportFileStem,
  resolveReportWindow,
} from './qa-report-config.js';

const URL_WITH_PASSWORD = 'postgres://fire_watch:hunter2@db.internal:5432/fire_watch';

describe('loadQaReportConfig', () => {
  it('requires DATABASE_URL and defaults the rest to the worker values', () => {
    expect(() => loadQaReportConfig({})).toThrow(ConfigError);
    expect(loadQaReportConfig({ DATABASE_URL: URL_WITH_PASSWORD })).toEqual({
      databaseUrl: URL_WITH_PASSWORD,
      databaseRole: 'fire_watch_app',
      pollIntervalMs: DEFAULT_POLL_INTERVAL_MS,
    });
  });

  it('reads the worker poll interval within the worker bounds', () => {
    const env = { DATABASE_URL: URL_WITH_PASSWORD };
    expect(
      loadQaReportConfig({ ...env, FIRE_WATCH_POLL_INTERVAL_MS: '300000' }).pollIntervalMs,
    ).toBe(300_000);
    for (const bad of ['59999', '3600001', '150000.5', 'ten']) {
      expect(() => loadQaReportConfig({ ...env, FIRE_WATCH_POLL_INTERVAL_MS: bad })).toThrow(
        ConfigError,
      );
    }
  });

  it('refuses a role that is not a bare identifier', () => {
    expect(() =>
      loadQaReportConfig({ DATABASE_URL: URL_WITH_PASSWORD, FIRE_WATCH_DB_ROLE: 'x; drop' }),
    ).toThrow(ConfigError);
  });

  it('never describes the password', () => {
    const described = describeQaReportConfig(
      loadQaReportConfig({ DATABASE_URL: URL_WITH_PASSWORD }),
    );
    expect(JSON.stringify(described)).not.toContain('hunter2');
    expect(described['database']).toBe('postgres://fire_watch@db.internal:5432/fire_watch');
  });
});

describe('parseQaReportArgs', () => {
  it('defaults to the last closed week', () => {
    expect(parseQaReportArgs(['--out=reports'])).toEqual({
      window: { kind: 'last_closed' },
      outDir: 'reports',
    });
  });

  it('reads a week or an inclusive day range', () => {
    expect(parseQaReportArgs(['--week=2026-W38', '--out=r']).window).toEqual({
      kind: 'week',
      week: '2026-W38',
    });
    expect(parseQaReportArgs(['--from=2026-09-01', '--to=2026-09-10', '--out=r']).window).toEqual({
      kind: 'range',
      fromDay: '2026-09-01',
      toDay: '2026-09-10',
    });
  });

  it.each([
    [[]],
    [['--week=2026-W38']],
    [['--out=']],
    [['--out=a', '--out=b']],
    [['--week=2026-W38', '--from=2026-09-01', '--out=r']],
    [['--from=2026-09-01', '--out=r']],
    [['--to=2026-09-01', '--out=r']],
    [['--week=2027-W53', '--out=r']],
    [['--from=2026-09-10', '--to=2026-09-01', '--out=r']],
    [['--from=2026-02-30', '--to=2026-03-01', '--out=r']],
    [['--verbose', '--out=r']],
  ])('refuses %j with a ConfigError', (args) => {
    expect(() => parseQaReportArgs(args)).toThrow(ConfigError);
  });
});

describe('resolveReportWindow and reportFileStem', () => {
  const now = Date.parse('2026-09-23T10:00:00Z');

  it('names the last closed week relative to now', () => {
    const arg = { kind: 'last_closed' } as const;
    const window = resolveReportWindow(arg, now);
    expect(window.isoWeek).toBe('2026-W38');
    expect(reportFileStem(arg, window)).toBe('qa-weekly-2026-W38');
  });

  it('names a range by its inclusive days, and a week-shaped range by its week', () => {
    const range = { kind: 'range', fromDay: '2026-09-01', toDay: '2026-09-10' } as const;
    expect(reportFileStem(range, resolveReportWindow(range, now))).toBe(
      'qa-range-2026-09-01_2026-09-10',
    );
    const weekShaped = { kind: 'range', fromDay: '2026-09-14', toDay: '2026-09-20' } as const;
    expect(reportFileStem(weekShaped, resolveReportWindow(weekShaped, now))).toBe(
      'qa-weekly-2026-W38',
    );
  });
});
