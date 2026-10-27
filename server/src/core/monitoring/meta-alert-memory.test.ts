import { describe, expect, it } from 'vitest';

import { INITIAL_META_ALERT_STATE, type MetaAlertState } from './meta-alert-evaluator.js';
import {
  resumeMetaAlertStates,
  type StoredMetaAlertState,
  type StoredMetaAlertStates,
} from './meta-alert-memory.js';
import { META_ALERT_KEYS } from './meta-alert-params.js';

const INTERVAL = 60_000;
const NOW = 1_800_000_000_000;

const PAGING: MetaAlertState = {
  paging: true,
  breachStreak: 4,
  clearStreak: 1,
  pagingSince: NOW - 5 * INTERVAL,
};

const stored = (entries: Record<string, StoredMetaAlertState>): StoredMetaAlertStates =>
  new Map(Object.entries(entries));

describe('resumeMetaAlertStates', () => {
  it('starts every key from the initial state when nothing is stored', () => {
    const resumed = resumeMetaAlertStates(new Map(), NOW, INTERVAL);
    expect(resumed.advance).toBe(true);
    expect([...resumed.states.keys()]).toEqual([...META_ALERT_KEYS]);
    for (const state of resumed.states.values()) expect(state).toEqual(INITIAL_META_ALERT_STATE);
  });

  it('resumes a state advanced one interval ago as it was', () => {
    const resumed = resumeMetaAlertStates(
      stored({ outbox_queue_oldest_seconds: { state: PAGING, evaluatedAt: NOW - INTERVAL } }),
      NOW,
      INTERVAL,
    );
    expect(resumed.advance).toBe(true);
    expect(resumed.states.get('outbox_queue_oldest_seconds')).toEqual(PAGING);
    expect(resumed.states.get('outbox_pending_rows')).toEqual(INITIAL_META_ALERT_STATE);
  });

  it('holds a state advanced less than half an interval ago, in the past or the near future', () => {
    for (const evaluatedAt of [NOW, NOW - INTERVAL / 2 + 1, NOW + INTERVAL / 2 - 1]) {
      const resumed = resumeMetaAlertStates(
        stored({ outbox_queue_oldest_seconds: { state: PAGING, evaluatedAt } }),
        NOW,
        INTERVAL,
      );
      expect(resumed.advance).toBe(false);
      expect(resumed.states.get('outbox_queue_oldest_seconds')).toEqual(PAGING);
    }
  });

  it('advances past a stored instant far in this clock’s future, so skew cannot freeze it', () => {
    const resumed = resumeMetaAlertStates(
      stored({ outbox_queue_oldest_seconds: { state: PAGING, evaluatedAt: NOW + INTERVAL } }),
      NOW,
      INTERVAL,
    );
    expect(resumed.advance).toBe(true);
  });

  it('resets the streaks after a long gap but keeps a live page', () => {
    const resumed = resumeMetaAlertStates(
      stored({
        outbox_queue_oldest_seconds: { state: PAGING, evaluatedAt: NOW - 3 * INTERVAL - 1 },
        outbox_pending_rows: {
          state: { ...INITIAL_META_ALERT_STATE, breachStreak: 1 },
          evaluatedAt: NOW - 10 * INTERVAL,
        },
      }),
      NOW,
      INTERVAL,
    );
    expect(resumed.advance).toBe(true);
    expect(resumed.states.get('outbox_queue_oldest_seconds')).toEqual({
      ...PAGING,
      breachStreak: 0,
      clearStreak: 0,
    });
    expect(resumed.states.get('outbox_pending_rows')).toEqual(INITIAL_META_ALERT_STATE);
  });

  it('keeps the streaks at exactly three intervals', () => {
    const resumed = resumeMetaAlertStates(
      stored({ outbox_queue_oldest_seconds: { state: PAGING, evaluatedAt: NOW - 3 * INTERVAL } }),
      NOW,
      INTERVAL,
    );
    expect(resumed.states.get('outbox_queue_oldest_seconds')).toEqual(PAGING);
  });

  it('ignores a stored key the code no longer knows, even one advanced just now', () => {
    const resumed = resumeMetaAlertStates(
      stored({ retired_reading: { state: PAGING, evaluatedAt: NOW } }),
      NOW,
      INTERVAL,
    );
    expect(resumed.advance).toBe(true);
    expect(resumed.states.has('retired_reading' as never)).toBe(false);
  });

  it('refuses an interval that is not a positive finite number', () => {
    for (const interval of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => resumeMetaAlertStates(new Map(), NOW, interval)).toThrow(RangeError);
    }
  });
});
