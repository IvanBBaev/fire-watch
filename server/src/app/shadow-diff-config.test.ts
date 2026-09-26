import { describe, expect, it } from 'vitest';

import { ConfigError } from './config.js';
import {
  describeShadowDiffConfig,
  loadShadowDiffConfig,
  parseShadowDiffArgs,
  utcDayWindow,
} from './shadow-diff-config.js';

const ENV = { DATABASE_URL: 'postgres://app:secret@db.example:5432/fire_watch' };

describe('loadShadowDiffConfig', () => {
  it('defaults the role to the runtime role', () => {
    expect(loadShadowDiffConfig(ENV)).toEqual({
      databaseUrl: ENV.DATABASE_URL,
      databaseRole: 'fire_watch_app',
    });
  });

  it('takes an explicit role', () => {
    expect(
      loadShadowDiffConfig({ ...ENV, FIRE_WATCH_DB_ROLE: ' fire_watch_admin ' }).databaseRole,
    ).toBe('fire_watch_admin');
  });

  it.each([{}, { DATABASE_URL: '' }])('requires DATABASE_URL (%j)', (env) => {
    expect(() => loadShadowDiffConfig(env)).toThrow(ConfigError);
    expect(() => loadShadowDiffConfig(env)).toThrow(/DATABASE_URL/);
  });

  it('refuses a role that is not a bare identifier', () => {
    expect(() =>
      loadShadowDiffConfig({ ...ENV, FIRE_WATCH_DB_ROLE: 'app -c search_path=evil' }),
    ).toThrow(/lowercase unquoted identifier/);
  });
});

describe('parseShadowDiffArgs', () => {
  it('parses candidate, day and explanations', () => {
    expect(
      parseShadowDiffArgs([
        '--candidate=clustering_v2',
        '--day=2026-08-20',
        '--explanations=/srv/shadow/clustering_v2.json',
      ]),
    ).toEqual({
      candidateVersion: 'clustering_v2',
      day: '2026-08-20',
      window: {
        fromMs: Date.parse('2026-08-20T00:00:00Z'),
        toMs: Date.parse('2026-08-21T00:00:00Z'),
      },
      explanationsPath: '/srv/shadow/clustering_v2.json',
    });
  });

  it('defaults to no explanations file', () => {
    expect(
      parseShadowDiffArgs(['--day=2026-08-20', '--candidate=clustering_v2']).explanationsPath,
    ).toBeNull();
  });

  it.each([
    [[], /--candidate is required/],
    [['--candidate=clustering_v2'], /--day is required/],
    [['--candidate=Clustering', '--day=2026-08-20'], /<name>_v<N>/],
    [['--candidate=a_v1', '--candidate=a_v2', '--day=2026-08-20'], /more than once/],
    [['--candidate=a_v1', '--day=2026-08-20', '--day=2026-08-21'], /more than once/],
    [['--candidate=a_v1', '--day=2026-8-20'], /YYYY-MM-DD/],
    [['--candidate=a_v1', '--day=2026-02-30'], /not a calendar date/],
    [['--candidate=a_v1', '--day=2026-08-20', '--explanations=rel.json'], /absolute path/],
    [['--candidate=a_v1', '--day=2026-08-20', '--dry-run'], /unknown argument "--dry-run"/],
  ])('rejects %j', (args, message) => {
    expect(() => parseShadowDiffArgs(args)).toThrow(ConfigError);
    expect(() => parseShadowDiffArgs(args)).toThrow(message);
  });
});

describe('utcDayWindow', () => {
  it('is 24 hours even across the Sofia DST change', () => {
    const window = utcDayWindow('2026-10-25');
    expect(window.toMs - window.fromMs).toBe(86_400_000);
    expect(new Date(window.fromMs).toISOString()).toBe('2026-10-25T00:00:00.000Z');
  });

  it('accepts a leap day', () => {
    expect(new Date(utcDayWindow('2028-02-29').fromMs).toISOString()).toBe(
      '2028-02-29T00:00:00.000Z',
    );
  });
});

describe('describeShadowDiffConfig', () => {
  it('never prints the password', () => {
    const described = describeShadowDiffConfig({
      databaseUrl: ENV.DATABASE_URL,
      databaseRole: 'fire_watch_app',
    });
    expect(described).toEqual({
      database: 'postgres://app@db.example:5432/fire_watch',
      database_role: 'fire_watch_app',
    });
  });

  it('refuses to echo an unparseable URL', () => {
    expect(
      describeShadowDiffConfig({ databaseUrl: 'host=db password=x', databaseRole: 'r' })[
        'database'
      ],
    ).toBe('<unparseable DATABASE_URL>');
  });
});
