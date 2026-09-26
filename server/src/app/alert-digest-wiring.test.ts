import { randomBytes } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import type { AlertDigestRouting } from '../core/ports/alert-digest-routing.js';
import { ALERT_DIGEST_CADENCE, wireAlertDigest } from './alert-digest-wiring.js';
import { wireAlertEvaluation } from './alert-evaluation-wiring.js';
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
const cadence = { intervalMs: 60_000, accountPageSize: 50 };

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

  it('names only what is missing', () => {
    const noKeys = wireAlertDigest(loadConfig(base), base, { routing, cadence });
    const noRouting = wireAlertDigest(loadConfig(keyed), keyed, { cadence });
    const halfCadence = wireAlertDigest(loadConfig(keyed), keyed, {
      routing,
      cadence: { intervalMs: 60_000, accountPageSize: null },
    });
    expect(noKeys).toEqual({ enabled: false, blockers: ['zone_keyring_unset'] });
    expect(noRouting).toEqual({ enabled: false, blockers: ['digest_routing_unarmed'] });
    expect(halfCadence).toEqual({ enabled: false, blockers: ['cadence_unratified'] });
  });

  it('still fails loudly on a malformed keyring', () => {
    const bad = { ...base, FIRE_WATCH_ZONE_KEY_ID: 'k2026a', FIRE_WATCH_ZONE_KEY: 'short' };
    expect(() => wireAlertDigest(loadConfig(base), bad)).toThrow(ConfigError);
  });

  it('wires the cycle without connecting once every blocker is gone', async () => {
    const wiring = wireAlertDigest(loadConfig(keyed), keyed, { routing, cadence });
    expect(wiring.enabled).toBe(true);
    if (!wiring.enabled) return;
    expect(wiring.intervalMs).toBe(60_000);
    expect(wiring.deps.accountPageSize).toBe(50);
    expect(wiring.deps.routing).toBe(routing);
    await expect(wiring.close()).resolves.toBeUndefined();
  });
});

describe('the evaluation loop gap it closes', () => {
  it('is reported by the evaluation wiring unless the digest pass runs beside it', () => {
    const without = wireAlertEvaluation(loadConfig(base), base);
    const beside = wireAlertEvaluation(loadConfig(base), base, { digestEnabled: true });
    expect(without.gaps).toEqual(['digest_pass_disabled']);
    expect(beside.gaps).toEqual([]);
  });
});
