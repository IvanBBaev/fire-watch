import { describe, expect, it } from 'vitest';

import {
  breakerThreshold,
  dispatchAllowance,
  type DispatchAllowance,
  type DispatchAllowanceInput,
  type DispatchControlState,
} from './dispatch-breaker.js';
import { ALERT_BUDGETS, type AlertBudgetParams } from '../config/alert-budgets.js';

const RUNNING: DispatchControlState = { killSwitch: false, breakerLatched: false };

function budgets(patch: Partial<AlertBudgetParams>): AlertBudgetParams {
  return { ...ALERT_BUDGETS.values, ...patch };
}

/** The shipped budgets with the breaker's missing floor supplied, which arms it. */
function withFloor(floor: number, patch: Partial<AlertBudgetParams> = {}): AlertBudgetParams {
  return budgets({ breaker: { ratio: 5, floorSendsPerWindow: floor }, ...patch });
}

function allowance(patch: Partial<DispatchAllowanceInput> = {}): DispatchAllowance {
  return dispatchAllowance({
    control: RUNNING,
    sendsInWindow: 0,
    baselineSendsPerWindow: null,
    batchSize: 25,
    ...patch,
  });
}

/** Narrow to the open branch, so a halt fails the assertion instead of typing as `never`. */
function claimLimit(verdict: DispatchAllowance): number {
  if (verdict.state !== 'open') {
    throw new Error(`expected an open allowance, got a halt for ${verdict.reason}`);
  }
  return verdict.claimLimit;
}

describe('breakerThreshold — max(5x seasonal baseline, floor)', () => {
  it('is null while no floor is pinned, whatever the baseline says', () => {
    // The reported gap: no document gives the floor a value, so the ratio leg alone never
    // arms. Five times a baseline of two is ten, and the first real fire of a quiet spring
    // would otherwise halt dispatch.
    expect(breakerThreshold(2, { ratio: 5, floorSendsPerWindow: null })).toBeNull();
    expect(breakerThreshold(null, { ratio: 5, floorSendsPerWindow: null })).toBeNull();
  });

  it('lets the floor stand alone when there is no history to compare against', () => {
    expect(breakerThreshold(null, { ratio: 5, floorSendsPerWindow: 200 })).toBe(200);
  });

  it('takes the larger of the two legs', () => {
    expect(breakerThreshold(100, { ratio: 5, floorSendsPerWindow: 200 })).toBe(500);
    expect(breakerThreshold(10, { ratio: 5, floorSendsPerWindow: 200 })).toBe(200);
  });
});

describe('the breaker ships unarmed', () => {
  it('reports itself unarmed and does not trip on a rate far above the baseline', () => {
    // 1,500 sends against a seasonal baseline of two. An armed breaker would have halted
    // this long ago; G is the ceiling that is actually holding.
    const verdict = allowance({ sendsInWindow: 1_500, baselineSendsPerWindow: 2 });

    expect(verdict.state).toBe('open');
    expect(verdict.breaker).toEqual({
      state: 'unarmed',
      threshold: null,
      baseline: 2,
      ratio: 5,
      floor: null,
    });
    expect(claimLimit(verdict)).toBe(25);
  });
});

describe('halt precedence', () => {
  it('puts the kill switch above every other reason', () => {
    const verdict = allowance({
      control: { killSwitch: true, breakerLatched: true },
      sendsInWindow: null,
    });

    expect(verdict).toMatchObject({ state: 'halted', reason: 'kill_switch', pages: false });
    // The latch is still reported even though it did not decide the verdict.
    expect(verdict.breaker.state).toBe('latched');
  });

  it('does not page for either halt a human asked for', () => {
    // A deliberate stop needs no page. Every other halt does: a silent stop is the worst
    // failure this product has.
    expect(allowance({ control: { killSwitch: true, breakerLatched: false } })).toMatchObject({
      pages: false,
      breaker: { state: 'unarmed' },
    });
    expect(allowance({ control: { killSwitch: false, breakerLatched: true } })).toMatchObject({
      state: 'halted',
      reason: 'breaker_latched',
      pages: false,
      breaker: { state: 'latched' },
    });
  });

  it('keeps a latched breaker latched even though the rate has since fallen', () => {
    // "Release is manual after inspection" — re-evaluating the live rate would close it.
    expect(
      allowance({
        control: { killSwitch: false, breakerLatched: true },
        sendsInWindow: 0,
        params: withFloor(200),
      }),
    ).toMatchObject({ state: 'halted', reason: 'breaker_latched' });
  });

  it('halts and pages when the send rate cannot be measured', () => {
    // An unenforceable ceiling is not a ceiling.
    expect(allowance({ sendsInWindow: null })).toMatchObject({
      state: 'halted',
      reason: 'unknown_send_rate',
      pages: true,
    });
  });

  it('halts on G before it consults the breaker', () => {
    const verdict = allowance({
      sendsInWindow: 2_000,
      baselineSendsPerWindow: 1,
      params: withFloor(200),
    });

    expect(verdict).toMatchObject({
      state: 'halted',
      reason: 'global_budget_exhausted',
      pages: true,
    });
    expect(verdict.state === 'halted' && verdict.detail).toContain('600s');
    expect(verdict.state === 'halted' && verdict.detail).toContain('2000');
  });

  it('spends G at the ceiling, not one send past it', () => {
    expect(allowance({ sendsInWindow: 1_999 }).state).toBe('open');
    expect(allowance({ sendsInWindow: 2_000 })).toMatchObject({
      reason: 'global_budget_exhausted',
    });
  });

  it('trips an armed breaker one send above its threshold, and pages', () => {
    expect(allowance({ sendsInWindow: 200, params: withFloor(200) }).state).toBe('open');

    const verdict = allowance({ sendsInWindow: 201, params: withFloor(200) });
    expect(verdict).toMatchObject({
      state: 'halted',
      reason: 'send_rate_anomaly',
      pages: true,
      breaker: { state: 'tripped', threshold: 200, floor: 200 },
    });
    expect(verdict.state === 'halted' && verdict.detail).toContain('by hand');
  });
});

describe('the claim limit', () => {
  it('is the batch size when both guards have room', () => {
    expect(claimLimit(allowance({ sendsInWindow: 10, batchSize: 25 }))).toBe(25);
  });

  it('is capped by what is left under G', () => {
    expect(claimLimit(allowance({ sendsInWindow: 1_990, batchSize: 25 }))).toBe(10);
  });

  it('is capped by what is left under an armed breaker', () => {
    expect(
      claimLimit(allowance({ sendsInWindow: 195, batchSize: 25, params: withFloor(200) })),
    ).toBe(5);
  });

  it('rounds a fractional threshold down rather than claiming into it', () => {
    // 5 x 40.5 = 202.5, above the floor. 201 sends is under the threshold, so nothing has
    // tripped, and exactly one more send fits below the whole number.
    const verdict = allowance({
      sendsInWindow: 201,
      baselineSendsPerWindow: 40.5,
      params: withFloor(200),
    });

    expect(verdict.breaker.threshold).toBe(202.5);
    expect(claimLimit(verdict)).toBe(1);
  });

  it('can be zero while the verdict stays open, because nothing is wrong', () => {
    // A guard holding without having tripped. The next cycle, with an older window, will
    // have headroom again — there is nothing here for a human to do.
    const verdict = allowance({ sendsInWindow: 200, params: withFloor(200) });

    expect(verdict.state).toBe('open');
    expect(claimLimit(verdict)).toBe(0);
    expect(verdict.breaker.state).toBe('armed');
  });
});

describe('no runtime knob can raise the ceilings', () => {
  it('enforces the G in git against a caller who claims a larger one', () => {
    expect(
      allowance({ sendsInWindow: 2_000, params: budgets({ globalWindowSends: 100_000 }) }),
    ).toMatchObject({ state: 'halted', reason: 'global_budget_exhausted' });
  });

  it('honours a caller-supplied G smaller than the one in git', () => {
    expect(
      allowance({ sendsInWindow: 100, params: budgets({ globalWindowSends: 100 }) }),
    ).toMatchObject({ state: 'halted', reason: 'global_budget_exhausted' });
  });

  it('refuses a shortened window, which would raise the rate G allows', () => {
    const verdict = allowance({
      sendsInWindow: 2_000,
      params: budgets({ globalWindowMs: 60_000 }),
    });

    expect(verdict.state === 'halted' && verdict.detail).toContain('600s');
  });

  it('enforces the ratio in git against a caller who claims a larger one', () => {
    // A claimed ratio of 100 against a baseline of 100 would put the threshold at 10,000.
    // Clamped to 5, it is 500, and 501 sends trip.
    const verdict = allowance({
      sendsInWindow: 501,
      baselineSendsPerWindow: 100,
      params: withFloor(200, { breaker: { ratio: 100, floorSendsPerWindow: 200 } }),
    });

    expect(verdict.breaker.threshold).toBe(500);
    expect(verdict).toMatchObject({ state: 'halted', reason: 'send_rate_anomaly' });
  });
});

describe('malformed counts throw rather than halt', () => {
  it('rejects a batch size that is not a positive integer', () => {
    expect(() => allowance({ batchSize: 0 })).toThrow(RangeError);
    expect(() => allowance({ batchSize: 1.5 })).toThrow(RangeError);
  });

  it('rejects a send count that is not a non-negative integer', () => {
    expect(() => allowance({ sendsInWindow: -1 })).toThrow(RangeError);
    expect(() => allowance({ sendsInWindow: Number.NaN })).toThrow(RangeError);
  });

  it('rejects a baseline that is negative or non-finite', () => {
    expect(() => allowance({ baselineSendsPerWindow: -1 })).toThrow(RangeError);
    expect(() => allowance({ baselineSendsPerWindow: Number.POSITIVE_INFINITY })).toThrow(
      RangeError,
    );
  });
});
