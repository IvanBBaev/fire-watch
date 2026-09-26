import { describe, expect, it } from 'vitest';

import { INITIAL_CANARY_STATE, settleCanary, type CanaryState } from './canary.js';

const PROBE = { probeId: 'p1', injectedAt: 1_000_000 };

describe('settleCanary', () => {
  it('asks for a first probe and has no reading before one completes', () => {
    const outcome = settleCanary(INITIAL_CANARY_STATE, null, 0);
    expect(outcome.reinject).toBe(true);
    expect(outcome.readingSeconds).toBeNull();
  });

  it('reports the growing age of an unacknowledged probe, without re-injecting', () => {
    const state: CanaryState = { inFlight: PROBE, lastRoundTripMs: null };
    const outcome = settleCanary(state, null, PROBE.injectedAt + 125_000);
    expect(outcome).toEqual({ state, readingSeconds: 125, reinject: false });
  });

  it('reports the round trip of an acknowledged probe and asks for the next one', () => {
    const state: CanaryState = { inFlight: PROBE, lastRoundTripMs: null };
    const outcome = settleCanary(state, PROBE.injectedAt + 4_500, PROBE.injectedAt + 60_000);
    expect(outcome.readingSeconds).toBe(4);
    expect(outcome.reinject).toBe(true);
    expect(outcome.state).toEqual({ inFlight: null, lastRoundTripMs: 4_500 });
  });

  it('never lets a fast past trip mask a probe that is younger but still pending', () => {
    const state: CanaryState = { inFlight: PROBE, lastRoundTripMs: 30_000 };
    expect(settleCanary(state, null, PROBE.injectedAt + 5_000).readingSeconds).toBe(30);
    expect(settleCanary(state, null, PROBE.injectedAt + 90_000).readingSeconds).toBe(90);
  });
});
