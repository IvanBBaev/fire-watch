import { describe, expect, it } from 'vitest';

import { isInQuietHours } from '../alerts/alert-decision.js';
import { ALERT_GATING, minuteOfDay } from './alert-gating.js';
import { DIGEST_PARAMS } from './digest-params.js';
import { CONFIG_VERSION_RE, configDigest } from './versioned-config.js';

const PARAMS = DIGEST_PARAMS.values;

describe('digest_params_v1 identity', () => {
  it('carries a version the replay fixtures can validate', () => {
    expect(DIGEST_PARAMS.name).toBe('digest_params');
    expect(DIGEST_PARAMS.version).toBe('digest_params_v1');
    expect(DIGEST_PARAMS.version).toMatch(CONFIG_VERSION_RE);
  });

  it('pins the digest, because a refit that forgot to bump the version is invisible', () => {
    // The window start is the digest's idempotency subkey (A1.11). An hour moved without a
    // version bump re-keys every digest ever sent, so the same fire can be summarised twice
    // under two different windows — the one failure a digest exists to prevent.
    expect(DIGEST_PARAMS.digest).toBe(configDigest(PARAMS));
    expect(DIGEST_PARAMS.digest).toBe('0d770cd4');
  });

  it('is frozen, so a run cannot move the window it is being judged by', () => {
    expect(Object.isFrozen(DIGEST_PARAMS)).toBe(true);
    expect(Object.isFrozen(PARAMS)).toBe(true);
  });
});

describe('the window the product actually promises', () => {
  it('opens at 09:00 local, the hour D4 names', () => {
    expect(PARAMS.windowHour).toBe(9);
    expect(PARAMS.windowMinute).toBe(0);
  });

  it('sits outside the default quiet hours by construction, not by exception', () => {
    // A1.7 applies quiet hours to `digest` as well as `escalation`, and 07 §5.5.3 says the
    // digest never overrides them. Both statements are only livable because 09:00 is not in
    // 22:00–07:00: if the default window moved into the default quiet hours, the default
    // account would never receive a digest at all.
    const zone = {
      zoneId: 'z',
      minScore: 0.45,
      timezone: ALERT_GATING.values.quietHours.timezone,
      quietHoursStart: ALERT_GATING.values.quietHours.start,
      quietHoursEnd: ALERT_GATING.values.quietHours.end,
      newFireOverridesQuietHours: true,
      distanceKm: 1,
    };
    // 2026-08-20T06:00:00Z is 09:00 in Europe/Sofia (UTC+3 in summer).
    expect(isInQuietHours(Date.parse('2026-08-20T06:00:00Z'), zone)).toBe(false);

    const windowMinute = PARAMS.windowHour * 60 + PARAMS.windowMinute;
    const quietStart = minuteOfDay(ALERT_GATING.values.quietHours.start);
    const quietEnd = minuteOfDay(ALERT_GATING.values.quietHours.end);
    expect(windowMinute).toBeGreaterThanOrEqual(quietEnd);
    expect(windowMinute).toBeLessThan(quietStart);
  });

  it('is a whole minute of a real day, so a local date plus this time is addressable', () => {
    expect(Number.isInteger(PARAMS.windowHour)).toBe(true);
    expect(Number.isInteger(PARAMS.windowMinute)).toBe(true);
    expect(PARAMS.windowHour).toBeGreaterThanOrEqual(0);
    expect(PARAMS.windowHour).toBeLessThan(24);
    expect(PARAMS.windowMinute).toBeGreaterThanOrEqual(0);
    expect(PARAMS.windowMinute).toBeLessThan(60);
  });
});
