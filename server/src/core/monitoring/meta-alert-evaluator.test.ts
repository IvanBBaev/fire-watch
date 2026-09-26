import { describe, expect, it } from 'vitest';

import {
  evaluateMetaAlert,
  INITIAL_META_ALERT_STATE,
  type MetaAlertState,
  type MetaAlertStep,
} from './meta-alert-evaluator.js';
import type { MetaAlertRule } from './meta-alert-params.js';

const RULE: MetaAlertRule = { pageAbove: 600, clearAtOrBelow: 600, pageAfter: 2, clearAfter: 2 };
const BANDED: MetaAlertRule = { pageAbove: 600, clearAtOrBelow: 300, pageAfter: 2, clearAfter: 2 };
const UNARMED: MetaAlertRule = {
  pageAbove: null,
  clearAtOrBelow: null,
  pageAfter: 2,
  clearAfter: 2,
};

/** Feeds readings one per minute and returns every step. */
function feed(rule: MetaAlertRule, readings: readonly (number | null)[]): MetaAlertStep[] {
  let state: MetaAlertState = INITIAL_META_ALERT_STATE;
  return readings.map((reading, i) => {
    const step = evaluateMetaAlert(rule, reading, state, i * 60_000);
    state = step.state;
    return step;
  });
}

describe('evaluateMetaAlert', () => {
  it('pages only after two consecutive breaching readings', () => {
    const steps = feed(RULE, [601, 601]);
    expect(steps.map((s) => s.transition)).toEqual([null, 'page']);
    expect(steps.map((s) => s.status)).toEqual(['breaching', 'paging']);
    expect(steps[1]?.state.pagingSince).toBe(60_000);
  });

  it('does not page on a single spike between healthy readings', () => {
    const steps = feed(RULE, [601, 10, 601, 10]);
    expect(steps.every((s) => s.transition === null)).toBe(true);
    expect(steps.every((s) => !s.state.paging)).toBe(true);
  });

  it('treats exactly the threshold as healthy (pages strictly above)', () => {
    expect(feed(RULE, [600, 600, 600]).every((s) => !s.state.paging)).toBe(true);
  });

  it('clears only after two consecutive clear readings, and does not flap on one', () => {
    const steps = feed(RULE, [700, 700, 10, 700, 10, 10]);
    expect(steps.map((s) => s.transition)).toEqual([null, 'page', null, null, null, 'clear']);
    expect(steps[5]?.state).toEqual(INITIAL_META_ALERT_STATE);
  });

  it('pages once per incident, not once per breaching reading', () => {
    const pages = feed(RULE, [700, 700, 700, 700, 700]).filter((s) => s.transition === 'page');
    expect(pages).toHaveLength(1);
  });

  it('holds its state inside a hysteresis band', () => {
    const steps = feed(BANDED, [700, 700, 450, 450, 450, 200, 200]);
    expect(steps.map((s) => s.state.paging)).toEqual([false, true, true, true, true, true, false]);
    expect(steps[6]?.transition).toBe('clear');
  });

  it('holds state and streaks on a null reading', () => {
    // Losing an input must neither raise a page nor silently clear a live one.
    const paging = feed(RULE, [700, 700, null, null]);
    expect(paging.map((s) => s.state.paging)).toEqual([false, true, true, true]);
    expect(paging[3]?.status).toBe('paging');

    const idle = feed(RULE, [700, null, 700]);
    expect(idle.map((s) => s.transition)).toEqual([null, null, 'page']);
    expect(idle[1]?.status).toBe('no_data');
  });

  it('never pages while unarmed, whatever the reading', () => {
    const steps = feed(UNARMED, [1e9, 1e9, 1e9]);
    expect(steps.every((s) => s.status === 'unarmed' && s.transition === null)).toBe(true);
  });

  it('clears a page left over when a rule is disarmed', () => {
    const paging: MetaAlertState = {
      paging: true,
      breachStreak: 5,
      clearStreak: 0,
      pagingSince: 0,
    };
    const step = evaluateMetaAlert(UNARMED, 1e9, paging, 1);
    expect(step.transition).toBe('clear');
    expect(step.state).toEqual(INITIAL_META_ALERT_STATE);
  });

  it('refuses a non-finite reading and a rule that would flap', () => {
    expect(() => evaluateMetaAlert(RULE, Number.NaN, INITIAL_META_ALERT_STATE, 0)).toThrow(
      RangeError,
    );
    expect(() =>
      evaluateMetaAlert({ ...RULE, clearAtOrBelow: 700 }, 10, INITIAL_META_ALERT_STATE, 0),
    ).toThrow(/clearAtOrBelow/);
    expect(() =>
      evaluateMetaAlert({ ...RULE, pageAfter: 0 }, 10, INITIAL_META_ALERT_STATE, 0),
    ).toThrow(/pageAfter/);
  });
});
