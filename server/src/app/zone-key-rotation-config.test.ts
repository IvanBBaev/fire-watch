import { randomBytes } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import type { ZoneKeyRotationReport } from '../core/zones/rotate-zone-centre-keys.js';
import { ConfigError } from './config.js';
import {
  DEFAULT_ROTATION_BATCH_SIZE,
  describeZoneKeyRotationConfig,
  loadZoneKeyRotationConfig,
  parseZoneKeyRotationArgs,
  zoneKeyRotationExitCode,
} from './zone-key-rotation-config.js';

const KEY = randomBytes(32).toString('base64');
const OLD = randomBytes(32).toString('base64');
const ENV = {
  DATABASE_URL: 'postgres://app:hunter2@db.internal:5432/firewatch',
  FIRE_WATCH_ZONE_KEY_ID: 'k2026b',
  FIRE_WATCH_ZONE_KEY: KEY,
  FIRE_WATCH_ZONE_KEYS_RETIRED: `k2026a:${OLD}`,
};

describe('loadZoneKeyRotationConfig', () => {
  it('reads the database and the keyring, defaulting the role', () => {
    const config = loadZoneKeyRotationConfig(ENV);
    expect(config.databaseRole).toBe('fire_watch_app');
    expect(config.keyring.active.id).toBe('k2026b');
    expect(config.keyring.retired.map((key) => key.id)).toEqual(['k2026a']);
  });

  it('requires DATABASE_URL', () => {
    expect(() => loadZoneKeyRotationConfig({ ...ENV, DATABASE_URL: '' })).toThrow(ConfigError);
  });

  it('requires a keyring: a rotation without keys is a misconfiguration, not a no-op', () => {
    expect(() => loadZoneKeyRotationConfig({ DATABASE_URL: ENV.DATABASE_URL })).toThrow(
      /FIRE_WATCH_ZONE_KEY_ID, FIRE_WATCH_ZONE_KEY/,
    );
  });

  it('refuses a role that is not a bare identifier', () => {
    expect(() =>
      loadZoneKeyRotationConfig({ ...ENV, FIRE_WATCH_DB_ROLE: 'x; DROP TABLE y' }),
    ).toThrow(ConfigError);
  });

  it('describes key ids and a redacted URL, never a key or a password', () => {
    const text = JSON.stringify(describeZoneKeyRotationConfig(loadZoneKeyRotationConfig(ENV)));
    expect(text).toContain('k2026a');
    expect(text).toContain('k2026b');
    expect(text).not.toContain('hunter2');
    expect(text).not.toContain(KEY);
    expect(text).not.toContain(OLD);
  });
});

describe('parseZoneKeyRotationArgs', () => {
  it('defaults to a full run in batches of the default size', () => {
    expect(parseZoneKeyRotationArgs([])).toEqual({
      batchSize: DEFAULT_ROTATION_BATCH_SIZE,
      maxBatches: null,
      dryRun: false,
    });
  });

  it('reads every flag', () => {
    expect(parseZoneKeyRotationArgs(['--batch-size=50', '--max-batches=3', '--dry-run'])).toEqual({
      batchSize: 50,
      maxBatches: 3,
      dryRun: true,
    });
  });

  it.each([
    ['--batch-size=0'],
    ['--batch-size=-1'],
    ['--batch-size=1.5'],
    ['--batch-size=10001'],
    ['--batch-size=01'],
    ['--max-batches=0'],
    ['--max-batches='],
    ['--dry-run=yes'],
    ['--batch'],
    ['rotate'],
  ])('refuses %s', (arg) => {
    expect(() => parseZoneKeyRotationArgs([arg])).toThrow(ConfigError);
  });

  it('refuses a repeated flag', () => {
    expect(() => parseZoneKeyRotationArgs(['--dry-run', '--dry-run'])).toThrow(/more than once/);
    expect(() => parseZoneKeyRotationArgs(['--batch-size=1', '--batch-size=2'])).toThrow(
      /more than once/,
    );
  });
});

describe('zoneKeyRotationExitCode', () => {
  const report = (over: Partial<ZoneKeyRotationReport>): ZoneKeyRotationReport => ({
    activeKeyId: 'k2',
    dryRun: false,
    batches: 1,
    examined: 0,
    rotated: 0,
    raced: 0,
    failedByKeyId: {},
    before: {},
    after: {},
    stoppedEarly: false,
    complete: true,
    ...over,
  });

  it('is 0 when complete, 3 when cleanly incomplete, 1 when rows could not be opened', () => {
    expect(zoneKeyRotationExitCode(report({}))).toBe(0);
    expect(zoneKeyRotationExitCode(report({ complete: false, stoppedEarly: true }))).toBe(3);
    expect(zoneKeyRotationExitCode(report({ complete: false, dryRun: true }))).toBe(3);
    expect(zoneKeyRotationExitCode(report({ complete: false, failedByKeyId: { k0: 2 } }))).toBe(1);
  });
});
