/**
 * The arithmetic of ADR-002 D6 as amended by A2.3(1), pinned case by case.
 *
 * Two of these tests are the reason the file exists rather than being a smoke suite. The
 * per-source freeze test is the A2.3(1) regression: a global freeze passes every other
 * assertion here and leaves every event `active` forever, so it is asserted from both
 * sides — the blown source contributes nothing, *and* the healthy one still reaches the
 * threshold. The determinism test is the other: E is a float sum, and a sum that depends on
 * the order a weather row or an outage row happened to arrive in is a sum a replay cannot
 * reproduce.
 *
 * The predictor is a hand-written stub rather than the static table, because what is under
 * test is the weighing, not the constellation model.
 */

import type { SourceId } from '@fire-watch/contracts';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { LIFECYCLE_PARAMS, quantizeE } from '../config/lifecycle-params.js';
import type { Coordinate } from '../clustering/geometry.js';
import type { EpochMs } from '../ports/clock.js';
import { epochMsFromIso } from '../ports/clock.js';
import type {
  DiurnalPhase,
  ExpectedPass,
  PassPredictor,
  PassWindow,
} from '../ports/pass-predictor.js';
import { accumulateMissEvidence } from './e-accumulator.js';
import type { MissEvidenceInput } from './e-accumulator.js';
import type {
  CloudCoverSample,
  EventObservationSnapshot,
  GeoWeightSpent,
  MissEvidence,
  SourceOutage,
  WeighedPass,
} from './types.js';

const PARAMS = LIFECYCLE_PARAMS.values;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const SLOT_MS = 600_000;

const CENTROID: Coordinate = { lat: 42.13, lon: 24.75 };
const TABLE_VERSION = 'pass_table_stub_v1';

/** Midnight UTC, so every day boundary in these fixtures is a round number. */
const T0 = epochMsFromIso('2026-08-10T00:00:00.000Z');

/**
 * A predictor that answers from a fixed list. It filters to `[fromMs, toMs)` and sorts the
 * way the port promises, so a test can hand it passes in any order without accidentally
 * testing the accumulator's tolerance of a broken predictor.
 */
function stubPredictor(passes: readonly ExpectedPass[]): PassPredictor {
  return {
    tableVersion: TABLE_VERSION,
    expectedPasses(_at: Coordinate, fromMs: EpochMs, toMs: EpochMs): readonly ExpectedPass[] {
      return passes
        .filter((pass) => pass.atMs >= fromMs && pass.atMs < toMs)
        .toSorted((a, b) => a.atMs - b.atMs || (a.source < b.source ? -1 : 1));
    },
    nextWindow(): PassWindow | null {
      return null;
    },
  };
}

function snapshot(overrides: Partial<EventObservationSnapshot> = {}): EventObservationSnapshot {
  return {
    publicId: 'fw-2026-abcd',
    state: 'active',
    centroid: CENTROID,
    lastDetectionAtMs: T0,
    lastFrpMw: null,
    maxFrpMw: null,
    hullAreaHa: null,
    peatOrLandfill: false,
    accumulatedE: 0,
    geoWeightSpent: null,
    blindSinceMs: null,
    inactiveSinceMs: null,
    officialDeclaration: null,
    ...overrides,
  };
}

/** Hourly samples at one percentage across `[fromMs, toMs)`. */
function sky(percent: number, fromMs: EpochMs, toMs: EpochMs): CloudCoverSample[] {
  const out: CloudCoverSample[] = [];
  for (let hour = Math.floor(fromMs / HOUR_MS) * HOUR_MS; hour < toMs; hour += HOUR_MS) {
    out.push({ hourStartMs: hour, percent });
  }
  return out;
}

interface RunOptions {
  readonly passes?: readonly ExpectedPass[];
  readonly event?: Partial<EventObservationSnapshot>;
  readonly cloud?: readonly CloudCoverSample[];
  readonly outages?: readonly SourceOutage[];
  readonly fromMs?: EpochMs;
  readonly toMs?: EpochMs;
}

function inputFor(options: RunOptions = {}): MissEvidenceInput {
  const fromMs = options.fromMs ?? T0;
  const toMs = options.toMs ?? T0 + DAY_MS;
  return {
    event: snapshot(options.event),
    predictor: stubPredictor(options.passes ?? []),
    windowFromMs: fromMs,
    windowToMs: toMs,
    cloud: options.cloud ?? sky(0, fromMs, toMs),
    outages: options.outages ?? [],
  };
}

function run(options: RunOptions = {}): MissEvidence {
  return accumulateMissEvidence(inputFor(options));
}

/** Only the overpasses — the GEO slots are noise in a test about polar weights. */
function polar(evidence: MissEvidence): readonly WeighedPass[] {
  return evidence.passes.filter((pass) => !pass.source.startsWith('lsasaf:'));
}

const NOON = T0 + 12 * HOUR_MS;
const MIDNIGHT = T0 + 2 * HOUR_MS;

describe('the per-source miss weights of ADR-002 D6', () => {
  const cases: readonly { source: SourceId; phase: DiurnalPhase; weight: number }[] = [
    { source: 'firms:viirs:snpp', phase: 'night', weight: 1.25 },
    { source: 'firms:viirs:noaa20', phase: 'day', weight: 1.0 },
    { source: 'firms:viirs:noaa21', phase: 'night', weight: 1.25 },
    { source: 'eumetsat:slstr:frp', phase: 'day', weight: 0.75 },
    { source: 'firms:modis', phase: 'night', weight: 0.5 },
  ];

  for (const { source, phase, weight } of cases) {
    it(`weighs a missed ${source} ${phase} pass at ${String(weight)}`, () => {
      const evidence = run({ passes: [{ source, atMs: NOON, phase }] });
      expect(evidence.addedE).toBe(weight);
      expect(polar(evidence)).toEqual([{ source, atMs: NOON, phase, verdict: 'counted', weight }]);
    });
  }

  it('separates the two VIIRS phases, which is the whole reason the table is indexed by phase', () => {
    const evidence = run({
      passes: [
        { source: 'firms:viirs:snpp', atMs: MIDNIGHT, phase: 'night' },
        { source: 'firms:viirs:snpp', atMs: NOON, phase: 'day' },
      ],
    });
    expect(evidence.addedE).toBe(2.25);
    expect(evidence.phasesWithMisses).toEqual(['day', 'night']);
  });

  it('refuses a geostationary source in the overpass stream rather than weighing it as null', () => {
    expect(() =>
      run({ passes: [{ source: 'lsasaf:seviri:frp-pixel', atMs: NOON, phase: 'day' }] }),
    ).toThrow(/geostationary/);
  });
});

describe('the cloud gate', () => {
  const pass: ExpectedPass = { source: 'firms:viirs:snpp', atMs: NOON, phase: 'night' };

  function atCover(percent: number): MissEvidence {
    return run({ passes: [pass], cloud: sky(percent, T0, T0 + DAY_MS) });
  }

  it('blocks above 80 % and does not even leave an opportunity behind', () => {
    const evidence = atCover(81);
    expect(evidence.addedE).toBe(0);
    expect(polar(evidence)[0]?.verdict).toBe('cloud_blocked');
    expect(evidence.accumulableOpportunities).toBe(0);
  });

  it('halves at exactly 80 — the band is closed in the direction of less accumulation', () => {
    const evidence = atCover(80);
    expect(evidence.addedE).toBe(0.625);
    expect(polar(evidence)[0]?.verdict).toBe('half_weight');
  });

  it('halves at exactly 50 for the same reason', () => {
    const evidence = atCover(50);
    expect(evidence.addedE).toBe(0.625);
    expect(polar(evidence)[0]?.verdict).toBe('half_weight');
  });

  it('counts in full at 49', () => {
    const evidence = atCover(49);
    expect(evidence.addedE).toBe(1.25);
    expect(polar(evidence)[0]?.verdict).toBe('counted');
  });

  it('counts a half-weight pass as a real opportunity', () => {
    expect(atCover(60).accumulableOpportunities).toBeGreaterThan(0);
  });

  it('accumulates nothing for a pass whose hour has no sample at all', () => {
    // The judgement call, asserted so it cannot drift: a gap in a third-party weather feed
    // is not evidence that a satellite had a clear look, and manufacturing miss evidence
    // out of one would retire a burning fire on the strength of a missing row. A2.3(3)'s
    // 14-day fallback is the ceiling that stops this from being a deadlock.
    const evidence = run({ passes: [pass], cloud: [] });
    expect(evidence.addedE).toBe(0);
    expect(polar(evidence)[0]?.verdict).toBe('cloud_blocked');
    expect(evidence.accumulableOpportunities).toBe(0);
  });

  it('rejects a sample that is not on a UTC hour rather than silently never matching', () => {
    expect(() =>
      run({ passes: [pass], cloud: [{ hourStartMs: T0 + 1800_000, percent: 0 }] }),
    ).toThrow(/UTC hour/);
  });

  it('rejects a percentage that is not one', () => {
    expect(() => run({ passes: [pass], cloud: [{ hourStartMs: T0, percent: 140 }] })).toThrow(
      /percentage/,
    );
  });
});

describe('a pass the fire was still burning through is not a miss', () => {
  it('records `detected` for a pass at exactly the last detection', () => {
    const evidence = run({
      passes: [{ source: 'firms:viirs:snpp', atMs: T0, phase: 'night' }],
      fromMs: T0 - HOUR_MS,
      event: { lastDetectionAtMs: T0 },
    });
    expect(evidence.addedE).toBe(0);
    expect(polar(evidence)[0]?.verdict).toBe('detected');
  });

  it('still counts it as an opportunity — it is the best opportunity there is', () => {
    const evidence = run({
      passes: [{ source: 'firms:viirs:snpp', atMs: T0, phase: 'night' }],
      fromMs: T0 - HOUR_MS,
      event: { lastDetectionAtMs: T0 },
    });
    expect(evidence.accumulableOpportunities).toBe(1);
  });
});

describe('A2.3(1) — the outage freeze is per-source, never global', () => {
  // The regression this file exists for. A global freeze satisfies every other assertion
  // in this suite and leaves every event `active` forever, so both halves are asserted:
  // the blown source is silent, and the healthy one still crosses 3.0 on its own.
  const frozenSource = 'firms:viirs:snpp';
  const healthySource = 'firms:viirs:noaa20';
  const outage: SourceOutage = { source: frozenSource, fromMs: T0, toMs: T0 + DAY_MS };

  const passes: readonly ExpectedPass[] = [
    { source: frozenSource, atMs: T0 + 2 * HOUR_MS, phase: 'night' },
    { source: healthySource, atMs: T0 + 3 * HOUR_MS, phase: 'night' },
    { source: frozenSource, atMs: T0 + 12 * HOUR_MS, phase: 'day' },
    { source: healthySource, atMs: T0 + 13 * HOUR_MS, phase: 'day' },
    { source: frozenSource, atMs: T0 + 14 * HOUR_MS, phase: 'night' },
    { source: healthySource, atMs: T0 + 15 * HOUR_MS, phase: 'night' },
  ];

  const evidence = run({ passes, outages: [outage] });
  const frozen = polar(evidence).filter((pass) => pass.source === frozenSource);
  const healthy = polar(evidence).filter((pass) => pass.source === healthySource);

  it('weighs nothing from the source that is outside its freshness budget', () => {
    expect(frozen.map((pass) => pass.verdict)).toEqual([
      'source_frozen',
      'source_frozen',
      'source_frozen',
    ]);
    expect(frozen.map((pass) => pass.weight)).toEqual([0, 0, 0]);
  });

  it('does not freeze the other source — no global freeze occurs', () => {
    expect(healthy.map((pass) => pass.verdict)).toEqual(['counted', 'counted', 'counted']);
    expect(healthy.map((pass) => pass.weight)).toEqual([1.25, 1.0, 1.25]);
  });

  it('still reaches the 3.0 threshold on the healthy source alone', () => {
    expect(evidence.addedE).toBe(3.5);
    expect(evidence.e).toBeGreaterThanOrEqual(PARAMS.eThreshold);
  });

  it('leaves the frozen passes out of the accumulable opportunities', () => {
    expect(evidence.accumulableOpportunities).toBe(3);
  });

  it('does not rescale the threshold to compensate for the thinner constellation', () => {
    // The one line of A2.3(1) that is easiest to "helpfully" get wrong. A halved threshold
    // would make this event cross on 1.75 instead of 3.5, which is precisely the false
    // extinguish the FER guardrail exists to catch.
    const withoutOutage = run({ passes });
    expect(withoutOutage.addedE).toBe(7.0);
    expect(PARAMS.eThreshold).toBe(3.0);
  });

  it('treats the outage window as half-open, like every other interval in the core', () => {
    const boundary = run({
      passes: [
        { source: frozenSource, atMs: T0 + HOUR_MS, phase: 'night' },
        { source: frozenSource, atMs: T0 + 2 * HOUR_MS, phase: 'night' },
      ],
      outages: [{ source: frozenSource, fromMs: T0 + HOUR_MS, toMs: T0 + 2 * HOUR_MS }],
    });
    expect(polar(boundary).map((pass) => pass.verdict)).toEqual(['source_frozen', 'counted']);
  });

  it('honours an open-ended outage', () => {
    const open = run({
      passes: [{ source: frozenSource, atMs: T0 + 12 * HOUR_MS, phase: 'day' }],
      outages: [{ source: frozenSource, fromMs: T0, toMs: null }],
    });
    expect(open.addedE).toBe(0);
  });

  it('rejects an outage that ends before it starts', () => {
    expect(() =>
      run({ outages: [{ source: frozenSource, fromMs: T0 + HOUR_MS, toMs: T0 }] }),
    ).toThrow(/before it starts/);
  });
});

describe('the geostationary slot rule', () => {
  // 1.5 × the 30 MW placeholder floor. The event's last FRP is the gate.
  const GATE_MW = PARAMS.geoSlot.frpFloorMultiple * PARAMS.geoSlot.detectionFloorMw;
  /** Both GEO sources share the slot grid, so an hour of window is 6 slots × 2 sources. */
  const GEO_SOURCES = 2;

  function geoRun(lastFrpMw: number | null, hours: number, extra: RunOptions = {}): MissEvidence {
    const toMs = T0 + hours * HOUR_MS;
    return accumulateMissEvidence(
      inputFor({
        ...extra,
        event: { lastFrpMw, lastDetectionAtMs: T0 - HOUR_MS, ...extra.event },
        fromMs: T0,
        toMs,
        cloud: extra.cloud ?? sky(0, T0, toMs),
      }),
    );
  }

  it('contributes nothing below the FRP gate', () => {
    const evidence = geoRun(GATE_MW - 1, 2);
    expect(evidence.addedE).toBe(0);
    expect(evidence.passes.every((pass) => pass.verdict === 'geo_gated')).toBe(true);
    expect(evidence.accumulableOpportunities).toBe(0);
  });

  it('contributes nothing when no FRP was ever reported', () => {
    // `null` cannot satisfy a numeric floor, and a missing FRP must never be read as a
    // bright fire — that is the direction that would invent miss evidence.
    const evidence = geoRun(null, 2);
    expect(evidence.addedE).toBe(0);
    expect(evidence.accumulableOpportunities).toBe(0);
  });

  it('accumulates 0.05 per 10-minute slot at exactly the gate', () => {
    const evidence = geoRun(GATE_MW, 1);
    expect(evidence.addedE).toBe(quantizeE(6 * GEO_SOURCES * PARAMS.geoSlot.weightPerSlot));
    expect(evidence.passes).toHaveLength(6 * GEO_SOURCES);
  });

  it('stops at the daily cap and gates every slot after it', () => {
    const evidence = geoRun(GATE_MW * 2, 4);
    expect(evidence.addedE).toBe(PARAMS.geoSlot.dailyCapWeight);
    const counted = evidence.passes.filter((pass) => pass.verdict === 'counted');
    // 1.0 / 0.05 = 20 slots, taken in (atMs, source) order; the rest of the window is gated.
    expect(counted).toHaveLength(20);
    expect(evidence.passes.filter((pass) => pass.verdict === 'geo_gated')).toHaveLength(
      4 * 6 * GEO_SOURCES - 20,
    );
  });

  it('caps the UTC day across GEO sources rather than once per source', () => {
    // SEVIRI and FCI look at the same scene from nearly the same place; two of them
    // failing to see a fire in the same ten minutes is one failure observed twice.
    const both = geoRun(GATE_MW * 2, 24);
    expect(both.addedE).toBe(PARAMS.geoSlot.dailyCapWeight);
  });

  it('lets the cap refill on the next UTC day', () => {
    const evidence = geoRun(GATE_MW * 2, 48);
    expect(evidence.addedE).toBe(2 * PARAMS.geoSlot.dailyCapWeight);
  });

  it('gates a slot behind thick cloud, exactly like an overpass', () => {
    const evidence = geoRun(GATE_MW * 2, 2, { cloud: sky(90, T0, T0 + 2 * HOUR_MS) });
    expect(evidence.addedE).toBe(0);
    expect(evidence.accumulableOpportunities).toBe(0);
  });

  it('halves a slot in the 50–80 band', () => {
    const evidence = geoRun(GATE_MW * 2, 1, { cloud: sky(70, T0, T0 + HOUR_MS) });
    expect(evidence.addedE).toBe(quantizeE(6 * GEO_SOURCES * 0.025));
  });

  it('freezes one GEO source without silencing the other', () => {
    const evidence = geoRun(GATE_MW * 2, 1, {
      outages: [{ source: 'lsasaf:seviri:frp-pixel', fromMs: T0, toMs: T0 + DAY_MS }],
    });
    expect(evidence.addedE).toBe(quantizeE(6 * PARAMS.geoSlot.weightPerSlot));
    const bySource = new Set(
      evidence.passes.filter((pass) => pass.verdict === 'counted').map((pass) => pass.source),
    );
    expect([...bySource]).toEqual(['lsasaf:fci:frp-pixel']);
  });

  it('does not treat a slot before the last detection as a miss', () => {
    const evidence = geoRun(GATE_MW * 2, 1, { event: { lastDetectionAtMs: T0 + 25 * 60_000 } });
    const detected = evidence.passes.filter((pass) => pass.verdict === 'detected');
    expect(detected).toHaveLength(3 * GEO_SOURCES);
    expect(evidence.addedE).toBe(quantizeE(3 * GEO_SOURCES * PARAMS.geoSlot.weightPerSlot));
  });

  it('places slots on the 10-minute grid inside the half-open window', () => {
    const evidence = geoRun(GATE_MW * 2, 1);
    const instants = [...new Set(evidence.passes.map((pass) => pass.atMs))].toSorted(
      (a, b) => a - b,
    );
    expect(instants).toEqual([0, 1, 2, 3, 4, 5].map((n) => T0 + n * SLOT_MS));
  });

  it('never lets a GEO slot claim a diurnal phase for the transition condition', () => {
    // `DiurnalPhase` is which of a polar source's two daily passes something was. A
    // geostationary sensor has neither, so it must not be able to satisfy "misses spanning
    // both diurnal phases" on its own.
    const evidence = geoRun(GATE_MW * 2, 24);
    expect(evidence.addedE).toBeGreaterThan(0);
    expect(evidence.phasesWithMisses).toEqual([]);
  });
});

describe('the GEO daily cap is carried between ticks, not restarted by each window', () => {
  const GATE_MW = PARAMS.geoSlot.frpFloorMultiple * PARAMS.geoSlot.detectionFloorMw;
  const CAP = PARAMS.geoSlot.dailyCapWeight;
  const SLOT = PARAMS.geoSlot.weightPerSlot;
  const NEXT_DAY = T0 + DAY_MS;

  /** One tick: a bright fire, a clear sky, a window, and whatever the last tick left. */
  function tick(fromMs: EpochMs, toMs: EpochMs, carry: GeoWeightSpent | null): MissEvidence {
    return accumulateMissEvidence(
      inputFor({
        event: {
          lastFrpMw: GATE_MW * 2,
          lastDetectionAtMs: T0 - HOUR_MS,
          geoWeightSpent: carry,
        },
        fromMs,
        toMs,
        cloud: sky(0, fromMs, toMs),
      }),
    );
  }

  it('THE REGRESSION: two half-day ticks over one UTC day pay one cap, not one each', () => {
    // The bug this field exists to close. A tick only sees its own window, so a cap
    // enforced over the window alone is a cap *per tick*: a job running four times a day
    // would let a stationary sensor contribute four times what the parameter permits.
    const morning = tick(T0, T0 + 12 * HOUR_MS, null);
    expect(morning.addedE).toBe(CAP);
    expect(morning.geoWeightSpent).toEqual({ utcDayStartMs: T0, weight: CAP });

    const afternoon = tick(T0 + 12 * HOUR_MS, NEXT_DAY, morning.geoWeightSpent);
    expect(afternoon.addedE).toBe(0);
    expect(quantizeE(morning.addedE + afternoon.addedE)).toBe(CAP);

    // And this is what the bug looked like: drop the carry and the second half of the very
    // same UTC day pays the whole cap over again.
    expect(tick(T0 + 12 * HOUR_MS, NEXT_DAY, null).addedE).toBe(CAP);
  });

  it('contributes no GEO at all when the day is already spent', () => {
    const evidence = tick(T0 + 12 * HOUR_MS, T0 + 18 * HOUR_MS, {
      utcDayStartMs: T0,
      weight: CAP,
    });
    expect(evidence.addedE).toBe(0);
    expect(evidence.passes.every((pass) => pass.verdict === 'geo_gated')).toBe(true);
    // A gated slot was never an opportunity to see the fire, so it must not reset the
    // unobservability count either.
    expect(evidence.accumulableOpportunities).toBe(0);
  });

  it('tops a partial balance up to exactly the cap and no further', () => {
    const evidence = tick(T0, T0 + HOUR_MS, { utcDayStartMs: T0, weight: CAP - 0.1 });
    // Two slots fit in the remaining 0.1; the other ten in the hour are gated.
    expect(evidence.passes.filter((pass) => pass.verdict === 'counted')).toHaveLength(2);
    expect(evidence.addedE).toBe(quantizeE(2 * SLOT));
    expect(evidence.geoWeightSpent).toEqual({ utcDayStartMs: T0, weight: CAP });
  });

  it('lets a balance from the previous UTC day restrict nothing', () => {
    // "A balance naming an earlier day is spent." Yesterday's exhausted cap must not
    // silence today, or one busy day would mute the sensor for the rest of the fire.
    const evidence = tick(T0, T0 + 4 * HOUR_MS, { utcDayStartMs: T0 - DAY_MS, weight: CAP });
    expect(evidence.addedE).toBe(CAP);
    expect(evidence.geoWeightSpent).toEqual({ utcDayStartMs: T0, weight: CAP });
  });

  it('reports the balance against the day the window ends *in*, not the day it ends *at*', () => {
    // The window is half-open, so a window closing at midnight spent its weight on the day
    // before. Naming the day it never reached would hand the next tick a balance for a day
    // it is about to start fresh.
    const evidence = tick(T0, NEXT_DAY, null);
    expect(evidence.geoWeightSpent).toEqual({ utcDayStartMs: T0, weight: CAP });
  });

  it('keeps a live balance across a window that spends nothing on it', () => {
    // Every slot behind thick cloud: nothing is added, but the day is still as spent as it
    // was, and reporting `null` here would restart the cap on the next tick.
    const evidence = accumulateMissEvidence(
      inputFor({
        event: {
          lastFrpMw: GATE_MW * 2,
          lastDetectionAtMs: T0 - HOUR_MS,
          geoWeightSpent: { utcDayStartMs: T0, weight: 0.4 },
        },
        fromMs: T0,
        toMs: T0 + HOUR_MS,
        cloud: sky(95, T0, T0 + HOUR_MS),
      }),
    );
    expect(evidence.addedE).toBe(0);
    expect(evidence.geoWeightSpent).toEqual({ utcDayStartMs: T0, weight: 0.4 });
  });

  it('reports null when nothing was carried in and nothing was spent', () => {
    // `run()` leaves `lastFrpMw` null, so the FRP gate is shut and no slot weighs anything:
    // there is no balance to keep and nothing for the next tick to continue.
    const gated = run();
    expect(gated.addedE).toBe(0);
    expect(gated.geoWeightSpent).toBeNull();
  });

  it('carries the balance forward day by day without leaking across the boundary', () => {
    const first = tick(T0, NEXT_DAY, null);
    const second = tick(NEXT_DAY, NEXT_DAY + DAY_MS, first.geoWeightSpent);
    expect(second.addedE).toBe(CAP);
    expect(second.geoWeightSpent).toEqual({ utcDayStartMs: NEXT_DAY, weight: CAP });
  });

  it('rejects a carried balance that does not name a UTC midnight', () => {
    expect(() => tick(T0, T0 + HOUR_MS, { utcDayStartMs: T0 + HOUR_MS, weight: 0.2 })).toThrow(
      /UTC midnight/,
    );
  });

  it('rejects a carried balance with an impossible weight', () => {
    expect(() => tick(T0, T0 + HOUR_MS, { utcDayStartMs: T0, weight: -1 })).toThrow(/non-negative/);
  });
});

describe('phasesWithMisses', () => {
  it('is in DIURNAL_PHASES order regardless of the order the misses arrived in', () => {
    const evidence = run({
      passes: [
        { source: 'firms:viirs:snpp', atMs: MIDNIGHT, phase: 'night' },
        { source: 'firms:viirs:noaa20', atMs: NOON, phase: 'day' },
      ],
    });
    expect(evidence.phasesWithMisses).toEqual(['day', 'night']);
  });

  it('reports only the phases that actually produced a weighed miss', () => {
    const evidence = run({
      passes: [
        { source: 'firms:viirs:snpp', atMs: MIDNIGHT, phase: 'night' },
        { source: 'firms:viirs:noaa20', atMs: NOON, phase: 'day' },
      ],
      outages: [{ source: 'firms:viirs:noaa20', fromMs: T0, toMs: T0 + DAY_MS }],
    });
    expect(evidence.phasesWithMisses).toEqual(['night']);
  });

  it('does not count a cloud-blocked pass as a miss in its phase', () => {
    const evidence = run({
      passes: [
        { source: 'firms:viirs:snpp', atMs: MIDNIGHT, phase: 'night' },
        { source: 'firms:viirs:noaa20', atMs: NOON, phase: 'day' },
      ],
      cloud: [...sky(0, T0, NOON), ...sky(95, NOON, T0 + DAY_MS)],
    });
    expect(evidence.phasesWithMisses).toEqual(['night']);
  });
});

describe('trailingUnobservableDays', () => {
  const FROM = T0;
  const TO = T0 + 5 * DAY_MS;

  it('counts every whole UTC day of total cloud at the end of the window', () => {
    const evidence = run({
      passes: [
        { source: 'firms:viirs:snpp', atMs: T0 + 2 * HOUR_MS, phase: 'night' },
        { source: 'firms:viirs:snpp', atMs: T0 + 3 * DAY_MS, phase: 'night' },
      ],
      fromMs: FROM,
      toMs: TO,
      cloud: [...sky(0, FROM, T0 + DAY_MS), ...sky(100, T0 + DAY_MS, TO)],
    });
    // Days 1..4 have no accumulable opportunity; day 0 had one.
    expect(evidence.trailingUnobservableDays).toBe(4);
  });

  it('is 0 when the last whole day had an opportunity', () => {
    const evidence = run({
      passes: [{ source: 'firms:viirs:snpp', atMs: T0 + 4 * DAY_MS + HOUR_MS, phase: 'night' }],
      fromMs: FROM,
      toMs: TO,
      cloud: sky(0, FROM, TO),
    });
    expect(evidence.trailingUnobservableDays).toBe(0);
  });

  it('is 0 when only the partial tail could see — we can see now', () => {
    const to = TO + 6 * HOUR_MS;
    const evidence = run({
      passes: [{ source: 'firms:viirs:snpp', atMs: TO + HOUR_MS, phase: 'night' }],
      fromMs: FROM,
      toMs: to,
      cloud: [...sky(100, FROM, TO), ...sky(0, TO, to)],
    });
    expect(evidence.trailingUnobservableDays).toBe(0);
  });

  it('counts the whole window when nothing ever had a chance', () => {
    const evidence = run({ fromMs: FROM, toMs: TO, cloud: sky(100, FROM, TO) });
    expect(evidence.trailingUnobservableDays).toBe(5);
  });

  it('is 0 for a window with no whole UTC day in it', () => {
    const evidence = run({ fromMs: T0 + HOUR_MS, toMs: T0 + 20 * HOUR_MS, cloud: [] });
    expect(evidence.trailingUnobservableDays).toBe(0);
  });

  it('reaches the fallback horizon under a fortnight of overcast', () => {
    const to = T0 + PARAMS.unobservableDays * DAY_MS;
    const evidence = run({ fromMs: T0, toMs: to, cloud: sky(100, T0, to) });
    expect(evidence.trailingUnobservableDays).toBe(PARAMS.unobservableDays);
  });
});

describe('the unobservable run is carried between ticks, not restarted by each window', () => {
  /** Runs `[fromMs, toMs)` as consecutive ticks of `stepMs`, threading the carry. */
  function ticked(
    fromMs: EpochMs,
    toMs: EpochMs,
    stepMs: number,
    options: Omit<RunOptions, 'fromMs' | 'toMs' | 'cloud'> & { readonly cloudPercent: number },
  ): MissEvidence[] {
    const out: MissEvidence[] = [];
    let blindSinceMs: EpochMs | null = null;
    for (let at = fromMs; at < toMs; at += stepMs) {
      const to = Math.min(at + stepMs, toMs);
      const evidence = run({
        ...options,
        event: { ...options.event, blindSinceMs },
        fromMs: at,
        toMs: to,
        cloud: sky(options.cloudPercent, at, to),
      });
      out.push(evidence);
      blindSinceMs = evidence.blindSinceMs;
    }
    return out;
  }

  it('THE REGRESSION: hourly ticks through a fortnight of overcast reach the horizon', () => {
    // The live worker ticks every poll. Counting whole days inside one window only, no
    // hourly window ever held one, the count stayed 0 and the fallback never fired.
    const to = T0 + PARAMS.unobservableDays * DAY_MS;
    const ticks = ticked(T0, to, HOUR_MS, { cloudPercent: 100 });
    expect(ticks.every((evidence) => evidence.blindSinceMs === T0)).toBe(true);
    expect(ticks.at(-1)?.trailingUnobservableDays).toBe(PARAMS.unobservableDays);
    expect(ticks.at(-2)?.trailingUnobservableDays).toBe(PARAMS.unobservableDays - 1);
  });

  it('counts the same days however the span is split into ticks', () => {
    const to = T0 + 6 * DAY_MS + 5 * HOUR_MS;
    const passes: readonly ExpectedPass[] = [
      { source: 'firms:viirs:snpp', atMs: T0 + DAY_MS + 3 * HOUR_MS, phase: 'night' },
      { source: 'firms:viirs:noaa20', atMs: T0 + 2 * DAY_MS + 13 * HOUR_MS, phase: 'day' },
    ];
    // Clear sky so both passes are opportunities; the days after them are blind only
    // because nothing else was scheduled.
    const whole = run({ passes, fromMs: T0, toMs: to, cloud: sky(0, T0, to) });
    for (const step of [HOUR_MS, 7 * HOUR_MS, DAY_MS, 2 * DAY_MS + 11 * HOUR_MS]) {
      const last = ticked(T0, to, step, { passes, cloudPercent: 0 }).at(-1);
      expect(last?.trailingUnobservableDays).toBe(whole.trailingUnobservableDays);
      expect(last?.blindSinceMs).toBe(whole.blindSinceMs);
    }
    expect(whole.trailingUnobservableDays).toBe(3);
    expect(whole.blindSinceMs).toBe(T0 + 3 * DAY_MS);
  });

  it('moves the carry to the UTC day after an opportunity, not to its instant', () => {
    const evidence = run({
      passes: [{ source: 'firms:viirs:snpp', atMs: NOON, phase: 'night' }],
      event: { blindSinceMs: T0 - 5 * DAY_MS },
    });
    expect(evidence.blindSinceMs).toBe(T0 + DAY_MS);
  });

  it('keeps the carry through a window without an opportunity', () => {
    const evidence = run({
      event: { blindSinceMs: T0 - 5 * DAY_MS },
      cloud: sky(100, T0, T0 + DAY_MS),
    });
    expect(evidence.blindSinceMs).toBe(T0 - 5 * DAY_MS);
    expect(evidence.trailingUnobservableDays).toBe(6);
  });

  it('starts a fresh event at its first window', () => {
    const evidence = run({ fromMs: T0 + HOUR_MS, toMs: T0 + 2 * HOUR_MS, cloud: [] });
    expect(evidence.blindSinceMs).toBe(T0 + HOUR_MS);
  });

  it('rejects a carried start that is not a finite instant', () => {
    expect(() => run({ event: { blindSinceMs: Number.NaN } })).toThrow(RangeError);
  });
});

describe('carrying evidence in from previous ticks', () => {
  it('adds the window to the running total, quantised', () => {
    const evidence = run({
      passes: [{ source: 'firms:viirs:snpp', atMs: NOON, phase: 'night' }],
      event: { accumulatedE: 1.7 },
    });
    expect(evidence.addedE).toBe(1.25);
    expect(evidence.e).toBe(quantizeE(1.7 + 1.25));
  });

  it('keeps `e === quantizeE(accumulatedE + addedE)` for a mixed window', () => {
    const evidence = run({
      passes: [
        { source: 'eumetsat:slstr:frp', atMs: T0 + HOUR_MS, phase: 'day' },
        { source: 'firms:modis', atMs: T0 + 5 * HOUR_MS, phase: 'night' },
        { source: 'firms:viirs:noaa21', atMs: T0 + 9 * HOUR_MS, phase: 'night' },
      ],
      event: { accumulatedE: 0.35, lastFrpMw: 200 },
    });
    expect(evidence.e).toBe(quantizeE(0.35 + evidence.addedE));
  });

  it('stamps the params and pass-table versions it ran under', () => {
    const evidence = run();
    expect(evidence.paramsVersion).toBe(LIFECYCLE_PARAMS.version);
    expect(evidence.tableVersion).toBe(TABLE_VERSION);
  });
});

describe('determinism', () => {
  const passes: readonly ExpectedPass[] = [
    { source: 'firms:viirs:snpp', atMs: T0 + 2 * HOUR_MS, phase: 'night' },
    { source: 'firms:viirs:noaa20', atMs: T0 + 11 * HOUR_MS, phase: 'day' },
    { source: 'eumetsat:slstr:frp', atMs: T0 + 11 * HOUR_MS, phase: 'day' },
    { source: 'firms:modis', atMs: T0 + 22 * HOUR_MS, phase: 'night' },
  ];
  const cloud = [...sky(30, T0, T0 + 12 * HOUR_MS), ...sky(65, T0 + 12 * HOUR_MS, T0 + DAY_MS)];
  const outages: readonly SourceOutage[] = [
    { source: 'firms:modis', fromMs: T0 + 20 * HOUR_MS, toMs: null },
    { source: 'firms:viirs:noaa21', fromMs: T0, toMs: T0 + HOUR_MS },
  ];
  const options: RunOptions = { passes, cloud, outages, event: { lastFrpMw: 90 } };

  it('produces the same value twice', () => {
    expect(run(options)).toStrictEqual(run(options));
  });

  it('does not depend on the order of the cloud samples', () => {
    const shuffled = [...cloud].toReversed();
    expect(run({ ...options, cloud: shuffled })).toStrictEqual(run(options));
  });

  it('does not depend on the order of the outage rows', () => {
    const shuffled = [...outages].toReversed();
    expect(run({ ...options, outages: shuffled })).toStrictEqual(run(options));
  });

  it('resolves a duplicated cloud hour to its cloudiest reading, whichever way round it arrives', () => {
    const pass: ExpectedPass = {
      source: 'firms:viirs:snpp',
      atMs: T0 + 30 * 60_000,
      phase: 'night',
    };
    const cloudy: CloudCoverSample = { hourStartMs: T0, percent: 95 };
    const clear: CloudCoverSample = { hourStartMs: T0, percent: 5 };
    const first = run({ passes: [pass], cloud: [cloudy, clear] });
    const second = run({ passes: [pass], cloud: [clear, cloudy] });
    expect(first).toStrictEqual(second);
    expect(first.addedE).toBe(0);
  });

  it('folds the passes in one stream sorted by instant then source', () => {
    const evidence = run({ ...options, event: { lastFrpMw: 90 } });
    const keys = evidence.passes.map((pass) => [pass.atMs, pass.source] as const);
    const sorted = [...keys].toSorted((a, b) => a[0] - b[0] || (a[1] < b[1] ? -1 : 1));
    expect(keys).toEqual(sorted);
  });
});

describe('window validation', () => {
  it('rejects a window that ends before it starts', () => {
    expect(() => run({ fromMs: T0, toMs: T0 - 1 })).toThrow(RangeError);
  });

  it('accepts an empty window and reports nothing', () => {
    const evidence = run({ fromMs: T0, toMs: T0, cloud: [] });
    expect(evidence.addedE).toBe(0);
    expect(evidence.passes).toEqual([]);
    expect(evidence.trailingUnobservableDays).toBe(0);
  });

  it('rejects a non-finite bound', () => {
    expect(() => run({ fromMs: Number.NaN, toMs: T0 })).toThrow(/finite/);
  });

  it('rejects a last FRP that is not a measurement', () => {
    expect(() => run({ event: { lastFrpMw: Number.POSITIVE_INFINITY } })).toThrow(/FRP/);
  });
});

describe('E is monotone in the number of misses', () => {
  // Cheap property: the accumulator may never reward a satellite for looking. Adding a
  // clear-sky overpass to a window can only raise E, and stripping every miss leaves it at
  // whatever was carried in.
  const source = fc.constantFrom(
    'firms:viirs:snpp' as const,
    'firms:viirs:noaa20' as const,
    'firms:modis' as const,
    'eumetsat:slstr:frp' as const,
  );
  const phase = fc.constantFrom('day' as const, 'night' as const);
  const pass = fc
    .record({ source, phase, hour: fc.integer({ min: 1, max: 23 }) })
    .map(({ source: s, phase: p, hour }) => ({ source: s, atMs: T0 + hour * HOUR_MS, phase: p }));

  it('never decreases when another expected pass is added', () => {
    fc.assert(
      fc.property(fc.array(pass, { maxLength: 8 }), pass, (base, extra) => {
        const before = run({ passes: base });
        const after = run({ passes: [...base, extra] });
        expect(after.addedE).toBeGreaterThanOrEqual(before.addedE);
      }),
      { numRuns: 60 },
    );
  });

  it('adds nothing at all when every pass is behind thick cloud', () => {
    fc.assert(
      fc.property(fc.array(pass, { maxLength: 8 }), (base) => {
        const evidence = run({ passes: base, cloud: sky(100, T0, T0 + DAY_MS) });
        expect(evidence.addedE).toBe(0);
      }),
      { numRuns: 40 },
    );
  });
});
