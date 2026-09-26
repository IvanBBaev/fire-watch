import { describe, expect, it } from 'vitest';

import { ConfigError } from './config.js';
import {
  describeLagHistogramConfig,
  loadLagHistogramConfig,
  parseLagHistogramArgs,
} from './lag-histogram-config.js';

const DATABASE_URL = 'postgres://fire_watch:hunter2@db.internal:5432/fire_watch';

describe('loadLagHistogramConfig', () => {
  it('needs only DATABASE_URL and defaults the role', () => {
    expect(loadLagHistogramConfig({ DATABASE_URL })).toEqual({
      databaseUrl: DATABASE_URL,
      databaseRole: 'fire_watch_app',
    });
  });

  it('refuses a missing DATABASE_URL and a bad role', () => {
    expect(() => loadLagHistogramConfig({})).toThrow(ConfigError);
    expect(() => loadLagHistogramConfig({ DATABASE_URL, FIRE_WATCH_DB_ROLE: 'Bad-Role' })).toThrow(
      'FIRE_WATCH_DB_ROLE',
    );
  });

  it('never prints the password', () => {
    expect(
      JSON.stringify(describeLagHistogramConfig(loadLagHistogramConfig({ DATABASE_URL }))),
    ).not.toContain('hunter2');
  });
});

describe('parseLagHistogramArgs', () => {
  it('records the default days when none are named', () => {
    expect(parseLagHistogramArgs(['record'])).toEqual({ kind: 'record', days: null });
  });

  it('records named days, deduplicated and sorted', () => {
    expect(
      parseLagHistogramArgs(['record', '--day=2026-08-21', '--day=2026-08-20', '--day=2026-08-21']),
    ).toEqual({ kind: 'record', days: ['2026-08-20', '2026-08-21'] });
  });

  it('exports an inclusive day window', () => {
    expect(parseLagHistogramArgs(['export', '--from=2026-08-20', '--to=2026-08-26'])).toEqual({
      kind: 'export',
      fromDay: '2026-08-20',
      toDay: '2026-08-26',
    });
  });

  it.each([
    [[], 'a command is required'],
    [['replay'], 'unknown command'],
    [['record', '--from=2026-08-20'], 'unknown argument'],
    [['record', '--day=2026-02-30'], 'not a calendar date'],
    [['export', '--from=2026-08-20'], 'both --from and --to'],
    [['export', '--from=2026-08-21', '--to=2026-08-20'], 'before'],
    [['export', '--from=2026-08-20', '--from=2026-08-21', '--to=2026-08-22'], 'more than once'],
    [['export', '--from=2026-08-20', '--to=2026-08-22', '--day=2026-08-20'], 'unknown argument'],
  ])('refuses %j', (args, message) => {
    expect(() => parseLagHistogramArgs(args)).toThrow(message);
  });
});
