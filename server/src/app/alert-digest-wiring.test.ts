import { randomBytes } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import type { AlertDigestRouting } from '../core/ports/alert-digest-routing.js';
import { ALERT_DIGEST_CADENCE, wireAlertDigest } from './alert-digest-wiring.js';
import { ConfigError, loadConfig, type Environment } from './config.js';

const base: Environment = {
  DATABASE_URL: 'postgres://fire_watch:hunter2@db.internal:5432/fire_watch',
  FIRMS_MAP_KEY: 'testtesttesttesttesttesttesttest',
};
const keyed: Environment = {
  ...base,
  FIRE_WATCH_ZONE_KEY_ID: 'k2026a',
  FIRE_WATCH_ZONE_KEY: randomBytes(32).toString('base64'),
};

const routing: AlertDigestRouting = {
  targetFor: () => Promise.resolve(null),
  digestCopyFor: () => null,
};
const cadence = { intervalMs: 300_000, accountPageSize: 200 };

describe('wireAlertDigest', () => {
  it('ships with no ratified cadence', () => {
    expect(ALERT_DIGEST_CADENCE).toEqual({ intervalMs: null, accountPageSize: null });
  });

  it('is disabled with every blocker named, and does not throw, with nothing configured', () => {
    expect(wireAlertDigest(loadConfig(base), base)).toEqual({
      enabled: false,
      blockers: ['zone_keyring_unset', 'digest_routing_unarmed', 'cadence_unratified'],
    });
  });

  it('stays disabled with keys but no routing, which is every deployment today', () => {
    expect(wireAlertDigest(loadConfig(keyed), keyed, { cadence })).toEqual({
      enabled: false,
      blockers: ['digest_routing_unarmed'],
    });
  });

  it('names a half-ratified cadence as unratified', () => {
    const wiring = wireAlertDigest(loadConfig(keyed), keyed, {
      routing,
      cadence: { intervalMs: 300_000, accountPageSize: null },
    });
    expect(wiring).toEqual({ enabled: false, blockers: ['cadence_unratified'] });
  });

  it('still fails loudly on a malformed keyring', () => {
    const bad = { ...base, FIRE_WATCH_ZONE_KEY_ID: 'k2026a', FIRE_WATCH_ZONE_KEY: 'short' };
    expect(() => wireAlertDigest(loadConfig(base), bad)).toThrow(ConfigError);
  });

  it('wires the cycle without connecting once every blocker is gone', async () => {
    const wiring = wireAlertDigest(loadConfig(keyed), keyed, { routing, cadence });
    expect(wiring.enabled).toBe(true);
    if (!wiring.enabled) return;
    expect(wiring.intervalMs).toBe(300_000);
    expect(wiring.deps.accountPageSize).toBe(200);
    expect(wiring.deps.routing).toBe(routing);
    await expect(wiring.close()).resolves.toBeUndefined();
  });
});
