import { describe, expect, it } from 'vitest';

import { ConfigError } from './config.js';
import {
  describeSpPromotionConfig,
  loadSpPromotionConfig,
  parsePromotionArgs,
} from './sp-promotion-config.js';

const ENV = {
  DATABASE_URL: 'postgres://owner:secret@db.example:5432/fire_watch',
  FIRE_WATCH_ARCHIVE_DIR: '/var/lib/fire-watch/archive',
};

describe('loadSpPromotionConfig', () => {
  it('loads both required variables', () => {
    expect(loadSpPromotionConfig(ENV)).toEqual({
      databaseUrl: ENV.DATABASE_URL,
      archiveDir: ENV.FIRE_WATCH_ARCHIVE_DIR,
    });
  });

  it('lists every missing variable in one error', () => {
    expect(() => loadSpPromotionConfig({})).toThrow(ConfigError);
    expect(() => loadSpPromotionConfig({})).toThrow(/DATABASE_URL, FIRE_WATCH_ARCHIVE_DIR/);
  });

  it('treats an empty value as missing', () => {
    expect(() => loadSpPromotionConfig({ ...ENV, DATABASE_URL: '' })).toThrow(/DATABASE_URL/);
  });

  it('refuses a relative archive dir', () => {
    expect(() => loadSpPromotionConfig({ ...ENV, FIRE_WATCH_ARCHIVE_DIR: 'archive' })).toThrow(
      /absolute path/,
    );
  });
});

describe('parsePromotionArgs', () => {
  it('parses month, dry-run and confirm', () => {
    expect(parsePromotionArgs(['--month=2020-07', '--dry-run', '--confirm'])).toEqual({
      month: '2020-07',
      dryRun: true,
      operatorConfirmed: true,
    });
  });

  it('defaults to a real, unconfirmed run', () => {
    expect(parsePromotionArgs(['--month=2020-07'])).toEqual({
      month: '2020-07',
      dryRun: false,
      operatorConfirmed: false,
    });
  });

  it.each([
    [[], /--month is required/],
    [['--month=2020-07', '--month=2020-08'], /more than once/],
    [['--month=2020-13'], /2020-13/],
    [['--month=2020-07', '--force'], /unknown argument "--force"/],
    [['2020-07'], /unknown argument/],
  ])('rejects %j', (args, message) => {
    expect(() => parsePromotionArgs(args)).toThrow(ConfigError);
    expect(() => parsePromotionArgs(args)).toThrow(message);
  });
});

describe('describeSpPromotionConfig', () => {
  it('never prints the password', () => {
    const described = describeSpPromotionConfig({
      databaseUrl: ENV.DATABASE_URL,
      archiveDir: ENV.FIRE_WATCH_ARCHIVE_DIR,
    });
    expect(described['database']).toBe('postgres://owner@db.example:5432/fire_watch');
    expect(JSON.stringify(described)).not.toContain('secret');
  });

  it('refuses to echo an unparseable URL', () => {
    expect(
      describeSpPromotionConfig({ databaseUrl: 'host=db password=x', archiveDir: '/a' })[
        'database'
      ],
    ).toBe('<unparseable DATABASE_URL>');
  });
});
