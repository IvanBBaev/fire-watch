import { describe, expect, it } from 'vitest';

import { BaselineError, PLANNING_BASELINE, parseBaseline } from './baseline.js';
import {
  RATE_PROFILE,
  ScenarioError,
  buildScenario,
  cumulativeArrivals,
  deriveMix,
  desiredSseConnections,
  plannedArrivals,
} from './scenario.js';

describe('buildScenario — the L-3 50× target from the planning baseline', () => {
  const scenario = buildScenario();

  it('scales 2,000 / 4,000 / 500 to 100k sessions, 200k req/min and 25k SSE', () => {
    expect(scenario.totals).toEqual({
      sessions: 100_000,
      snapshotRequestsPerMinute: 200_000,
      sseConnections: 25_000,
    });
    expect(scenario.targets.snapshotRps).toBeCloseTo(3_333.33, 1);
    expect(scenario.targets.sseConnections).toBe(25_000);
    expect(scenario.sseCap).toBe(5_000);
  });

  it('derives client-config from session starts and T2 from the whole T1 rate', () => {
    // 100k sessions / 10 min mean session = 166.7 config fetches per second.
    expect(scenario.targets.clientConfigRps).toBeCloseTo(166.67, 1);
    expect(scenario.targets.t2Rps).toBeCloseTo(scenario.targets.snapshotRps, 6);
  });

  it('derives the request mix from the poll and safety-snapshot rhythm', () => {
    expect(scenario.mix.cursorShare).toBeCloseTo(0.925, 6);
    expect(scenario.mix.conditionalShare).toBeCloseTo(0.95, 6);
    expect(deriveMix({ pollIntervalMs: 1, safetySnapshotIntervalMs: 1 }, 0, 0)).toEqual({
      cursorShare: 0,
      conditionalShare: 0,
    });
  });

  it('runs ramp, steady and origin-kill by default, and drops origin-kill at 0 s', () => {
    expect(scenario.phases.map((p) => p.name)).toEqual(['ramp', 'steady', 'origin-kill']);
    const noKill = buildScenario({ durationsMs: { ramp: 1, steady: 1, originKill: 0 } });
    expect(noKill.phases.map((p) => p.name)).toEqual(['ramp', 'steady']);
  });

  it('splits rates evenly across shards and SSE connections exactly', () => {
    const shards = [1, 2, 3].map((index) => buildScenario({ shard: { index, count: 3 } }));
    const rps = shards.reduce((sum, s) => sum + s.targets.snapshotRps, 0);
    expect(rps).toBeCloseTo(scenario.targets.snapshotRps, 6);
    expect(shards.map((s) => s.targets.sseConnections)).toEqual([8_334, 8_333, 8_333]);
    // Totals and the cap are the whole test's, whichever shard reports them.
    expect(shards[2]?.totals).toEqual(scenario.totals);
    expect(shards[2]?.sseCap).toBe(5_000);
  });

  it('scales rates for a rehearsal but never the cap', () => {
    const tiny = buildScenario({ scale: 0.001 });
    expect(tiny.targets.snapshotRps).toBeCloseTo(3.333, 3);
    expect(tiny.targets.sseConnections).toBe(25);
    expect(tiny.sseCap).toBe(5_000);
  });

  it('refuses nonsense', () => {
    expect(() => buildScenario({ scale: 0 })).toThrow(ScenarioError);
    expect(() => buildScenario({ shard: { index: 3, count: 2 } })).toThrow(ScenarioError);
    expect(() => buildScenario({ sseCap: 1.5 })).toThrow(ScenarioError);
    expect(() => buildScenario({ durationsMs: { ramp: 0, steady: 1, originKill: 0 } })).toThrow(
      ScenarioError,
    );
  });
});

describe('cumulativeArrivals', () => {
  it('is the integral of the rate shape', () => {
    expect(cumulativeArrivals('full', 10, 60_000, 30_000)).toBe(300);
    expect(cumulativeArrivals('off', 10, 60_000, 30_000)).toBe(0);
    // A linear ramp owes an eighth of the full-rate 60 s arrivals by half time, half by the end.
    expect(cumulativeArrivals('ramp', 10, 60_000, 30_000)).toBe(75);
    expect(cumulativeArrivals('ramp', 10, 60_000, 60_000)).toBe(300);
  });

  it('clamps outside the phase', () => {
    expect(cumulativeArrivals('full', 10, 1_000, -5)).toBe(0);
    expect(cumulativeArrivals('full', 10, 1_000, 9_000)).toBe(10);
  });

  it('never decreases, so the driver never owes a negative number', () => {
    let previous = 0;
    for (let t = 0; t <= 1_000; t += 7) {
      const owed = cumulativeArrivals('ramp', 123, 1_000, t);
      expect(owed).toBeGreaterThanOrEqual(previous);
      previous = owed;
    }
  });
});

describe('plannedArrivals and SSE sizing', () => {
  const scenario = buildScenario({
    durationsMs: { ramp: 10_000, steady: 20_000, originKill: 5_000 },
  });

  it('sums the phases the profile runs a stream in', () => {
    const rps = scenario.targets.snapshotRps;
    expect(plannedArrivals(scenario, 'snapshot')).toBeCloseTo(rps * 5 + rps * 20, 6);
    expect(plannedArrivals(scenario, 't2')).toBeCloseTo(scenario.targets.t2Rps * 5, 6);
  });

  it('ramps streams up, holds them, and closes them when the origin dies', () => {
    const [ramp, steady, kill] = scenario.phases;
    if (ramp === undefined || steady === undefined || kill === undefined) throw new Error('phases');
    expect(desiredSseConnections(scenario, ramp, 5_000)).toBe(12_500);
    expect(desiredSseConnections(scenario, steady, 1)).toBe(25_000);
    expect(desiredSseConnections(scenario, kill, 1)).toBe(0);
    expect(RATE_PROFILE.t2.steady).toBe('off');
  });
});

describe('parseBaseline', () => {
  it('accepts a measured baseline', () => {
    const baseline = parseBaseline({
      label: 'season 1, 2027-08-03 14:00',
      sessions: 3_100,
      snapshotRequestsPerMinute: 5_900,
      sseConnections: 720,
    });
    expect(baseline.source).toBe('measured');
    expect(buildScenario({ baseline }).totals.sessions).toBe(155_000);
  });

  it('fails loudly on a typo rather than falling back to the planning figure', () => {
    expect(() => parseBaseline({ ...PLANNING_BASELINE, sesions: 1 })).toThrow(BaselineError);
    expect(() =>
      parseBaseline({ label: 'x', sessions: 0, snapshotRequestsPerMinute: 1, sseConnections: 0 }),
    ).toThrow(BaselineError);
    expect(() => parseBaseline([])).toThrow(BaselineError);
  });
});
