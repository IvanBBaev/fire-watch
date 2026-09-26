import { describe, expect, it } from 'vitest';

import { ConfigError } from './config.js';
import { describeParityConfig, loadParityConfig, parseParityArgs } from './parity-config.js';

const DATABASE_URL = 'postgres://fire_watch:hunter2@db.internal:5432/fire_watch';
const SNPP_REF = '--reference=firms:viirs:snpp=/srv/parity/snpp.csv';

describe('loadParityConfig', () => {
  it('needs only DATABASE_URL and defaults the role', () => {
    expect(loadParityConfig({ DATABASE_URL })).toEqual({
      databaseUrl: DATABASE_URL,
      databaseRole: 'fire_watch_app',
    });
  });

  it('refuses a missing DATABASE_URL and a role that is not a bare identifier', () => {
    expect(() => loadParityConfig({})).toThrow(ConfigError);
    expect(() => loadParityConfig({ DATABASE_URL, FIRE_WATCH_DB_ROLE: 'x; drop' })).toThrow(
      'FIRE_WATCH_DB_ROLE',
    );
  });

  it('never prints the password', () => {
    expect(JSON.stringify(describeParityConfig(loadParityConfig({ DATABASE_URL })))).not.toContain(
      'hunter2',
    );
  });
});

describe('parseParityArgs', () => {
  it('turns --day into one whole UTC day', () => {
    expect(parseParityArgs(['--day=2026-08-20', SNPP_REF])).toEqual({
      fromDay: '2026-08-20',
      toDay: '2026-08-20',
      window: {
        fromMs: Date.parse('2026-08-20T00:00:00Z'),
        toMs: Date.parse('2026-08-21T00:00:00Z'),
      },
      references: [{ source: 'firms:viirs:snpp', path: '/srv/parity/snpp.csv' }],
    });
  });

  it('takes an inclusive --from/--to range and sorts references by source', () => {
    const options = parseParityArgs([
      '--from=2026-08-20',
      '--to=2026-08-26',
      SNPP_REF,
      '--reference=firms:viirs:noaa20=/srv/parity/a=b.csv',
    ]);
    expect(options.window.toMs - options.window.fromMs).toBe(7 * 86_400_000);
    expect(options.references).toEqual([
      { source: 'firms:viirs:noaa20', path: '/srv/parity/a=b.csv' },
      { source: 'firms:viirs:snpp', path: '/srv/parity/snpp.csv' },
    ]);
  });

  it.each([
    [[SNPP_REF], 'required'],
    [['--day=2026-08-20'], 'at least one --reference'],
    [['--day=2026-08-20', '--from=2026-08-20', SNPP_REF], 'excludes'],
    [['--from=2026-08-20', SNPP_REF], 'required'],
    [['--from=2026-08-21', '--to=2026-08-20', SNPP_REF], 'before'],
    [['--day=2026-02-30', SNPP_REF], 'not a calendar date'],
    [['--day=20260820', SNPP_REF], 'YYYY-MM-DD'],
    [['--day=2026-08-20', '--day=2026-08-21', SNPP_REF], 'more than once'],
    [['--day=2026-08-20', SNPP_REF, SNPP_REF], 'more than once'],
    [['--day=2026-08-20', '--reference=firms:nope=/x.csv'], 'unknown source'],
    [['--day=2026-08-20', '--reference=eumetsat:slstr:frp=/x.csv'], 'FIRMS source'],
    [['--day=2026-08-20', '--reference=firms:viirs:snpp=rel.csv'], 'absolute'],
    [['--day=2026-08-20', '--reference=/x.csv'], '<source_id>='],
    [['--day=2026-08-20', '--reference=noequals'], '<source_id>='],
    [['--day=2026-08-20', SNPP_REF, '--verbose'], 'unknown argument'],
  ])('refuses %j', (args, message) => {
    expect(() => parseParityArgs(args)).toThrow(message);
  });
});
