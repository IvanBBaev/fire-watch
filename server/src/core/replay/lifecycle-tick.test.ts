/**
 * The driver's own rules, pinned one at a time.
 *
 * Nothing here re-tests the accumulator's arithmetic or the state machine's gates — those
 * have their own suites, and duplicating them would leave two files to update the day a
 * threshold is refitted. What is under test is only what `lifecycle-tick.ts` decides for
 * itself: which carry an event starts from, which official statement is standing, when a
 * detection counts as having arrived, when E is dropped, what the snapshot leaves absent,
 * and that an event the tick was not handed survives the tick untouched.
 *
 * One test does run both rule modules end to end (`closes an event on miss evidence`),
 * because a driver that assembles a snapshot the accumulator quietly weighs at zero would
 * pass every other assertion in this file.
 *
 * The predictor is a hand-written stub: the constellation model is not what is being
 * checked, and a test whose expected E depends on where a satellite really is would have to
 * be re-authored every time the pass table is refitted.
 */

import { describe, expect, it } from 'vitest';

import type { Coordinate } from '../clustering/geometry.js';
import { LIFECYCLE_PARAMS } from '../config/lifecycle-params.js';
import type { CloudCoverSample, OfficialDeclaration } from '../lifecycle/types.js';
import { epochMsFromIso, type EpochMs } from '../ports/clock.js';
import type { ExpectedPass, PassPredictor, PassWindow } from '../ports/pass-predictor.js';
import {
  FRESH_CARRY,
  tickLifecycle,
  type LifecycleCarry,
  type LifecycleTickOutcome,
  type LifecycleTickRequest,
  type LifecycleTickResult,
  type TickEventInput,
} from './lifecycle-tick.js';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** UTC midnight, so every day boundary below is a round number the reader can check. */
const T0 = epochMsFromIso('2026-08-10T00:00:00.000Z');

const CENTROID: Coordinate = { lat: 42.13, lon: 24.75 };
const PUBLIC_ID = 'fw-2026-a1b2c';
const TABLE_VERSION = 'pass_table_stub_v1';

/**
 * A predictor answering from a fixed list, filtered to `[fromMs, toMs)` and sorted the way
 * the port promises — so a test can hand passes in any order without accidentally testing
 * the accumulator's tolerance of a broken predictor.
 */
function stubPredictor(passes: readonly ExpectedPass[] = []): PassPredictor {
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

/** No overpasses at all, so E is exactly whatever the carry held. */
const NO_PASSES = stubPredictor();

function tickEvent(overrides: Partial<TickEventInput> = {}): TickEventInput {
  return {
    publicId: PUBLIC_ID,
    centroid: CENTROID,
    lastDetectionAtMs: T0,
    lastDetectionSource: 'firms:viirs:noaa20',
    // Below 1.5 × the 30 MW GEO floor, so every geostationary slot in every window here is
    // `geo_gated` at zero weight and the only evidence in play is what a test states.
    lastFrpMw: null,
    maxFrpMw: null,
    declarations: [],
    ...overrides,
  };
}

function request(parts: Partial<LifecycleTickRequest> = {}): LifecycleTickRequest {
  return {
    atMs: T0 + DAY,
    sinceMs: T0,
    events: [tickEvent()],
    carry: new Map<string, LifecycleCarry>(),
    predictor: NO_PASSES,
    cloud: [],
    outages: [],
    ...parts,
  };
}

function carryOf(overrides: Partial<LifecycleCarry> = {}): LifecycleCarry {
  return { ...FRESH_CARRY, ...overrides };
}

function carryFor(outcome: LifecycleTickOutcome, publicId: string = PUBLIC_ID): LifecycleCarry {
  const carry = outcome.carry.get(publicId);
  if (carry === undefined) throw new Error(`the tick returned no carry for ${publicId}`);
  return carry;
}

function onlyResult(outcome: LifecycleTickOutcome): LifecycleTickResult {
  const [result] = outcome.results;
  if (result === undefined) throw new Error('the tick returned no result');
  return result;
}

const CONTAINED: OfficialDeclaration = {
  state: 'officially_contained',
  declaredAtMs: T0 + 6 * HOUR,
  attribution: 'РДПБЗН Пловдив',
};

const EXTINGUISHED: OfficialDeclaration = {
  state: 'officially_extinguished',
  declaredAtMs: T0 + 2 * HOUR,
  attribution: 'ГДПБЗН',
};

describe('FRESH_CARRY', () => {
  it('starts an event at active with no history and is frozen', () => {
    expect(FRESH_CARRY).toEqual({
      state: 'active',
      accumulatedE: 0,
      geoWeightSpent: null,
      blindSinceMs: null,
      inactiveSinceMs: null,
      officialDeclaration: null,
      lastDetectionAtMs: null,
    });
    expect(Object.isFrozen(FRESH_CARRY)).toBe(true);
  });

  it('is what a public_id the carry has never seen is ticked from', () => {
    const outcome = tickLifecycle(request());
    const { decision, evidence } = onlyResult(outcome);

    // `fromState` is the carry's state and `e` is its accumulated E, both straight out of
    // FRESH_CARRY: nothing else in this request supplies either.
    expect(decision.fromState).toBe('active');
    expect(evidence.e).toBe(0);
    // A brand-new event has no previously known acquisition, so its first detection reads
    // as an arrival — and the closed reason vocabulary's word for that is `redetection`.
    expect(decision.reason).toBe('redetection');
  });
});

describe('the carry the tick hands on', () => {
  it('leaves entries for events this tick was not handed untouched', () => {
    const absent = carryOf({ accumulatedE: 2, lastDetectionAtMs: T0 - DAY });
    const outcome = tickLifecycle(
      request({
        carry: new Map<string, LifecycleCarry>([
          [PUBLIC_ID, carryOf({ lastDetectionAtMs: T0 })],
          ['fw-2026-other', absent],
        ]),
      }),
    );

    // Identity, not equality: an engine that rebuilt the entry could rebuild it wrongly,
    // and the property is that this tick did not touch it at all.
    expect(outcome.carry.get('fw-2026-other')).toBe(absent);
    // ...and the event that *was* ticked did get a new entry.
    expect(outcome.carry.get(PUBLIC_ID)).not.toBe(absent);
    expect(outcome.results).toHaveLength(1);
  });

  it('carries state, E, the GEO balance, the anchor and the statement out of the decision', () => {
    const declaration: OfficialDeclaration = { ...CONTAINED, declaredAtMs: T0 + HOUR };
    const outcome = tickLifecycle(
      request({
        events: [tickEvent({ declarations: [declaration] })],
        carry: new Map([[PUBLIC_ID, carryOf({ accumulatedE: 1.25, lastDetectionAtMs: T0 })]]),
      }),
    );
    const { decision, evidence } = onlyResult(outcome);

    expect(carryFor(outcome)).toEqual({
      state: decision.state,
      // No detection arrived, so E is the decision's — the 1.25 carried in plus the nothing
      // this window's absent passes added.
      accumulatedE: 1.25,
      geoWeightSpent: evidence.geoWeightSpent,
      blindSinceMs: evidence.blindSinceMs,
      inactiveSinceMs: decision.inactiveSinceMs,
      officialDeclaration: declaration,
      lastDetectionAtMs: T0,
    });
  });

  it("records the event's newest acquisition every tick, arrival or not", () => {
    const outcome = tickLifecycle(
      request({
        events: [tickEvent({ lastDetectionAtMs: T0 + 5 * HOUR })],
        carry: new Map([[PUBLIC_ID, carryOf({ lastDetectionAtMs: T0 })]]),
      }),
    );

    expect(carryFor(outcome).lastDetectionAtMs).toBe(T0 + 5 * HOUR);
  });
});

describe('when a detection counts as having arrived', () => {
  it('resets accumulated E on an arrival while the decision still reports the E it was computed on', () => {
    const outcome = tickLifecycle(
      request({
        events: [tickEvent({ lastDetectionAtMs: T0 + 12 * HOUR })],
        carry: new Map([[PUBLIC_ID, carryOf({ accumulatedE: 2.5, lastDetectionAtMs: T0 })]]),
      }),
    );
    const { decision } = onlyResult(outcome);

    expect(decision.reason).toBe('redetection');
    // 2.5 carried in, nothing added: the stub expects no passes and the null FRP gates
    // every GEO slot. The decision keeps that number because it is provenance...
    expect(decision.e).toBe(2.5);
    // ...and the carry drops it, because a pixel answered every miss inside it.
    expect(carryFor(outcome).accumulatedE).toBe(0);
  });

  it('does not read a late row with an older acquisition as an arrival', () => {
    // The 06:00 acquisition was already known; this poll delivered a 02:00 row that had
    // been sitting in a provider queue. It says the fire was seen at a moment we had
    // already accounted for, so it must not void evidence accrued after 06:00.
    const outcome = tickLifecycle(
      request({
        sinceMs: T0 + 6 * HOUR,
        events: [tickEvent({ lastDetectionAtMs: T0 + 2 * HOUR })],
        carry: new Map([
          [PUBLIC_ID, carryOf({ accumulatedE: 2.5, lastDetectionAtMs: T0 + 6 * HOUR })],
        ]),
      }),
    );
    const { decision } = onlyResult(outcome);

    expect(decision.reason).not.toBe('redetection');
    // Nothing looked in this window at all — no expected pass, every GEO slot gated — so
    // the diagnosis is that there was no opportunity, not that the fire was seen.
    expect(decision.reason).toBe('no_opportunity');
    expect(carryFor(outcome).accumulatedE).toBe(2.5);
  });

  it('measures the T_LINK gap against the acquisition the previous tick knew about', () => {
    // A self-comparison would make the gap zero for every event forever. The snapshot
    // therefore carries the *previous* acquisition, so a 30 h gap is a 30 h gap — inside
    // T_LINK (48 h), so the event returns to `active`.
    const outcome = tickLifecycle(
      request({
        atMs: T0 + 2 * DAY,
        sinceMs: T0 + DAY,
        events: [tickEvent({ lastDetectionAtMs: T0 + 30 * HOUR })],
        carry: new Map([[PUBLIC_ID, carryOf({ lastDetectionAtMs: T0 })]]),
      }),
    );
    const { decision, evidence } = onlyResult(outcome);

    expect(decision.state).toBe('active');
    expect(decision.reason).toBe('redetection');
    // The accumulator was handed the pre-arrival instant too: the window opens at T0 + 24 h,
    // which is after T0 and so is weighed rather than dismissed as already detected.
    expect(evidence.windowFromMs).toBe(T0 + DAY);
  });
});

describe('the standing official declaration', () => {
  it('applies the newest statement at or before the tick instant, whatever order they were listed in', () => {
    // Listed newest-first on purpose: the answer must come from `declaredAtMs`, not from
    // where the fixture happened to put the row.
    const outcome = tickLifecycle(
      request({
        events: [tickEvent({ declarations: [CONTAINED, EXTINGUISHED] })],
        carry: new Map([[PUBLIC_ID, carryOf({ lastDetectionAtMs: T0 })]]),
      }),
    );
    const { decision } = onlyResult(outcome);

    expect(decision.state).toBe('officially_contained');
    expect(decision.officialDeclaration).toBe(CONTAINED);
    expect(carryFor(outcome).state).toBe('officially_contained');
  });

  it('does not let a statement dated after the tick instant leak into the snapshot', () => {
    const future: OfficialDeclaration = { ...CONTAINED, declaredAtMs: T0 + DAY + HOUR };
    const outcome = tickLifecycle(
      request({
        events: [tickEvent({ declarations: [future] })],
        carry: new Map([[PUBLIC_ID, carryOf({ lastDetectionAtMs: T0 })]]),
      }),
    );
    const { decision } = onlyResult(outcome);

    expect(decision.state).toBe('active');
    expect(decision.officialDeclaration).toBeNull();
  });

  it('treats a statement made at exactly the tick instant as standing', () => {
    const now: OfficialDeclaration = { ...CONTAINED, declaredAtMs: T0 + DAY };
    const outcome = tickLifecycle(
      request({
        events: [tickEvent({ declarations: [now] })],
        carry: new Map([[PUBLIC_ID, carryOf({ lastDetectionAtMs: T0 })]]),
      }),
    );

    expect(onlyResult(outcome).decision.state).toBe('officially_contained');
  });

  it('resolves two statements bearing the same instant identically in either order', () => {
    const a: OfficialDeclaration = { ...CONTAINED, declaredAtMs: T0 + 3 * HOUR };
    const b: OfficialDeclaration = { ...EXTINGUISHED, declaredAtMs: T0 + 3 * HOUR };
    const carry = new Map([[PUBLIC_ID, carryOf({ lastDetectionAtMs: T0 })]]);

    const forward = tickLifecycle(
      request({ events: [tickEvent({ declarations: [a, b] })], carry }),
    );
    const reverse = tickLifecycle(
      request({ events: [tickEvent({ declarations: [b, a] })], carry }),
    );

    // `officially_contained` < `officially_extinguished` by code unit, so the sort's last
    // entry is the extinguishment either way. Which one wins matters less than that it is
    // the same one when the array is shuffled.
    expect(onlyResult(forward).decision.state).toBe('officially_extinguished');
    expect(onlyResult(reverse).decision.state).toBe('officially_extinguished');
  });

  it('returns an officially_* event to active on an arrival and keeps the statement standing', () => {
    // A2.2: a detection outranks the inference, but satellite data never *clears* an
    // attributed statement — so the state moves and the declaration is carried verbatim.
    const outcome = tickLifecycle(
      request({
        events: [tickEvent({ lastDetectionAtMs: T0 + 12 * HOUR, declarations: [EXTINGUISHED] })],
        carry: new Map([
          [
            PUBLIC_ID,
            carryOf({
              state: 'officially_extinguished',
              officialDeclaration: EXTINGUISHED,
              inactiveSinceMs: T0 + 2 * HOUR,
              lastDetectionAtMs: T0,
            }),
          ],
        ]),
      }),
    );
    const { decision } = onlyResult(outcome);

    expect(decision.state).toBe('active');
    expect(decision.reason).toBe('redetection');
    expect(decision.officialDeclaration).toBe(EXTINGUISHED);
    // Back among the detected states, so the display-window anchor is cleared.
    expect(carryFor(outcome)).toMatchObject({
      state: 'active',
      inactiveSinceMs: null,
      officialDeclaration: EXTINGUISHED,
    });
  });

  it('does not re-apply a statement the carry already holds, so the return to active lasts', () => {
    // A2.2 returns the event to `active` and has it "continue to display" the statement
    // after that return. A statement re-applied every tick would instead make the return
    // last exactly one tick, and S12 — detections at <t>, official declaration at <t0>,
    // adjudicating neither — would have no state to assert.
    const event = tickEvent({ lastDetectionAtMs: T0 + 12 * HOUR, declarations: [EXTINGUISHED] });
    const returned = tickLifecycle(
      request({
        events: [event],
        carry: new Map([
          [
            PUBLIC_ID,
            carryOf({
              state: 'officially_extinguished',
              officialDeclaration: EXTINGUISHED,
              inactiveSinceMs: T0 + 2 * HOUR,
              lastDetectionAtMs: T0,
            }),
          ],
        ]),
      }),
    );

    // The next poll brings nothing new: same acquisition, same standing statement.
    const after = tickLifecycle(
      request({
        atMs: T0 + DAY + 6 * HOUR,
        sinceMs: T0 + DAY,
        events: [event],
        carry: returned.carry,
      }),
    );
    const { decision } = onlyResult(after);

    expect(decision.fromState).toBe('active');
    expect(decision.state).toBe('active');
    expect(decision.officialDeclaration).toBe(EXTINGUISHED);
  });
});

describe('the snapshot the rules are handed', () => {
  it('decides largeness from maxFrpMw alone, because nothing here computes a hull area', () => {
    const carry = new Map([[PUBLIC_ID, carryOf({ lastDetectionAtMs: T0 })]]);

    const unmeasured = tickLifecycle(request({ events: [tickEvent({ maxFrpMw: null })], carry }));
    const bright = tickLifecycle(request({ events: [tickEvent({ maxFrpMw: 150 })], carry }));

    // No land-cover classifier and no hull geometry reach this driver, so `hullAreaHa` is
    // null and `peatOrLandfill` is false on every snapshot it builds. The only criterion
    // left is FRP against the 100 MW bar, and it is the one a fixture can read off its
    // own input.
    expect(onlyResult(unmeasured).decision.large).toBe(false);
    expect(onlyResult(unmeasured).decision.eThreshold).toBe(LIFECYCLE_PARAMS.values.eThreshold);
    expect(onlyResult(bright).decision.large).toBe(true);
    expect(onlyResult(bright).decision.eThreshold).toBe(LIFECYCLE_PARAMS.values.eThresholdLarge);
  });
});

describe('running the real rules over a window', () => {
  it('closes an event on miss evidence the accumulator weighed in this window', () => {
    // Two VIIRS overpasses in a clear sky, on the second day after the last detection: a
    // missed day pass is 1.00 and a missed night pass 1.25, so this window adds 2.25 to
    // the 0.75 carried in and E lands on exactly the 3.0 threshold. The dwell is 48 h
    // (over the 24 h floor) and both diurnal phases are represented, so all three of the
    // transition's conditions are met.
    const dayPass = T0 + DAY + 6 * HOUR;
    const nightPass = T0 + DAY + 18 * HOUR;
    const cloud: readonly CloudCoverSample[] = [
      { hourStartMs: dayPass, percent: 0 },
      { hourStartMs: nightPass, percent: 0 },
    ];
    const outcome = tickLifecycle(
      request({
        atMs: T0 + 2 * DAY,
        sinceMs: T0 + DAY,
        events: [tickEvent()],
        carry: new Map([[PUBLIC_ID, carryOf({ accumulatedE: 0.75, lastDetectionAtMs: T0 })]]),
        predictor: stubPredictor([
          { source: 'firms:viirs:noaa20', atMs: dayPass, phase: 'day' },
          { source: 'firms:viirs:noaa20', atMs: nightPass, phase: 'night' },
        ]),
        cloud,
      }),
    );
    const { decision, evidence } = onlyResult(outcome);

    expect(evidence.addedE).toBe(2.25);
    expect(evidence.e).toBe(3);
    expect(decision.state).toBe('no_longer_detected');
    expect(decision.reason).toBe('miss_evidence');
    // A1.3: the transition is what opens the 48 h display window, so the anchor is this
    // tick's instant and the event is still drawn.
    expect(decision.inactiveSinceMs).toBe(T0 + 2 * DAY);
    expect(decision.displayTier).toBe('map');
    expect(carryFor(outcome)).toMatchObject({
      state: 'no_longer_detected',
      accumulatedE: 3,
      inactiveSinceMs: T0 + 2 * DAY,
    });
  });

  it('returns one result per event, in input order', () => {
    const zulu = tickEvent({ publicId: 'fw-2026-zulu9' });
    const alpha = tickEvent({ publicId: 'fw-2026-alpha' });
    const outcome = tickLifecycle(request({ events: [zulu, alpha] }));

    // Input order, not sorted order and not the carry's iteration order: a fixture reads
    // the results positionally against the events it listed.
    expect(outcome.results.map((result) => result.decision.publicId)).toEqual([
      'fw-2026-zulu9',
      'fw-2026-alpha',
    ]);
    expect(outcome.results.map((result) => result.evidence.publicId)).toEqual([
      'fw-2026-zulu9',
      'fw-2026-alpha',
    ]);
  });
});

describe('validation', () => {
  it('rejects a non-finite tick instant', () => {
    expect(() => tickLifecycle(request({ atMs: Number.NaN }))).toThrow(
      /lifecycle tick instant must be a finite epoch millisecond, got NaN/,
    );
  });

  it('rejects a non-finite window start', () => {
    expect(() => tickLifecycle(request({ sinceMs: Number.POSITIVE_INFINITY }))).toThrow(
      /window must start at a finite epoch millisecond, got Infinity/,
    );
  });

  it('rejects a window that ends before it starts', () => {
    expect(() => tickLifecycle(request({ sinceMs: T0 + DAY, atMs: T0 }))).toThrow(
      /window ends before it starts/,
    );
  });

  it('rejects the same public_id twice in one tick, naming it', () => {
    expect(() =>
      tickLifecycle(request({ events: [tickEvent(), tickEvent({ maxFrpMw: 10 })] })),
    ).toThrow(new RegExp(`${PUBLIC_ID} appears twice`));
  });
});
