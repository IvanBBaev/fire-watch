import { randomBytes } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { createAesGcmTotpSealer } from '../adapters/crypto/aes-gcm-totp-sealer.js';
import { ConfigError } from './config.js';
import { describeStaffTotpConfig, loadStaffTotpConfig } from './staff-totp-config.js';

const KEY = randomBytes(32).toString('base64');
const OLD = randomBytes(32).toString('base64');
const STAFF = '00000000-0000-4000-8000-000000000001';

describe('loadStaffTotpConfig', () => {
  it('is null when nothing is configured', () => {
    expect(loadStaffTotpConfig({})).toBeNull();
    expect(
      loadStaffTotpConfig({ FIRE_WATCH_STAFF_TOTP_KEY_ID: '', FIRE_WATCH_STAFF_TOTP_KEY: ' ' }),
    ).toBeNull();
  });

  it('reads a keyring the sealer accepts, retired keys included', () => {
    const before = loadStaffTotpConfig({
      FIRE_WATCH_STAFF_TOTP_KEY_ID: 't2026a',
      FIRE_WATCH_STAFF_TOTP_KEY: OLD,
    });
    const after = loadStaffTotpConfig({
      FIRE_WATCH_STAFF_TOTP_KEY_ID: 't2026b',
      FIRE_WATCH_STAFF_TOTP_KEY: KEY,
      FIRE_WATCH_STAFF_TOTP_KEYS_RETIRED: `t2026a:${OLD}`,
    });
    if (before === null || after === null) throw new Error('keyring expected');
    expect(after.retired.map((key) => key.id)).toEqual(['t2026a']);
    const secret = new Uint8Array(randomBytes(20));
    const sealed = createAesGcmTotpSealer(before).seal(STAFF, new Uint8Array(secret));
    expect(createAesGcmTotpSealer(after).open(STAFF, sealed)).toEqual(secret);
    expect(createAesGcmTotpSealer(after).seal(STAFF, secret).keyId).toBe('t2026b');
  });

  it.each([
    [{ FIRE_WATCH_STAFF_TOTP_KEY_ID: 't1' }, /missing: FIRE_WATCH_STAFF_TOTP_KEY$/],
    [{ FIRE_WATCH_STAFF_TOTP_KEY: KEY }, /missing: FIRE_WATCH_STAFF_TOTP_KEY_ID/],
    [
      { FIRE_WATCH_STAFF_TOTP_KEYS_RETIRED: `t1:${OLD}` },
      /FIRE_WATCH_STAFF_TOTP_KEYS_RETIRED is set but FIRE_WATCH_STAFF_TOTP_KEY_ID is not/,
    ],
    [{ FIRE_WATCH_STAFF_TOTP_KEY_ID: 't|1', FIRE_WATCH_STAFF_TOTP_KEY: KEY }, /KEY_ID must be/],
    [
      {
        FIRE_WATCH_STAFF_TOTP_KEY_ID: 't1',
        FIRE_WATCH_STAFF_TOTP_KEY: randomBytes(16).toString('base64'),
      },
      /exactly 32 bytes/,
    ],
    [
      {
        FIRE_WATCH_STAFF_TOTP_KEY_ID: 't1',
        FIRE_WATCH_STAFF_TOTP_KEY: KEY,
        FIRE_WATCH_STAFF_TOTP_KEYS_RETIRED: `t1:${OLD}`,
      },
      /repeats a key id/,
    ],
  ])('refuses a bad configuration without quoting it (%#)', (env, message) => {
    let thrown: unknown;
    try {
      loadStaffTotpConfig(env);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ConfigError);
    expect((thrown as Error).message).toMatch(message);
    expect((thrown as Error).message).not.toContain(KEY);
    expect((thrown as Error).message).not.toContain(OLD);
  });
});

describe('describeStaffTotpConfig', () => {
  it('prints key ids only', () => {
    expect(describeStaffTotpConfig(null)).toEqual({ staff_totp_keys: 'unset' });
    const keyring = loadStaffTotpConfig({
      FIRE_WATCH_STAFF_TOTP_KEY_ID: 't2026b',
      FIRE_WATCH_STAFF_TOTP_KEY: KEY,
      FIRE_WATCH_STAFF_TOTP_KEYS_RETIRED: `t2026a:${OLD}`,
    });
    const printed = JSON.stringify(describeStaffTotpConfig(keyring));
    expect(printed).toContain('t2026b');
    expect(printed).not.toContain(KEY);
    expect(printed).not.toContain(OLD);
  });
});
