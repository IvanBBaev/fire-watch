/**
 * What the meta-alert hysteresis remembers between cycles, and across processes (TASKS J1;
 * migration 036).
 *
 * Kept in memory, the streaks die with the process, and the pager reports a *level*: the
 * first cycle after a restart has a breach streak of 1, pages nobody, and pings
 * healthchecks.io "success" — which clears a live page — before the second cycle raises it
 * again. A deploy during an incident therefore flapped the page. A standby worker taking
 * over (or a second worker running alongside) had the same blind first cycle, and two
 * workers each reporting from their own memory could contradict each other on one check.
 *
 * The state is now stored per key with the instant it was last advanced, and every cycle
 * reads it before deciding. Two rules turn "stored" into "what this cycle starts from":
 *
 *   * **Hold, do not advance, a state advanced moments ago.** A cycle that finds the state
 *     advanced less than {@link ADVANCE_MIN_GAP_FRACTION} of an interval ago does not add
 *     its reading to the streaks — another worker (or this one, re-run) has just counted
 *     that minute. It reports the stored level instead, so every worker pings the same
 *     page set and no streak runs faster than one step per interval.
 *   * **A streak older than {@link STREAK_STALE_AFTER_INTERVALS} intervals is not
 *     consecutive.** After a gap that long (a stopped worker, a wedged loop) the streaks
 *     restart from zero. A live page is kept — it clears only through `clearAfter` healthy
 *     readings, exactly as without the gap — because silently dropping a page on restart
 *     is the failure this module removes.
 *
 * Both constants are mechanism, not design numbers: they define "consecutive" against the
 * loop's own cadence, like meta-health's stale window.
 *
 * Clock skew between two workers: a stored instant in this process's future counts as
 * "moments ago" only within the same half interval; beyond that it is ignored and the cycle
 * advances, so a worker whose clock runs behind can never freeze the hysteresis.
 */

import type { EpochMs } from '../ports/clock.js';
import { INITIAL_META_ALERT_STATE, type MetaAlertState } from './meta-alert-evaluator.js';
import { META_ALERT_KEYS, type MetaAlertKey } from './meta-alert-params.js';

/** Under half an interval since the last advance: another cycle has counted this minute. */
export const ADVANCE_MIN_GAP_FRACTION = 0.5;

/** Same slack as meta-health's stale window: a slow cycle, the scheduler, the read. */
export const STREAK_STALE_AFTER_INTERVALS = 3;

export interface StoredMetaAlertState {
  readonly state: MetaAlertState;
  /** When a cycle last advanced this key's state. */
  readonly evaluatedAt: EpochMs;
}

/** Rows as read; keys the code no longer knows are present and ignored. */
export type StoredMetaAlertStates = ReadonlyMap<string, StoredMetaAlertState>;

export interface ResumedMetaAlertStates {
  /** `false`: hold the stored level, do not count this cycle's readings, write nothing. */
  readonly advance: boolean;
  /** The state each key's evaluation starts from (or, when holding, the level reported). */
  readonly states: ReadonlyMap<MetaAlertKey, MetaAlertState>;
}

export function resumeMetaAlertStates(
  stored: StoredMetaAlertStates,
  now: EpochMs,
  intervalMs: number,
): ResumedMetaAlertStates {
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
    throw new RangeError(`intervalMs must be a positive finite number, got ${String(intervalMs)}`);
  }
  const minGapMs = intervalMs * ADVANCE_MIN_GAP_FRACTION;
  const staleAfterMs = intervalMs * STREAK_STALE_AFTER_INTERVALS;

  const known = META_ALERT_KEYS.flatMap((key) => {
    const row = stored.get(key);
    return row === undefined ? [] : [[key, row] as const];
  });
  const advance = !known.some(([, row]) => Math.abs(now - row.evaluatedAt) < minGapMs);

  const states = new Map<MetaAlertKey, MetaAlertState>();
  for (const key of META_ALERT_KEYS) {
    const row = stored.get(key);
    if (row === undefined) {
      states.set(key, INITIAL_META_ALERT_STATE);
    } else if (advance && now - row.evaluatedAt > staleAfterMs) {
      states.set(key, { ...row.state, breachStreak: 0, clearStreak: 0 });
    } else {
      states.set(key, row.state);
    }
  }
  return { advance, states };
}
