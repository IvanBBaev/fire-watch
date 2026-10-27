import { randomBytes } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { ConfigError } from './config.js';
import { describeWebhooksConfig, loadWebhooksConfig } from './webhooks-config.js';

/** Generated per run: never a real key. */
const KEY = randomBytes(32).toString('base64');
const OLD = randomBytes(32).toString('base64');

describe('loadWebhooksConfig', () => {
  it('is null when nothing is configured', () => {
    expect(loadWebhooksConfig({})).toBeNull();
  });

  it('reads the active and retired keys under their own variables', () => {
    const keyring = loadWebhooksConfig({
      FIRE_WATCH_WEBHOOK_KEY_ID: 'wh2026b',
      FIRE_WATCH_WEBHOOK_KEY: KEY,
      FIRE_WATCH_WEBHOOK_KEYS_RETIRED: `wh2026a:${OLD}`,
    });
    expect(keyring?.active.id).toBe('wh2026b');
    expect(Buffer.from(keyring?.active.key ?? []).toString('base64')).toBe(KEY);
    expect(keyring?.retired.map((key) => key.id)).toEqual(['wh2026a']);
  });

  it('ignores the zone keyring', () => {
    expect(
      loadWebhooksConfig({ FIRE_WATCH_ZONE_KEY_ID: 'k1', FIRE_WATCH_ZONE_KEY: KEY }),
    ).toBeNull();
  });

  it('refuses a half-configured key without quoting it', () => {
    let caught: unknown;
    try {
      loadWebhooksConfig({ FIRE_WATCH_WEBHOOK_KEY: KEY });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ConfigError);
    expect(String(caught)).toMatch(/FIRE_WATCH_WEBHOOK_KEY_ID/);
    expect(String(caught)).not.toContain(KEY);
  });
});

describe('describeWebhooksConfig', () => {
  it('prints key ids only', () => {
    expect(describeWebhooksConfig(null)).toEqual({ webhook_keys: 'unset' });
    const keyring = loadWebhooksConfig({
      FIRE_WATCH_WEBHOOK_KEY_ID: 'wh2026b',
      FIRE_WATCH_WEBHOOK_KEY: KEY,
    });
    const described = describeWebhooksConfig(keyring);
    expect(described).toEqual({ webhook_key_active: 'wh2026b', webhook_keys_retired: [] });
    expect(JSON.stringify(described)).not.toContain(KEY);
  });
});
