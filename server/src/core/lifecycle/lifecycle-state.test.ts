import {
  LIFECYCLE_STATES,
  MACHINE_LIFECYCLE_STATES,
  isCuratedLifecycleState,
} from '@fire-watch/contracts';
import type { LifecycleState } from '@fire-watch/contracts';
import { describe, expect, it } from 'vitest';

import { CLUSTERING_PARAMS } from '../clustering/clustering-params.js';
import { LIFECYCLE_PARAMS, type LifecycleParams } from '../config/lifecycle-params.js';
import { defineConfig, type VersionedConfig } from '../config/versioned-config.js';
import { epochMsFromIso, type EpochMs } from '../ports/clock.js';
import {
  SIGNAL_WEAKENING_THRESHOLD_FRACTION,
  decideLifecycle,
  displayTierFor,
  eThresholdFor,
  isLargeEvent,
  signalWeakeningThreshold,
  type LifecycleTickInput,
} from './lifecycle-state.js';
import type {
  EventObservationSnapshot,
  MissEvidence,
  OfficialDeclaration,
  WeighedPass,
} from './types.js';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** The last detection. Every instant in this file is expressed relative to it. */
const SEEN = epochMsFromIso('2026-08-14T00:00:00Z');
const T_LINK_MS = CLUSTERING_PARAMS.values.tLinkHours * HOUR;

/**
 * When an already-closed event went inactive: two hours past the 24 h dwell, which is the
 * earliest a real tick could have written the transition. Every A1.3 boundary below is
 * measured from here rather than from {@link SEEN} — that gap is the whole correction.
 */
const INACTIVE = SEEN + 26 * HOUR;

const PUBLIC_ID = 'fw-2026-a1b2c';

const DECLARATION: OfficialDeclaration = {
  state: 'officially_extinguished',
  declaredAtMs: SEEN - 6 * HOUR,
  attribution: 'ГДПБЗН, РДПБЗН Хасково',
};

function snapshot(overrides: Partial<EventObservationSnapshot> = {}): EventObservationSnapshot {
  return {
    publicId: PUBLIC_ID,
    state: 'active',
    centroid: { lat: 41.9, lon: 25.55 },
    lastDetectionAtMs: SEEN,
    lastFrpMw: 12,
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

/** One weighed pass, only ever used to make `accumulableOpportunities` non-zero honestly. */
const COUNTED_PASS: WeighedPass = {
  source: 'firms:viirs:noaa20',
  atMs: SEEN + 6 * HOUR,
  phase: 'day',
  verdict: 'counted',
  weight: 1,
};

function evidence(overrides: Partial<MissEvidence> = {}): MissEvidence {
  return {
    publicId: PUBLIC_ID,
    windowFromMs: SEEN,
    windowToMs: SEEN + DAY,
    e: 0,
    addedE: 0,
    passes: [COUNTED_PASS],
    phasesWithMisses: ['day', 'night'],
    accumulableOpportunities: 1,
    trailingUnobservableDays: 0,
    blindSinceMs: SEEN,
    geoWeightSpent: null,
    paramsVersion: LIFECYCLE_PARAMS.version,
    tableVersion: 'pass_table_v0',
    ...overrides,
  };
}

function tick(parts: {
  readonly event?: Partial<EventObservationSnapshot>;
  readonly evidence?: Partial<MissEvidence>;
  readonly atMs?: EpochMs;
  readonly redetection?: LifecycleTickInput['redetection'];
}): LifecycleTickInput {
  return {
    event: snapshot(parts.event),
    evidence: evidence(parts.evidence),
    atMs: parts.atMs ?? SEEN + DAY,
    redetection: parts.redetection ?? null,
  };
}

/** A params override, kept a `VersionedConfig` so the decision still stamps a real version. */
function withParams(overrides: Partial<LifecycleParams>): VersionedConfig<LifecycleParams> {
  return defineConfig('lifecycle_params', 'lifecycle_params_v9', {
    ...LIFECYCLE_PARAMS.values,
    ...overrides,
  });
}

describe('the three transition conditions', () => {
  it('transitions at exactly the threshold with both hard conditions met', () => {
    const decision = decideLifecycle(tick({ evidence: { e: 3.0 }, atMs: SEEN + 24 * HOUR }));

    expect(decision.state).toBe('no_longer_detected');
    expect(decision.reason).toBe('miss_evidence');
    expect(decision.e).toBe(3.0);
    expect(decision.eThreshold).toBe(3.0);
    expect(decision.large).toBe(false);
    expect(decision.excludedFromFer).toBe(false);
    expect(decision.fromState).toBe('active');
  });

  it('refuses at 23 h even with E met and both phases', () => {
    const decision = decideLifecycle(tick({ evidence: { e: 10 }, atMs: SEEN + 23 * HOUR }));

    expect(decision.state).not.toBe('no_longer_detected');
    expect(decision.state).toBe('signal_weakening');
    expect(decision.reason).toBe('insufficient_evidence');
  });

  it('refuses with only one diurnal phase, however long the dwell', () => {
    const decision = decideLifecycle(
      tick({ evidence: { e: 10, phasesWithMisses: ['day'] }, atMs: SEEN + 5 * DAY }),
    );

    expect(decision.state).toBe('signal_weakening');
    expect(decision.reason).toBe('insufficient_evidence');
  });

  it('refuses at 2.999 with both hard conditions met', () => {
    const decision = decideLifecycle(tick({ evidence: { e: 2.999 }, atMs: SEEN + 24 * HOUR }));

    expect(decision.state).toBe('signal_weakening');
    // Reported E is `quantizeE`'s output, and multiplying the quantum back is not exact for
    // every value (2.999 comes back as 2.9989999999999997). That is harmless precisely
    // because the threshold comparison quantises both sides, so it is the same number on
    // both — asserting an exact float here would be asserting a rounding artefact.
    expect(decision.e).toBeCloseTo(2.999, 9);
  });

  it('honours requireBothDiurnalPhases as a parameter, not as a hard-coded rule', () => {
    const input = tick({
      evidence: { e: 3.0, phasesWithMisses: ['night'] },
      atMs: SEEN + 24 * HOUR,
    });

    expect(decideLifecycle(input).state).toBe('signal_weakening');
    expect(decideLifecycle(input, withParams({ requireBothDiurnalPhases: false })).state).toBe(
      'no_longer_detected',
    );
  });

  it('reads the dwell condition from the parameter table', () => {
    const input = tick({ evidence: { e: 3.0 }, atMs: SEEN + 23 * HOUR });

    expect(decideLifecycle(input).state).toBe('signal_weakening');
    expect(decideLifecycle(input, withParams({ minHoursSinceLastDetection: 12 })).state).toBe(
      'no_longer_detected',
    );
  });
});

describe('large events', () => {
  const AT = SEEN + 24 * HOUR;

  it('needs 5.0 where a small event needs 3.0', () => {
    const big = { maxFrpMw: 120 };

    expect(decideLifecycle(tick({ event: big, evidence: { e: 4.9 }, atMs: AT })).state).toBe(
      'signal_weakening',
    );
    const closed = decideLifecycle(tick({ event: big, evidence: { e: 5.0 }, atMs: AT }));
    expect(closed.state).toBe('no_longer_detected');
    expect(closed.eThreshold).toBe(5.0);
    expect(closed.large).toBe(true);

    const small = decideLifecycle(tick({ evidence: { e: 4.9 }, atMs: AT }));
    expect(small.state).toBe('no_longer_detected');
    expect(small.eThreshold).toBe(3.0);
    expect(small.large).toBe(false);
  });

  it('is made large by each criterion independently', () => {
    expect(isLargeEvent(snapshot({ hullAreaHa: 100 }))).toBe(true);
    expect(isLargeEvent(snapshot({ maxFrpMw: 100 }))).toBe(true);
    expect(isLargeEvent(snapshot({ peatOrLandfill: true }))).toBe(true);
  });

  it('is not made large by a metric just below the criterion', () => {
    expect(isLargeEvent(snapshot({ hullAreaHa: 99.99 }))).toBe(false);
    expect(isLargeEvent(snapshot({ maxFrpMw: 99.99 }))).toBe(false);
  });

  it('is not made large by null metrics — unmeasured is not small and not large', () => {
    const unmeasured = snapshot({ hullAreaHa: null, maxFrpMw: null, peatOrLandfill: false });
    expect(isLargeEvent(unmeasured)).toBe(false);
    expect(eThresholdFor(isLargeEvent(unmeasured))).toBe(3.0);
  });

  it('takes the peat criterion from the parameter table', () => {
    const peat = snapshot({ peatOrLandfill: true });
    expect(isLargeEvent(peat, LIFECYCLE_PARAMS.values)).toBe(true);
    expect(
      isLargeEvent(peat, {
        ...LIFECYCLE_PARAMS.values,
        largeEvent: { ...LIFECYCLE_PARAMS.values.largeEvent, peatOrLandfillIsLarge: false },
      }),
    ).toBe(false);
  });
});

describe('A2.3(3) — the unobservability fallback', () => {
  const BLIND = SEEN + 14 * DAY;
  const blindEvidence = {
    e: 0.25,
    trailingUnobservableDays: 14,
    accumulableOpportunities: 0,
    passes: [],
    phasesWithMisses: [],
  } satisfies Partial<MissEvidence>;

  it('closes the event regardless of E, and keeps the transition out of FER', () => {
    const decision = decideLifecycle(tick({ evidence: blindEvidence, atMs: BLIND }));

    expect(decision.state).toBe('no_longer_detected');
    expect(decision.reason).toBe('unobservable');
    expect(decision.excludedFromFer).toBe(true);
    expect(decision.e).toBe(0.25);
    expect(decision.e).toBeLessThan(decision.eThreshold);
  });

  it('does not fire while there were detections inside the period', () => {
    const decision = decideLifecycle(tick({ evidence: blindEvidence, atMs: SEEN + 10 * DAY }));

    expect(decision.state).not.toBe('no_longer_detected');
    expect(decision.reason).toBe('no_opportunity');
    expect(decision.excludedFromFer).toBe(false);
  });

  it('does not fire while an accumulable opportunity existed', () => {
    const decision = decideLifecycle(
      tick({
        evidence: {
          ...blindEvidence,
          trailingUnobservableDays: 13,
          accumulableOpportunities: 1,
          passes: [COUNTED_PASS],
        },
        atMs: BLIND,
      }),
    );

    expect(decision.state).not.toBe('no_longer_detected');
    expect(decision.reason).toBe('insufficient_evidence');
  });

  it('reads the 14 from the parameter table', () => {
    const input = tick({
      evidence: { ...blindEvidence, trailingUnobservableDays: 7 },
      atMs: SEEN + 7 * DAY,
    });

    expect(decideLifecycle(input).state).toBe('active');
    expect(decideLifecycle(input, withParams({ unobservableDays: 7 })).reason).toBe('unobservable');
  });

  it('yields to the miss-evidence transition when both would fire, so FER still counts it', () => {
    const decision = decideLifecycle(
      tick({
        evidence: { ...blindEvidence, e: 3.0, phasesWithMisses: ['day', 'night'] },
        atMs: BLIND,
      }),
    );

    expect(decision.state).toBe('no_longer_detected');
    expect(decision.reason).toBe('miss_evidence');
    expect(decision.excludedFromFer).toBe(false);
  });
});

describe('A2.2 — the officially_* states are not terminal', () => {
  const official = {
    state: 'officially_extinguished',
    officialDeclaration: DECLARATION,
  } satisfies Partial<EventObservationSnapshot>;

  it('returns to active on a redetection at exactly T_LINK, declaration intact', () => {
    const at = SEEN + T_LINK_MS;
    const decision = decideLifecycle(
      tick({
        event: official,
        atMs: at,
        redetection: { atMs: at, source: 'firms:viirs:snpp' },
      }),
    );

    expect(decision.fromState).toBe('officially_extinguished');
    expect(decision.state).toBe('active');
    expect(decision.displayTier).toBe('map');
    expect(decision.reason).toBe('redetection');
    expect(decision.officialDeclaration).toEqual({
      state: 'officially_extinguished',
      declaredAtMs: SEEN - 6 * HOUR,
      attribution: 'ГДПБЗН, РДПБЗН Хасково',
    });
  });

  it("does not transition one millisecond past T_LINK — that is the identity engine's call", () => {
    const at = SEEN + T_LINK_MS + 1;
    const decision = decideLifecycle(
      tick({
        event: official,
        atMs: at,
        redetection: { atMs: at, source: 'firms:viirs:snpp' },
      }),
    );

    expect(decision.state).toBe('officially_extinguished');
    expect(decision.reason).toBe('no_change');
    expect(decision.officialDeclaration).toEqual(DECLARATION);
  });

  it('returns an officially_contained event to active too', () => {
    const at = SEEN + HOUR;
    const decision = decideLifecycle(
      tick({
        event: {
          state: 'officially_contained',
          officialDeclaration: { ...DECLARATION, state: 'officially_contained' },
        },
        atMs: at,
        redetection: { atMs: at, source: 'lsasaf:fci:frp-pixel' },
      }),
    );

    expect(decision.state).toBe('active');
    expect(decision.reason).toBe('redetection');
  });

  it('never clears a curated state on miss evidence, however much of it there is', () => {
    const decision = decideLifecycle(
      tick({ event: official, evidence: { e: 50 }, atMs: SEEN + 30 * DAY }),
    );

    expect(decision.state).toBe('officially_extinguished');
    expect(decision.officialDeclaration).toEqual(DECLARATION);
  });

  it('keeps a declaration on an event satellite data has already returned to active', () => {
    const decision = decideLifecycle(
      tick({ event: { state: 'active', officialDeclaration: DECLARATION }, evidence: { e: 0.1 } }),
    );

    expect(decision.state).toBe('active');
    expect(decision.officialDeclaration).toEqual(DECLARATION);
  });

  it('refuses a curated state with no statement behind it', () => {
    expect(() =>
      decideLifecycle(
        tick({ event: { state: 'officially_contained', officialDeclaration: null } }),
      ),
    ).toThrow(RangeError);
  });
});

describe('no input invents a curated state', () => {
  it('only ever emits a curated state the event already held', () => {
    const eValues = [0, 1.5, 3.0, 50];
    const gaps = [0, T_LINK_MS, T_LINK_MS + 1, 30 * DAY];
    const seen: string[] = [];

    for (const state of LIFECYCLE_STATES) {
      for (const e of eValues) {
        for (const gap of gaps) {
          for (const redetected of [false, true]) {
            const at = SEEN + gap;
            const input = tick({
              event: {
                state,
                officialDeclaration: isCuratedLifecycleState(state)
                  ? { ...DECLARATION, state }
                  : null,
              },
              evidence: { e, trailingUnobservableDays: 20, accumulableOpportunities: 0 },
              atMs: at,
              redetection: redetected ? { atMs: at, source: 'firms:viirs:snpp' } : null,
            });
            const decision = decideLifecycle(input);
            seen.push(decision.state);

            if (isCuratedLifecycleState(decision.state)) {
              expect(decision.state).toBe(state);
            } else {
              expect(new Set<string>(MACHINE_LIFECYCLE_STATES).has(decision.state)).toBe(true);
            }
          }
        }
      }
    }

    // The sweep is only worth something if it actually reached the machine states.
    expect(new Set(seen).size).toBeGreaterThan(2);
  });
});

describe('A1.3 — the display window', () => {
  const closed = {
    state: 'no_longer_detected',
    inactiveSinceMs: INACTIVE,
  } satisfies Partial<EventObservationSnapshot>;

  it('measures the window from the transition, not from the last detection', () => {
    // 47 h after the transition is already 73 h after the last detection. On the old
    // anchor this event would have been archived; A1.3 says it is still on the map.
    const decision = decideLifecycle(tick({ event: closed, atMs: INACTIVE + 47 * HOUR }));

    expect(decision.displayTier).toBe('map');
    expect(decision.state).toBe('no_longer_detected');
    expect(decision.reason).toBe('no_change');
  });

  it('holds the map up to, but not including, 48 h after the transition', () => {
    expect(
      decideLifecycle(tick({ event: closed, atMs: INACTIVE + 48 * HOUR - 1 })).displayTier,
    ).toBe('map');
  });

  it('moves to the feed at exactly 48 h', () => {
    const decision = decideLifecycle(tick({ event: closed, atMs: INACTIVE + 48 * HOUR }));

    expect(decision.displayTier).toBe('feed');
    expect(decision.state).toBe('no_longer_detected');
    expect(decision.reason).toBe('display_window');
  });

  it('archives at exactly 7 d, as a state transition and not a filter', () => {
    expect(decideLifecycle(tick({ event: closed, atMs: INACTIVE + 7 * DAY - 1 })).displayTier).toBe(
      'feed',
    );

    const decision = decideLifecycle(tick({ event: closed, atMs: INACTIVE + 7 * DAY }));
    expect(decision.state).toBe('archived');
    expect(decision.displayTier).toBe('archive');
    expect(decision.reason).toBe('display_window');
  });

  it('fades a large event off the map on the same ladder as any other — fade-and-persist', () => {
    // D6: large events "fade on the map but persist listed". `feed` *is* listed-but-not-
    // drawn, so the ladder is identical and `large` has no display effect. Keeping a big
    // fire drawn for the whole week would be the opposite of what that line says, and the
    // stronger "burnt perimeter for the season" reading is still an open product decision
    // (00-summary, "Open questions escalated across reviews") this file will not pre-empt.
    const big = { ...closed, maxFrpMw: 500 };

    for (const atMs of [INACTIVE + 48 * HOUR - 1, INACTIVE + 48 * HOUR, INACTIVE + 7 * DAY]) {
      const bigDecision = decideLifecycle(tick({ event: big, atMs }));
      const smallDecision = decideLifecycle(tick({ event: closed, atMs }));

      expect(bigDecision.large).toBe(true);
      expect(smallDecision.large).toBe(false);
      expect(bigDecision.displayTier).toBe(smallDecision.displayTier);
      expect(bigDecision.state).toBe(smallDecision.state);
    }

    expect(decideLifecycle(tick({ event: big, atMs: INACTIVE + 48 * HOUR })).displayTier).toBe(
      'feed',
    );
  });

  it('never ages an active or weakening event off the map', () => {
    const stale = decideLifecycle(
      tick({ evidence: { e: 0, phasesWithMisses: [] }, atMs: SEEN + 30 * DAY }),
    );
    expect(stale.state).toBe('active');
    expect(stale.displayTier).toBe('map');

    const weakening = decideLifecycle(
      tick({ evidence: { e: 2.0, phasesWithMisses: ['day'] }, atMs: SEEN + 30 * DAY }),
    );
    expect(weakening.state).toBe('signal_weakening');
    expect(weakening.displayTier).toBe('map');
  });

  it('ages a curated event out of the active set without touching its state', () => {
    const decision = decideLifecycle(
      tick({
        event: {
          state: 'officially_contained',
          inactiveSinceMs: INACTIVE,
          officialDeclaration: { ...DECLARATION, state: 'officially_contained' },
        },
        atMs: INACTIVE + 7 * DAY,
      }),
    );

    expect(decision.state).toBe('officially_contained');
    expect(decision.displayTier).toBe('archive');
    expect(decision.reason).toBe('display_window');
  });

  it('gives an unobservability closure its full 48 h on the map', () => {
    // The case A1.3's wording is really about: nothing has seen this fire for a fortnight,
    // and that is exactly when the user most needs to see it was *lost* rather than ended.
    const decision = decideLifecycle(
      tick({
        evidence: {
          e: 0,
          trailingUnobservableDays: 14,
          accumulableOpportunities: 0,
          passes: [],
          phasesWithMisses: [],
        },
        atMs: SEEN + 14 * DAY,
      }),
    );

    expect(decision.reason).toBe('unobservable');
    expect(decision.state).toBe('no_longer_detected');
    expect(decision.displayTier).toBe('map');
    expect(decision.inactiveSinceMs).toBe(SEEN + 14 * DAY);
  });

  it('reads both boundaries from the parameter table', () => {
    const params = withParams({ mapWindowHours: 6, activeFeedHours: 12 }).values;

    expect(displayTierFor('no_longer_detected', 5 * HOUR, params)).toBe('map');
    expect(displayTierFor('no_longer_detected', 6 * HOUR, params)).toBe('feed');
    expect(displayTierFor('no_longer_detected', 12 * HOUR, params)).toBe('archive');
    expect(displayTierFor('active', 30 * DAY, params)).toBe('map');
    expect(displayTierFor('signal_weakening', 30 * DAY, params)).toBe('map');
    expect(displayTierFor('archived', 0, params)).toBe('archive');
  });
});

describe('the inactiveSinceMs anchor', () => {
  it('is null while the event is still detected', () => {
    expect(decideLifecycle(tick({ evidence: { e: 0.1 } })).inactiveSinceMs).toBeNull();
    expect(
      decideLifecycle(tick({ evidence: { e: 2.0 }, atMs: SEEN + 30 * DAY })).inactiveSinceMs,
    ).toBeNull();
  });

  it('is written by the tick that closes the event, carried while it stays closed, and cleared by a redetection', () => {
    // 1. the transition writes the anchor at the decision instant.
    const closedAt = SEEN + 26 * HOUR;
    const closing = decideLifecycle(tick({ evidence: { e: 3.0 }, atMs: closedAt }));

    expect(closing.state).toBe('no_longer_detected');
    expect(closing.reason).toBe('miss_evidence');
    expect(closing.inactiveSinceMs).toBe(closedAt);
    expect(closing.displayTier).toBe('map');

    // 2. later ticks carry the value the caller persisted — the window does not restart.
    const later = decideLifecycle(
      tick({
        event: { state: closing.state, inactiveSinceMs: closing.inactiveSinceMs },
        evidence: { e: 3.0 },
        atMs: closedAt + 49 * HOUR,
      }),
    );

    expect(later.inactiveSinceMs).toBe(closedAt);
    expect(later.displayTier).toBe('feed');

    // 3. and on to the archive, still on the original anchor.
    const archived = decideLifecycle(
      tick({
        event: { state: later.state, inactiveSinceMs: later.inactiveSinceMs },
        evidence: { e: 3.0 },
        atMs: closedAt + 7 * DAY,
      }),
    );

    expect(archived.state).toBe('archived');
    expect(archived.inactiveSinceMs).toBe(closedAt);

    // 4. a redetection inside T_LINK clears it: the next close starts a fresh 48 h.
    const backAt = closedAt + HOUR;
    const back = decideLifecycle(
      tick({
        event: {
          state: 'no_longer_detected',
          inactiveSinceMs: closedAt,
          lastDetectionAtMs: SEEN,
        },
        atMs: backAt,
        redetection: { atMs: backAt, source: 'firms:viirs:noaa21' },
      }),
    );

    expect(back.state).toBe('active');
    expect(back.inactiveSinceMs).toBeNull();
    expect(back.displayTier).toBe('map');
  });

  it('adopts the decision instant for a closed event handed in without one', () => {
    // A backfilled row, or a curated state written by a declaration path that set no
    // anchor. Restarting the window here can only grant more visibility than the truth,
    // never less — and the caller persists the value, so it restarts exactly once.
    const at = SEEN + 40 * DAY;
    const decision = decideLifecycle(
      tick({ event: { state: 'no_longer_detected', inactiveSinceMs: null }, atMs: at }),
    );

    expect(decision.inactiveSinceMs).toBe(at);
    expect(decision.displayTier).toBe('map');
  });

  it('refuses a detected event that still carries an anchor', () => {
    expect(() =>
      decideLifecycle(tick({ event: { state: 'active', inactiveSinceMs: SEEN + HOUR } })),
    ).toThrow(RangeError);
  });

  it('refuses an anchor in the future of the decision instant', () => {
    expect(() =>
      decideLifecycle(
        tick({
          event: { state: 'no_longer_detected', inactiveSinceMs: SEEN + 5 * DAY },
          atMs: SEEN + DAY,
        }),
      ),
    ).toThrow(RangeError);
  });
});

describe('redetection on the machine ladder', () => {
  it('lifts a no_longer_detected event back to active', () => {
    const at = SEEN + 30 * HOUR;
    const decision = decideLifecycle(
      tick({
        event: { state: 'no_longer_detected' },
        evidence: { e: 9 },
        atMs: at,
        redetection: { atMs: at, source: 'firms:viirs:noaa21' },
      }),
    );

    expect(decision.state).toBe('active');
    expect(decision.displayTier).toBe('map');
    expect(decision.reason).toBe('redetection');
  });

  it('lifts a signal_weakening event back to active', () => {
    const at = SEEN + 20 * HOUR;
    const decision = decideLifecycle(
      tick({
        event: { state: 'signal_weakening' },
        evidence: { e: 2 },
        atMs: at,
        redetection: { atMs: at, source: 'firms:modis' },
      }),
    );

    expect(decision.state).toBe('active');
    expect(decision.reason).toBe('redetection');
  });

  it('leaves an archived event alone — past T_LINK it is the identity engine that answers', () => {
    const at = SEEN + 8 * DAY;
    const decision = decideLifecycle(
      tick({
        event: { state: 'archived' },
        atMs: at,
        redetection: { atMs: at, source: 'firms:viirs:snpp' },
      }),
    );

    expect(decision.state).toBe('archived');
    expect(decision.displayTier).toBe('archive');
    expect(decision.reason).toBe('no_change');
  });

  it('treats a late-arriving row older than the last detection as inside the window', () => {
    const decision = decideLifecycle(
      tick({
        event: { state: 'no_longer_detected' },
        atMs: SEEN + 3 * DAY,
        redetection: { atMs: SEEN - HOUR, source: 'firms:modis' },
      }),
    );

    expect(decision.state).toBe('active');
    expect(decision.reason).toBe('redetection');
  });

  it('measures the gap between the two detections, not from the decision instant', () => {
    // The tick runs a week later; the detection itself landed one hour after the last one.
    const decision = decideLifecycle(
      tick({
        event: { state: 'no_longer_detected' },
        atMs: SEEN + 7 * DAY,
        redetection: { atMs: SEEN + HOUR, source: 'firms:viirs:snpp' },
      }),
    );

    expect(decision.state).toBe('active');
  });
});

describe('where signal_weakening begins', () => {
  it('is half the applicable threshold, and says so', () => {
    expect(SIGNAL_WEAKENING_THRESHOLD_FRACTION).toBe(0.5);
    expect(signalWeakeningThreshold(false)).toBe(1.5);
    expect(signalWeakeningThreshold(true)).toBe(2.5);
  });

  it('holds active just below the floor and weakens exactly on it', () => {
    const at = SEEN + 12 * HOUR;

    expect(decideLifecycle(tick({ evidence: { e: 1.4999 }, atMs: at })).state).toBe('active');
    expect(decideLifecycle(tick({ evidence: { e: 1.5 }, atMs: at })).state).toBe(
      'signal_weakening',
    );
  });

  it('uses the large-event floor for a large event', () => {
    const big = { peatOrLandfill: true };
    const at = SEEN + 12 * HOUR;

    expect(decideLifecycle(tick({ event: big, evidence: { e: 2.4 }, atMs: at })).state).toBe(
      'active',
    );
    expect(decideLifecycle(tick({ event: big, evidence: { e: 2.5 }, atMs: at })).state).toBe(
      'signal_weakening',
    );
    // The same 2.4 is already weakening for a small event: one ladder, two rungs.
    expect(decideLifecycle(tick({ evidence: { e: 2.4 }, atMs: at })).state).toBe(
      'signal_weakening',
    );
  });
});

describe('the reason on a tick that moves nothing', () => {
  it('distinguishes "nothing looked" from "we are not convinced"', () => {
    expect(
      decideLifecycle(tick({ evidence: { accumulableOpportunities: 0, passes: [] } })).reason,
    ).toBe('no_opportunity');
    expect(decideLifecycle(tick({ evidence: { accumulableOpportunities: 3 } })).reason).toBe(
      'insufficient_evidence',
    );
  });

  it('reports no_change for an archived event whatever the evidence says', () => {
    const decision = decideLifecycle(
      tick({ event: { state: 'archived' }, evidence: { e: 99 }, atMs: SEEN + 90 * DAY }),
    );

    expect(decision.state).toBe('archived');
    expect(decision.reason).toBe('no_change');
  });
});

describe('provenance and determinism', () => {
  it('stamps the version of the parameter set that decided', () => {
    expect(decideLifecycle(tick({})).paramsVersion).toBe(LIFECYCLE_PARAMS.version);
    expect(decideLifecycle(tick({}), withParams({})).paramsVersion).toBe('lifecycle_params_v9');
  });

  it('returns an identical decision for an identical input', () => {
    const input = tick({
      event: { maxFrpMw: 150, officialDeclaration: DECLARATION },
      evidence: { e: 4.2, addedE: 1.25 },
      atMs: SEEN + 40 * HOUR,
    });

    const first = decideLifecycle(input);
    const second = decideLifecycle(input);

    expect(second).toEqual(first);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });

  it('carries the decision instant and the event id through untouched', () => {
    const decision = decideLifecycle(tick({ atMs: SEEN + 5 * HOUR }));

    expect(decision.atMs).toBe(SEEN + 5 * HOUR);
    expect(decision.publicId).toBe(PUBLIC_ID);
  });
});

describe('input validation', () => {
  it('refuses evidence belonging to another event', () => {
    expect(() => decideLifecycle(tick({ evidence: { publicId: 'fw-2026-zzzzz' } }))).toThrow(
      /fw-2026-zzzzz/,
    );
  });

  it('refuses a decision instant that precedes the last detection', () => {
    expect(() => decideLifecycle(tick({ atMs: SEEN - 1 }))).toThrow(RangeError);
  });

  it('refuses a redetection from after the decision instant', () => {
    expect(() =>
      decideLifecycle(
        tick({ atMs: SEEN + HOUR, redetection: { atMs: SEEN + 2 * HOUR, source: 'firms:modis' } }),
      ),
    ).toThrow(RangeError);
  });

  it('refuses negative or non-finite miss evidence', () => {
    expect(() => decideLifecycle(tick({ evidence: { e: -1 } }))).toThrow(RangeError);
    expect(() => decideLifecycle(tick({ evidence: { e: Number.NaN } }))).toThrow(RangeError);
    expect(() => decideLifecycle(tick({ event: { accumulatedE: -0.5 } }))).toThrow(RangeError);
  });

  it('refuses a fractional day count', () => {
    expect(() => decideLifecycle(tick({ evidence: { trailingUnobservableDays: 2.5 } }))).toThrow(
      RangeError,
    );
    expect(() => decideLifecycle(tick({ evidence: { accumulableOpportunities: -1 } }))).toThrow(
      RangeError,
    );
  });

  it('refuses a negative size metric', () => {
    expect(() => decideLifecycle(tick({ event: { hullAreaHa: -3 } }))).toThrow(RangeError);
    expect(() => decideLifecycle(tick({ event: { maxFrpMw: Number.POSITIVE_INFINITY } }))).toThrow(
      RangeError,
    );
  });

  it('accepts a decision instant equal to the last detection', () => {
    const decision = decideLifecycle(tick({ atMs: SEEN }));
    expect(decision.state).toBe('active');
  });
});

describe('the vocabulary has no way to say a fire is out', () => {
  it('emits only states the contract defines', () => {
    const states: LifecycleState[] = [];
    for (const gap of [0, DAY, 3 * DAY, 30 * DAY]) {
      for (const e of [0, 1.5, 3, 6]) {
        states.push(decideLifecycle(tick({ evidence: { e }, atMs: SEEN + gap })).state);
      }
    }

    for (const state of states) {
      expect(new Set<string>(LIFECYCLE_STATES).has(state)).toBe(true);
    }
    expect(states.map(String)).not.toContain('out');
  });
});
