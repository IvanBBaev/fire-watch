/**
 * The canary's pure half (TASKS J1): one probe in flight at a time, measured end to end.
 *
 * Each cycle observes the probe in flight. An acknowledged probe yields its round trip
 * and a new probe is injected; an unacknowledged one yields its age so far — a stuck path
 * reads as a steadily growing number, which is what lets an armed threshold page on it
 * without a separate timeout. Only one probe is ever outstanding, so a dead path costs one
 * row, not one row per minute.
 */

import type { EpochMs } from '../ports/clock.js';
import type { CanaryInjection } from '../ports/canary-probe.js';

export interface CanaryState {
  readonly inFlight: CanaryInjection | null;
  /** The last completed round trip, reported while the next probe is in flight. */
  readonly lastRoundTripMs: number | null;
}

export const INITIAL_CANARY_STATE: CanaryState = { inFlight: null, lastRoundTripMs: null };

export interface CanaryOutcome {
  readonly state: CanaryState;
  /** Seconds; `null` before the first probe completes and while nothing is in flight. */
  readonly readingSeconds: number | null;
  /** True when the probe just completed and a new one should be injected. */
  readonly reinject: boolean;
}

export function settleCanary(
  state: CanaryState,
  ackedAt: EpochMs | null,
  now: EpochMs,
): CanaryOutcome {
  const probe = state.inFlight;
  if (probe === null) {
    return {
      state,
      readingSeconds: toSeconds(state.lastRoundTripMs),
      reinject: true,
    };
  }
  if (ackedAt === null) {
    const pendingMs = Math.max(0, now - probe.injectedAt);
    // The larger of the last completed trip and the age of this one: a path that was fast
    // an hour ago and has been silent since must not keep reporting the fast number.
    const readingMs = Math.max(pendingMs, state.lastRoundTripMs ?? 0);
    return { state, readingSeconds: toSeconds(readingMs), reinject: false };
  }
  const roundTripMs = Math.max(0, ackedAt - probe.injectedAt);
  return {
    state: { inFlight: null, lastRoundTripMs: roundTripMs },
    readingSeconds: toSeconds(roundTripMs),
    reinject: true,
  };
}

function toSeconds(ms: number | null): number | null {
  return ms === null ? null : Math.floor(ms / 1000);
}
