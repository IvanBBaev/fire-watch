import { randomBytes } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { ConfigError } from './config.js';
import { describeZonesConfig, loadZonesConfig } from './zones-config.js';

const KEY = randomBytes(32).toString('base64');
const OLD = randomBytes(32).toString('base64');

describe('loadZonesConfig', () => {
  it('is null when nothing is configured', () => {
    expect(loadZonesConfig({})).toBeNull();
    expect(loadZonesConfig({ FIRE_WATCH_ZONE_KEY_ID: ' ', FIRE_WATCH_ZONE_KEY: '' })).toBeNull();
  });

  it('reads the active key as raw bytes under its id', () => {
    const keyring = loadZonesConfig({ FIRE_WATCH_ZONE_KEY_ID: 'k2026a', FIRE_WATCH_ZONE_KEY: KEY });
    expect(keyring?.active.id).toBe('k2026a');
    expect(Buffer.from(keyring?.active.key ?? []).toString('base64')).toBe(KEY);
    expect(keyring?.retired).toEqual([]);
  });

  it('reads retired keys', () => {
    const keyring = loadZonesConfig({
      FIRE_WATCH_ZONE_KEY_ID: 'k2026b',
      FIRE_WATCH_ZONE_KEY: KEY,
      FIRE_WATCH_ZONE_KEYS_RETIRED: `k2026a:${OLD}`,
    });
    expect(keyring?.retired.map((key) => key.id)).toEqual(['k2026a']);
    expect(Buffer.from(keyring?.retired[0]?.key ?? []).toString('base64')).toBe(OLD);
  });

  it.each([
    [{ FIRE_WATCH_ZONE_KEY_ID: 'k2026a' }, /configured together.*missing: FIRE_WATCH_ZONE_KEY$/],
    [{ FIRE_WATCH_ZONE_KEY: KEY }, /missing: FIRE_WATCH_ZONE_KEY_ID/],
    [{ FIRE_WATCH_ZONE_KEYS_RETIRED: `k2026a:${OLD}` }, /is set but FIRE_WATCH_ZONE_KEY_ID/],
    [{ FIRE_WATCH_ZONE_KEY_ID: 'k|1', FIRE_WATCH_ZONE_KEY: KEY }, /KEY_ID must be/],
    [
      { FIRE_WATCH_ZONE_KEY_ID: 'k1', FIRE_WATCH_ZONE_KEY: randomBytes(16).toString('base64') },
      /exactly 32 bytes/,
    ],
    [{ FIRE_WATCH_ZONE_KEY_ID: 'k1', FIRE_WATCH_ZONE_KEY: `${KEY.slice(0, -2)}!=` }, /base64/],
    [
      { FIRE_WATCH_ZONE_KEY_ID: 'k1', FIRE_WATCH_ZONE_KEY: KEY, FIRE_WATCH_ZONE_KEYS_RETIRED: OLD },
      /entry 1 is not/,
    ],
    [
      {
        FIRE_WATCH_ZONE_KEY_ID: 'k1',
        FIRE_WATCH_ZONE_KEY: KEY,
        FIRE_WATCH_ZONE_KEYS_RETIRED: `k1:${OLD}`,
      },
      /repeats/,
    ],
  ])('refuses %j', (env, message) => {
    expect(() => loadZonesConfig(env)).toThrow(ConfigError);
    expect(() => loadZonesConfig(env)).toThrow(message);
  });

  it('never quotes a key or a key id in an error', () => {
    const secret = randomBytes(24).toString('base64');
    const envs = [
      { FIRE_WATCH_ZONE_KEY_ID: 'k1', FIRE_WATCH_ZONE_KEY: secret },
      // The trailing '/' keeps the id invalid: 32 random base64 chars with no '+' or '/'
      // (about a third of draws) would otherwise be a well-formed key id and not throw.
      { FIRE_WATCH_ZONE_KEY_ID: `${secret}/`, FIRE_WATCH_ZONE_KEY: KEY },
      {
        FIRE_WATCH_ZONE_KEY_ID: 'k1',
        FIRE_WATCH_ZONE_KEY: KEY,
        FIRE_WATCH_ZONE_KEYS_RETIRED: `old:${secret}`,
      },
    ];
    for (const env of envs) {
      const failure = (() => {
        try {
          loadZonesConfig(env);
          return null;
        } catch (error) {
          return String(error);
        }
      })();
      expect(failure).not.toBeNull();
      expect(failure).not.toContain(secret);
      expect(failure).not.toContain(KEY);
    }
  });
});

describe('describeZonesConfig', () => {
  it('prints key ids and nothing else', () => {
    const keyring = loadZonesConfig({
      FIRE_WATCH_ZONE_KEY_ID: 'k2026b',
      FIRE_WATCH_ZONE_KEY: KEY,
      FIRE_WATCH_ZONE_KEYS_RETIRED: `k2026a:${OLD}`,
    });
    const described = JSON.stringify(describeZonesConfig(keyring));
    expect(described).toBe('{"zone_key_active":"k2026b","zone_keys_retired":["k2026a"]}');
    expect(describeZonesConfig(null)).toEqual({ zone_keys: 'unset' });
  });
});
