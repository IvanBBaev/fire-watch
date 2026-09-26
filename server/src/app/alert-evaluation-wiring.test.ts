import { randomBytes } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import type { AlertRouting } from '../core/ports/alert-routing.js';
import {
  ALERT_EVALUATION_CADENCE,
  ALERT_EVALUATION_GAPS,
  wireAlertEvaluation,
} from './alert-evaluation-wiring.js';
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

const routing: AlertRouting = {
  targetFor: () => Promise.resolve(null),
  copyFor: () => null,
};
const cadence = { intervalMs: 1_000, batchLimit: 10, maxBatchesPerCycle: 2 };

describe('wireAlertEvaluation', () => {
  it('ships with no ratified cadence', () => {
    expect(ALERT_EVALUATION_CADENCE).toEqual({
      intervalMs: null,
      batchLimit: null,
      maxBatchesPerCycle: null,
    });
  });

  it('is disabled with every blocker named, and does not throw, with nothing configured', () => {
    const wiring = wireAlertEvaluation(loadConfig(base), base);
    expect(wiring).toEqual({
      enabled: false,
      blockers: ['zone_keyring_unset', 'alert_routing_unarmed', 'cadence_unratified'],
      gaps: [...ALERT_EVALUATION_GAPS],
    });
  });

  it('names only the keyring when that is all that is missing', () => {
    const wiring = wireAlertEvaluation(loadConfig(base), base, { routing, cadence });
    expect(wiring.enabled).toBe(false);
    if (!wiring.enabled) expect(wiring.blockers).toEqual(['zone_keyring_unset']);
  });

  it('stays disabled with keys but no routing, which is every deployment today', () => {
    const wiring = wireAlertEvaluation(loadConfig(keyed), keyed, { cadence });
    expect(wiring.enabled).toBe(false);
    if (!wiring.enabled) expect(wiring.blockers).toEqual(['alert_routing_unarmed']);
  });

  it('still fails loudly on a malformed keyring', () => {
    const bad = { ...base, FIRE_WATCH_ZONE_KEY_ID: 'k2026a', FIRE_WATCH_ZONE_KEY: 'short' };
    expect(() => wireAlertEvaluation(loadConfig(base), bad)).toThrow(ConfigError);
  });

  it('wires the cycle without connecting once every blocker is gone', async () => {
    const wiring = wireAlertEvaluation(loadConfig(keyed), keyed, { routing, cadence });
    expect(wiring.enabled).toBe(true);
    if (!wiring.enabled) return;
    expect(wiring.intervalMs).toBe(1_000);
    expect(wiring.deps.batchLimit).toBe(10);
    expect(wiring.deps.maxBatchesPerCycle).toBe(2);
    expect(wiring.deps.routing).toBe(routing);
    expect(wiring.gaps).toEqual([...ALERT_EVALUATION_GAPS]);
    await expect(wiring.close()).resolves.toBeUndefined();
  });

  it('drops the digest gap once the worker runs the digest loop', async () => {
    const wiring = wireAlertEvaluation(loadConfig(keyed), keyed, {
      routing,
      cadence,
      digestEnabled: true,
    });
    expect(wiring.gaps).toEqual([]);
    if (wiring.enabled) await wiring.close();
    const disabled = wireAlertEvaluation(loadConfig(base), base, { digestEnabled: true });
    expect(disabled.gaps).toEqual([]);
  });
});
