import { describe, expect, it } from 'vitest';

import { QA_METRICS } from './qa-metrics-params.js';
import { UNMEASURED, meetsAtLeast, meetsAtMost, quantizeRate, rateOf } from './rate.js';

describe('rateOf', () => {
  it('reports the arithmetic, not just the answer', () => {
    const rate = rateOf(19, 20);
    expect(rate.numerator).toBe(19);
    expect(rate.denominator).toBe(20);
    expect(rate.rate).toBe(0.95);
  });

  it('reports an empty denominator as absent — never as 0 and never as 1', () => {
    const rate = rateOf(0, 0);
    expect(rate.rate).toBeNull();
    expect(rate).toEqual(UNMEASURED);
    // The two readings an absent rate must not be silently given.
    expect(rate.rate).not.toBe(0);
    expect(rate.rate).not.toBe(1);
  });

  it('judges nothing when there was nothing to measure', () => {
    expect(meetsAtLeast(rateOf(0, 0), 0.95)).toBeNull();
    expect(meetsAtMost(rateOf(0, 0), 0.05)).toBeNull();
  });

  it('refuses a numerator larger than its denominator', () => {
    expect(() => rateOf(3, 2)).toThrow(RangeError);
  });

  it('refuses fractional counts — a rate here always counts whole things', () => {
    expect(() => rateOf(1.5, 3)).toThrow(/non-negative integer/);
    expect(() => rateOf(-1, 3)).toThrow(/non-negative integer/);
  });
});

describe('target comparison', () => {
  it('lets a rate sit exactly on its target and pass', () => {
    expect(meetsAtLeast(rateOf(19, 20), 0.95)).toBe(true);
    expect(meetsAtMost(rateOf(1, 20), 0.05)).toBe(true);
  });

  it('quantizes first, so a sum of doubles cannot miss a threshold it reached', () => {
    // 1/3 of 3 is not 0.3333333333333333 in double arithmetic below the quantum, and a
    // bare comparison against a written-down target is a coin toss at the boundary.
    const target = quantizeRate(0.1 + 0.2);
    expect(target).toBe(quantizeRate(0.3));
    expect(meetsAtMost(rateOf(3, 10), 0.1 + 0.2)).toBe(true);
  });

  it('fails a rate that is genuinely past the target', () => {
    expect(meetsAtLeast(rateOf(18, 20), 0.95)).toBe(false);
    expect(meetsAtMost(rateOf(2, 20), 0.05)).toBe(false);
  });

  it('refuses a non-finite rate rather than comparing NaN against a threshold', () => {
    expect(() => quantizeRate(Number.NaN, QA_METRICS.values)).toThrow(RangeError);
  });
});
