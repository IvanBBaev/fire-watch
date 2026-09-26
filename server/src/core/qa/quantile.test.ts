import { describe, expect, it } from 'vitest';

import { quantileOf, rankFor } from './quantile.js';

const P95 = 0.95;
const P50 = 0.5;

describe('nearest-rank inclusive', () => {
  it('returns an observation, never an interpolation between two', () => {
    const samples = [10, 20, 30, 40];
    const value = quantileOf(samples, P95).value;
    expect(samples).toContain(value);
    expect(value).toBe(40);
  });

  it('sorts the sample, so the order rows were read in cannot change the answer', () => {
    const ascending = quantileOf([1, 2, 3, 100], P50);
    const scrambled = quantileOf([100, 3, 1, 2], P50);
    expect(scrambled.value).toBe(ascending.value);
    // The default `sort` compares string forms; 100 would sort before 20.
    expect(quantileOf([20, 100], P50).value).toBe(20);
  });

  it('places the rank at ceil(p · n)', () => {
    expect(rankFor(20, P95)).toBe(19);
    expect(rankFor(21, P95)).toBe(20);
    expect(rankFor(100, P95)).toBe(95);
    expect(rankFor(10, P50)).toBe(5);
  });
});

describe('a sample too small for the quantile to mean anything', () => {
  it('says so rather than pretending a p95 exists: n ≤ 19 makes it the maximum', () => {
    const samples = Array.from({ length: 19 }, (_unused, index) => index + 1);
    const p95 = quantileOf(samples, P95);
    expect(p95.n).toBe(19);
    expect(p95.rank).toBe(19);
    expect(p95.value).toBe(19);
    expect(p95.isMaximum).toBe(true);
  });

  it('stops being the maximum exactly at n = 20', () => {
    const samples = Array.from({ length: 20 }, (_unused, index) => index + 1);
    const p95 = quantileOf(samples, P95);
    expect(p95.rank).toBe(19);
    expect(p95.value).toBe(19);
    expect(p95.isMaximum).toBe(false);
  });

  it('reports an empty sample as absent, not as zero latency', () => {
    const p95 = quantileOf([], P95);
    expect(p95.n).toBe(0);
    expect(p95.value).toBeNull();
    expect(p95.rank).toBeNull();
    expect(p95.isMaximum).toBe(false);
  });
});

describe('input validation', () => {
  it('refuses a probability outside (0, 1]', () => {
    expect(() => quantileOf([1], 0)).toThrow(RangeError);
    expect(() => quantileOf([1], 1.5)).toThrow(RangeError);
  });

  it('refuses a non-finite sample rather than sorting NaN into the middle', () => {
    expect(() => quantileOf([1, Number.NaN], P50)).toThrow(/must be finite/);
  });

  it('carries the method it used, so a report never has to assume one', () => {
    expect(quantileOf([1], P95).method).toBe('nearest_rank_inclusive');
  });
});
