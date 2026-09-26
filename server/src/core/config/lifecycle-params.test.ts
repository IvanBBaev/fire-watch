import { SOURCE_IDS, SOURCE_REGISTRY } from '@fire-watch/contracts';
import { describe, expect, it } from 'vitest';

import { DIURNAL_PHASES } from '../ports/pass-predictor.js';
import { LIFECYCLE_PARAMS, quantizeE } from './lifecycle-params.js';
import { CONFIG_VERSION_RE, configDigest } from './versioned-config.js';

const PARAMS = LIFECYCLE_PARAMS.values;

describe('lifecycle_params_v1 identity', () => {
  it('carries a version the replay fixtures can validate', () => {
    expect(LIFECYCLE_PARAMS.name).toBe('lifecycle_params');
    expect(LIFECYCLE_PARAMS.version).toMatch(CONFIG_VERSION_RE);
  });

  it('pins the digest, because a refit that forgot to bump the version is invisible', () => {
    expect(LIFECYCLE_PARAMS.digest).toBe(configDigest(PARAMS));
    expect(LIFECYCLE_PARAMS.digest).toBe('2f44eb3f');
  });

  it('is frozen, so a tick cannot tune the parameters it is being judged by', () => {
    expect(Object.isFrozen(LIFECYCLE_PARAMS)).toBe(true);
    expect(Object.isFrozen(PARAMS)).toBe(true);
  });
});

describe('pass miss weights', () => {
  it('covers every registry id, including retired ones a replay still needs', () => {
    expect(Object.keys(PARAMS.passMissWeights).slice().sort()).toEqual(SOURCE_IDS.slice().sort());
  });

  it('maps exactly the geostationary sources to null — they have no pass to miss', () => {
    const withoutWeight = SOURCE_IDS.filter((id) => PARAMS.passMissWeights[id] === null);
    const geostationary = SOURCE_IDS.filter((id) => SOURCE_REGISTRY[id].productTier === 'GEO');
    expect(withoutWeight).toEqual(geostationary);
    expect(geostationary).toEqual(['lsasaf:seviri:frp-pixel', 'lsasaf:fci:frp-pixel']);
  });

  it('weighs both halves of the day for every polar source, and weighs night no lighter', () => {
    for (const id of SOURCE_IDS) {
      const weight = PARAMS.passMissWeights[id];
      if (weight === null) continue;
      for (const phase of DIURNAL_PHASES) {
        // A zero weight would be a source that can never contribute evidence, which is a
        // decision to remove it from the table rather than to weigh it at nothing.
        expect(weight[phase]).toBeGreaterThan(0);
      }
      // A night miss is at least as strong as a day miss: the thermal contrast is better
      // by night, so failing to see a fire then says more.
      expect(weight.night).toBeGreaterThanOrEqual(weight.day);
    }
  });
});

describe('thresholds and gates', () => {
  it('asks for more evidence before closing a large event', () => {
    expect(PARAMS.eThresholdLarge).toBeGreaterThan(PARAMS.eThreshold);
    expect(PARAMS.eThreshold).toBeGreaterThan(0);
  });

  it('orders the cloud gate bands, so half weight sits strictly below the block', () => {
    expect(PARAMS.cloudGate.halfWeightFromPercent).toBeLessThan(PARAMS.cloudGate.blockAbovePercent);
    expect(PARAMS.cloudGate.halfWeightFromPercent).toBeGreaterThan(0);
    expect(PARAMS.cloudGate.blockAbovePercent).toBeLessThanOrEqual(100);
    expect(PARAMS.cloudGate.halfWeightFactor).toBeGreaterThan(0);
    expect(PARAMS.cloudGate.halfWeightFactor).toBeLessThan(1);
  });

  it('caps a whole day of GEO slots below the weight of one missed VIIRS night pass', () => {
    const slotsPerDay = (24 * 60) / PARAMS.geoSlot.slotMinutes;
    expect(slotsPerDay * PARAMS.geoSlot.weightPerSlot).toBeGreaterThan(
      PARAMS.geoSlot.dailyCapWeight,
    );
    const viirsNight = PARAMS.passMissWeights['firms:viirs:snpp']?.night ?? 0;
    expect(PARAMS.geoSlot.dailyCapWeight).toBeLessThan(viirsNight);
  });

  it('needs several days of misses to reach the threshold, never a single cloudy hour', () => {
    const viirs = PARAMS.passMissWeights['firms:viirs:snpp'];
    expect(viirs).not.toBeNull();
    expect(viirs?.day ?? 0).toBeLessThan(PARAMS.eThreshold);
    expect(viirs?.night ?? 0).toBeLessThan(PARAMS.eThreshold);
  });

  it('keeps the non-tradeable conditions alongside E', () => {
    expect(PARAMS.requireBothDiurnalPhases).toBe(true);
    expect(PARAMS.minHoursSinceLastDetection).toBeGreaterThan(0);
    // The hard unobservability fallback must be far longer than the evidence path it
    // backstops, or it would close events the E rule was still gathering evidence about.
    expect(PARAMS.unobservableDays * 24).toBeGreaterThan(PARAMS.minHoursSinceLastDetection);
  });

  it('keeps the display windows ordered — the map window inside the active feed', () => {
    expect(PARAMS.mapWindowHours).toBeLessThan(PARAMS.activeFeedHours);
    expect(PARAMS.mapWindowHours).toBeGreaterThanOrEqual(PARAMS.minHoursSinceLastDetection);
  });

  it('allows a large event a looser false-end rate than a small one', () => {
    expect(PARAMS.ferMaxRateLarge).toBeGreaterThan(PARAMS.ferMaxRate);
    expect(PARAMS.ferMaxRate).toBeGreaterThan(0);
    expect(PARAMS.ferMaxRateLarge).toBeLessThan(1);
    expect(PARAMS.ferWindowHours).toBeGreaterThan(0);
  });
});

describe('quantizeE', () => {
  /** The weights a week of misses is actually made of: one day, one night, 15 GEO slots. */
  const PARTS: readonly number[] = [1.0, 1.25, ...new Array<number>(15).fill(0.05)];

  it('makes "exactly the threshold" a state the accumulator can reach', () => {
    const forwards = PARTS.reduce((sum, part) => sum + part, 0);
    // The raw sum lands 2.7e-15 short of 3.0, so a bare `>=` would refuse to close an
    // event that has in fact accumulated exactly the threshold.
    expect(forwards).not.toBe(PARAMS.eThreshold);
    expect(forwards >= PARAMS.eThreshold).toBe(false);
    expect(quantizeE(forwards)).toBe(PARAMS.eThreshold);
    expect(quantizeE(forwards) >= PARAMS.eThreshold).toBe(true);
  });

  it('erases the accumulation order, which float addition otherwise keeps', () => {
    const forwards = PARTS.reduce((sum, part) => sum + part, 0);
    const backwards = PARTS.slice()
      .reverse()
      .reduce((sum, part) => sum + part, 0);
    // Two orders of the same day's evidence; only one of them hits 3.0 exactly.
    expect(backwards).not.toBe(forwards);
    expect(quantizeE(backwards)).toBe(quantizeE(forwards));
  });

  it('leaves a difference the quantum can actually represent alone', () => {
    expect(quantizeE(PARAMS.eThreshold - PARAMS.eQuantum)).toBeLessThan(PARAMS.eThreshold);
    expect(quantizeE(0)).toBe(0);
  });

  it('refuses a non-finite E rather than comparing NaN against a threshold', () => {
    expect(() => quantizeE(Number.NaN)).toThrow(RangeError);
    expect(() => quantizeE(Number.POSITIVE_INFINITY)).toThrow(/must be finite/);
    expect(() => quantizeE(Number.NEGATIVE_INFINITY)).toThrow(/must be finite/);
  });
});
