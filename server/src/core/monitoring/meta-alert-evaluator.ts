/**
 * Readings → page/clear decisions, with hysteresis (TASKS J1).
 *
 * Pure: the state goes in and comes out, nothing is remembered here. A rule pages after
 * `pageAfter` consecutive readings strictly above `pageAbove`, and clears after
 * `clearAfter` consecutive readings at or below `clearAtOrBelow`. A reading between the
 * two thresholds (possible once a band is ratified) resets both streaks and holds the
 * current state — that is the band doing its job.
 *
 * A `null` reading means "nothing to measure" (no live clustering run, no canary probe).
 * It neither breaches nor clears: the streaks and the state are held as they are, so a
 * monitor that briefly loses its input can neither page nor silently clear a live page.
 * A monitor whose *reader* fails is a different case: the whole cycle fails, the pager is
 * not called, and the dead-man's switch pages instead.
 */

import type { EpochMs } from '../ports/clock.js';
import type { MetaAlertRule } from './meta-alert-params.js';

export interface MetaAlertState {
  readonly paging: boolean;
  readonly breachStreak: number;
  readonly clearStreak: number;
  /** When the current page fired; `null` while not paging. */
  readonly pagingSince: EpochMs | null;
}

export const INITIAL_META_ALERT_STATE: MetaAlertState = {
  paging: false,
  breachStreak: 0,
  clearStreak: 0,
  pagingSince: null,
};

/** What one reading looks like to a human reading the log line. */
export type ReadingStatus = 'unarmed' | 'no_data' | 'ok' | 'breaching' | 'paging';

export interface MetaAlertStep {
  readonly state: MetaAlertState;
  readonly transition: 'page' | 'clear' | null;
  readonly status: ReadingStatus;
}

export function evaluateMetaAlert(
  rule: MetaAlertRule,
  reading: number | null,
  previous: MetaAlertState,
  now: EpochMs,
): MetaAlertStep {
  assertRule(rule);
  if (reading !== null && !Number.isFinite(reading)) {
    // NaN compares false both ways: it would hold a page forever or never raise one.
    throw new RangeError(`meta-alert reading must be finite or null, got ${String(reading)}`);
  }

  if (rule.pageAbove === null) {
    // Unarmed. A state left over from an armed configuration is dropped, never kept
    // paging by a rule that can no longer clear it.
    return {
      state: INITIAL_META_ALERT_STATE,
      transition: previous.paging ? 'clear' : null,
      status: 'unarmed',
    };
  }

  if (reading === null) {
    return { state: previous, transition: null, status: previous.paging ? 'paging' : 'no_data' };
  }

  const clearAtOrBelow = rule.clearAtOrBelow ?? rule.pageAbove;
  const breaching = reading > rule.pageAbove;
  const clear = reading <= clearAtOrBelow;

  if (breaching) {
    const breachStreak = previous.breachStreak + 1;
    if (!previous.paging && breachStreak >= rule.pageAfter) {
      return {
        state: { paging: true, breachStreak, clearStreak: 0, pagingSince: now },
        transition: 'page',
        status: 'paging',
      };
    }
    return {
      state: { ...previous, breachStreak, clearStreak: 0 },
      transition: null,
      status: previous.paging ? 'paging' : 'breaching',
    };
  }

  if (clear) {
    const clearStreak = previous.clearStreak + 1;
    if (previous.paging && clearStreak >= rule.clearAfter) {
      return { state: INITIAL_META_ALERT_STATE, transition: 'clear', status: 'ok' };
    }
    return {
      state: { ...previous, breachStreak: 0, clearStreak },
      transition: null,
      status: previous.paging ? 'paging' : 'ok',
    };
  }

  // Inside the band: hold.
  return {
    state: { ...previous, breachStreak: 0, clearStreak: 0 },
    transition: null,
    status: previous.paging ? 'paging' : 'ok',
  };
}

function assertRule(rule: MetaAlertRule): void {
  if (!Number.isInteger(rule.pageAfter) || rule.pageAfter < 1) {
    throw new RangeError(`pageAfter must be a positive integer, got ${String(rule.pageAfter)}`);
  }
  if (!Number.isInteger(rule.clearAfter) || rule.clearAfter < 1) {
    throw new RangeError(`clearAfter must be a positive integer, got ${String(rule.clearAfter)}`);
  }
  if (
    rule.pageAbove !== null &&
    rule.clearAtOrBelow !== null &&
    rule.clearAtOrBelow > rule.pageAbove
  ) {
    // A clear threshold above the page threshold would make one reading both breach and
    // clear, and the rule would flap on every cycle — the exact failure this module exists
    // to prevent.
    throw new RangeError('clearAtOrBelow must not exceed pageAbove');
  }
}
