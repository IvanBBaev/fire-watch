import { describe, expect, it } from 'vitest';

import type { FeatureVector, ScoringDetection } from './features.js';
import { SCORE_PARAMS } from './score-params.js';
import {
  bucketOf,
  linearPredictor,
  logistic,
  scoreChangeMayNotify,
  scoreEvent,
  type ScoreContext,
  type ScoreResult,
} from './score.js';

const PARAMS = SCORE_PARAMS.values;

/** Every feature off. Each worked example turns on exactly the ones its table row lists. */
const NO_FEATURES: FeatureVector = {
  best: 0,
  persist: 0,
  multisrc: 0,
  night: 0,
  coherence: 0,
  frp: 0,
  fwi: 0,
  agri: 0,
  edge: 0,
  glint: 0,
};

const NOTHING_STATED: ScoreContext = {
  staticSourceMaskHit: false,
  fwiAtLeastHigh: null,
  arableMajorityUnderHull: null,
};

let uid = 0;

function detection(overrides: Partial<ScoringDetection> = {}): ScoringDetection {
  uid += 1;
  return {
    detectionUid: `d${String(uid)}`,
    source: 'firms:viirs:snpp',
    acqTsIso: '2025-08-01T11:00:00Z',
    latCanonical: '42.70000',
    lonCanonical: '23.30000',
    confidence: 'nominal',
    dayNight: 'D',
    frpMw: null,
    scanKm: null,
    trackKm: null,
    overOrAdjacentToWater: null,
    ...overrides,
  };
}

/**
 * 11 §3.5's five worked examples, transcribed from the table and asserted against
 * arithmetic done by hand from the pinned weights.
 *
 * **Where this file disagrees with the review, the review is rounding.** §3.5 states its z
 * column as an approximation ("≈ −3.9") and then, in three of the five rows, derives the
 * score column from that *rounded* z rather than from the exact one — σ(−3.9) = 0.0198,
 * σ(−0.5) = 0.3775, σ(+1.6) = 0.8320, σ(+2.8) = 0.9427, σ(−0.7) = 0.3318, which reproduces
 * the review's 0.02 / 0.38 / 0.83 / 0.94 / 0.33 to two decimals. Recomputing from the
 * stated feature vectors gives the values asserted below. The **bucket** — the only column
 * the product actually shows, and the column §9.4 turns into fixture assertions — is
 * identical in all five rows either way, so nothing about the review's conclusions changes.
 *
 * Two rows also disagree with §3.4's own definition of x6; that is noted on each.
 */
describe('11 §3.5 worked examples', () => {
  it('1 — single daytime low-conf VIIRS pixel, cropland, swath edge → Unverified', () => {
    // x_best = .25, x_agri = 1, x_edge = 1, x_glint = 1
    // z = −2.0 + 1.8(0.25) − 1.0(1) − 0.6(1) − 0.8(1)
    //   = −2.0 + 0.45 − 1.0 − 0.6 − 0.8
    //   = −3.95                                    (review: "≈ −3.9")
    // score = 1/(1 + e^3.95) = 1/(1 + 51.93540...) = 0.0188909...  → 0.018891
    //   (review: 0.02 — which is this value to two decimals, so the rows agree)
    const features: FeatureVector = { ...NO_FEATURES, best: 0.25, agri: 1, edge: 1, glint: 1 };
    const z = linearPredictor(features);
    expect(z).toBe(-3.95);
    expect(logistic(z)).toBe(0.018891);
    expect(bucketOf(logistic(z))).toBe('unverified');
  });

  it('2 — single daytime nominal VIIRS, forest, FWI high → Unverified', () => {
    // x_best = .65, x_fwi = 1
    // z = −2.0 + 1.8(0.65) + 0.3(1) = −2.0 + 1.17 + 0.3 = −0.53   (review: "≈ −0.5")
    //   IEEE double: −0.5299999999999998, the residue of 1.8 × 0.65.
    // score = 1/(1 + e^0.53) = 0.3705174...  → 0.370517
    //   The review prints 0.38, which is σ(−0.5) — its own rounded z — not σ(−0.53).
    const features: FeatureVector = { ...NO_FEATURES, best: 0.65, fwi: 1 };
    const z = linearPredictor(features);
    expect(z).toBeCloseTo(-0.53, 12);
    expect(logistic(z)).toBe(0.370517);
    expect(bucketOf(logistic(z))).toBe('unverified');
  });

  it('3 — first night pass, 5 high-conf VIIRS pixels, coherent, FRP 25 MW → Confirmed', () => {
    // x_best = .95, x_night = 1, x_coherence = 1, x_frp = .32, x_fwi = 1
    // z = −2.0 + 1.8(0.95) + 0.7(1) + 0.6(1) + 0.5(0.32) + 0.3(1)
    //   = −2.0 + 1.71 + 0.7 + 0.6 + 0.16 + 0.3
    //   = +1.47                                    (review: "≈ +1.6" — not a rounding of 1.47)
    //   IEEE double: 1.4699999999999998.
    // score = 1/(1 + e^−1.47) = 0.8130573...  → 0.813057   (review: 0.83 = σ(+1.6))
    // Bucket is Confirmed on both numbers, which is the row's actual claim.
    const features: FeatureVector = {
      ...NO_FEATURES,
      best: 0.95,
      night: 1,
      coherence: 1,
      frp: 0.32,
      fwi: 1,
    };
    const z = linearPredictor(features);
    expect(z).toBeCloseTo(1.47, 12);
    expect(logistic(z)).toBe(0.813057);
    expect(bucketOf(logistic(z))).toBe('confirmed');
  });

  it('4 — two overpasses, two satellites, night, FRP 40 MW, coherent → Confirmed', () => {
    // x_best = .95, x_persist = .33, x_multisrc = 1, x_night = 1, x_coherence = 1, x_frp = .37
    // z = −2.0 + 1.8(0.95) + 1.0(0.33) + 0.8(1) + 0.7(1) + 0.6(1) + 0.5(0.37)
    //   = −2.0 + 1.71 + 0.33 + 0.8 + 0.7 + 0.6 + 0.185
    //   = +2.325                                   (review: "≈ +2.8" — not a rounding of 2.325)
    // score = 1/(1 + e^−2.325) = 0.9109262...  → 0.910926   (review: 0.94 = σ(+2.8))
    const features: FeatureVector = {
      ...NO_FEATURES,
      best: 0.95,
      persist: 0.33,
      multisrc: 1,
      night: 1,
      coherence: 1,
      frp: 0.37,
    };
    const z = linearPredictor(features);
    expect(z).toBe(2.325);
    expect(logistic(z)).toBe(0.910926);
    expect(bucketOf(logistic(z))).toBe('confirmed');
  });

  it('5 — GEO-only cluster, 4 consecutive 10-min slots, daytime → Unverified', () => {
    // x_best = .55, x_persist = .33 (capped)
    // z = −2.0 + 1.8(0.55) + 1.0(0.33) = −2.0 + 0.99 + 0.33 = −0.68   (review: "≈ −0.7")
    //   IEEE double: −0.6799999999999997.
    // score = 1/(1 + e^0.68) = 0.3362613...  → 0.336261   (review: 0.33 = σ(−0.7))
    const features: FeatureVector = { ...NO_FEATURES, best: 0.55, persist: 0.33 };
    const z = linearPredictor(features);
    expect(z).toBeCloseTo(-0.68, 12);
    expect(logistic(z)).toBe(0.336261);
    expect(bucketOf(logistic(z))).toBe('unverified');
  });
});

/**
 * The same five cases with the features this engine actually derives. They differ from the
 * table in three places, each of which is the review's own text disagreeing with itself.
 */
describe('11 §3.5 worked examples, with features as §3.4 defines them', () => {
  it('keeps x_persist an exact third where the table writes .33', () => {
    // §3.4: x_persist = min(n_overpasses − 1, 3) / 3. Two overpasses give 1/3, not 0.33.
    // Example 4: z = 2.325 + (1/3 − 0.33) = 2.3283333...  → score 0.911197 (was 0.910926)
    // Example 5: z = −0.68 + (1/3 − 0.33) = −0.6766666...  → score 0.337006 (was 0.336261)
    const four: FeatureVector = {
      ...NO_FEATURES,
      best: 0.95,
      persist: 1 / 3,
      multisrc: 1,
      night: 1,
      coherence: 1,
      frp: 0.37,
    };
    expect(logistic(linearPredictor(four))).toBe(0.911197);
    const five: FeatureVector = { ...NO_FEATURES, best: 0.55, persist: 1 / 3 };
    expect(logistic(linearPredictor(five))).toBe(0.337006);
  });

  it('computes x_frp from the FRP the row states, which the table does not', () => {
    // §3.4: x_frp = min(ln(1 + FRP_max) / ln(101), 1).
    //   25 MW → ln(26)/ln(101)  = 0.7059613...  , the table says .32
    //   40 MW → ln(41)/ln(101)  = 0.8046533...  , the table says .37
    // Neither .32 nor .37 is reachable from the stated FRP by that formula (they would
    // need ~3.4 MW and ~4.5 MW). The examples are transcribed above as written, because
    // the brief is to reproduce them; this test records what the definition gives, and it
    // moves both rows *towards* the review's own z and score, not away from them.
    const three: FeatureVector = {
      ...NO_FEATURES,
      best: 0.95,
      night: 1,
      coherence: 1,
      frp: Math.log(26) / Math.log(101),
      fwi: 1,
    };
    expect(linearPredictor(three)).toBeCloseTo(1.662980656, 9);
    expect(logistic(linearPredictor(three))).toBe(0.840638);
    expect(bucketOf(logistic(linearPredictor(three)))).toBe('confirmed');

    const four: FeatureVector = {
      ...NO_FEATURES,
      best: 0.95,
      persist: 1 / 3,
      multisrc: 1,
      night: 1,
      coherence: 1,
      frp: Math.log(41) / Math.log(101),
    };
    expect(logistic(linearPredictor(four))).toBe(0.927281);
    expect(bucketOf(logistic(linearPredictor(four)))).toBe('confirmed');
  });

  it('gives example 5 no persistence at all under §3.4’s own GEO cap', () => {
    // "4 consecutive 10-min slots" span forty minutes, and §3.4 allows GEO "max 1
    // overpass-equivalent per 3 h" — so n_overpasses = 1 and x_persist = 0, where the
    // table writes .33 (capped). Two clauses of the same section cannot both hold.
    // z = −2.0 + 1.8(0.55) = −1.01 → score 0.26698, still Unverified, which is the row's
    // stated conclusion and the reason this is a documentation defect and not a bug.
    const slots = ['12:00', '12:10', '12:20', '12:30'].map((hm) =>
      detection({
        source: 'lsasaf:seviri:frp-pixel',
        dayNight: null,
        acqTsIso: `2025-08-01T${hm}:00Z`,
      }),
    );
    const result = scoreEvent(slots, NOTHING_STATED);
    expect(result.features.best).toBe(0.55);
    expect(result.features.persist).toBe(0);
    expect(result.z).toBeCloseTo(-1.01, 12);
    expect(result.score).toBe(0.26698);
    expect(result.bucket).toBe('unverified');
  });
});

describe('scoreEvent end to end', () => {
  /** Example 3's event as detections: one S-NPP night pass, five high-confidence pixels, 25 MW peak. */
  const nightPass: readonly ScoringDetection[] = [
    detection({ confidence: 'high', dayNight: 'N', acqTsIso: '2025-08-01T23:40:00Z', frpMw: 25 }),
    detection({
      confidence: 'high',
      dayNight: 'N',
      acqTsIso: '2025-08-01T23:40:00Z',
      latCanonical: '42.70400',
      frpMw: 11,
    }),
    detection({
      confidence: 'high',
      dayNight: 'N',
      acqTsIso: '2025-08-01T23:40:00Z',
      latCanonical: '42.70200',
      lonCanonical: '23.30500',
      frpMw: 9,
    }),
    detection({
      confidence: 'high',
      dayNight: 'N',
      acqTsIso: '2025-08-01T23:40:00Z',
      latCanonical: '42.70100',
      frpMw: 7,
    }),
    detection({
      confidence: 'high',
      dayNight: 'N',
      acqTsIso: '2025-08-01T23:40:00Z',
      latCanonical: '42.70300',
      lonCanonical: '23.30200',
      frpMw: 5,
    }),
  ];

  it('confirms a night high-confidence VIIRS cluster on its first pass', () => {
    // 03-geodata §5.2.3's "1 detection if night + high" rule, reached through the score
    // rather than asserted separately — §3.5 says this is intentional.
    const result = scoreEvent(nightPass, { ...NOTHING_STATED, fwiAtLeastHigh: true });
    expect(result.features).toEqual({
      best: 0.95,
      persist: 0,
      multisrc: 0,
      night: 1,
      coherence: 1,
      frp: Math.log(26) / Math.log(101),
      fwi: 1,
      agri: 0,
      edge: 0,
      glint: 0,
    });
    expect(result.score).toBe(0.840638);
    expect(result.bucket).toBe('confirmed');
    expect(result.override).toBeNull();
    expect(result.invalidated).toBe(false);
    expect(result.paramsVersion).toBe('score_params_v0');
  });

  it('does not depend on the order the detections arrive in', () => {
    const forwards = scoreEvent(nightPass, NOTHING_STATED);
    const backwards = scoreEvent(nightPass.slice().reverse(), NOTHING_STATED);
    expect(backwards.z).toBe(forwards.z);
    expect(backwards.score).toBe(forwards.score);
  });
});

describe('§3.6 override 1 — the static hot-source mask', () => {
  const flare = [
    detection({ confidence: 'high', dayNight: 'N', frpMw: 300, acqTsIso: '2025-08-01T23:40:00Z' }),
    detection({ confidence: 'high', dayNight: 'N', frpMw: 280, acqTsIso: '2025-08-02T23:40:00Z' }),
    detection({
      source: 'firms:modis',
      confidence: 'high',
      dayNight: 'N',
      frpMw: 260,
      acqTsIso: '2025-08-03T23:40:00Z',
    }),
  ] as const;

  it('forces the score to 0 and the status to invalidated, whatever the formula says', () => {
    const scored = scoreEvent(flare, NOTHING_STATED);
    // Left to the model this is a textbook confirmed fire: night, high confidence, three
    // overpasses, two platforms, 300 MW. That is exactly what a steel works looks like.
    expect(scored.bucket).toBe('confirmed');
    expect(scored.score).toBeGreaterThan(PARAMS.bucketFloor.confirmed);

    const masked = scoreEvent(flare, { ...NOTHING_STATED, staticSourceMaskHit: true });
    expect(masked.score).toBe(0);
    expect(masked.bucket).toBe('unverified');
    expect(masked.override).toBe('static_source_mask');
    expect(masked.invalidated).toBe(true);
  });

  it('is outside the formula: the features and z are unchanged by the mask', () => {
    // The point of §3.4's closing line. A mask hit is not a weight that can be outvoted,
    // so it cannot be expressed as a term — and the result still shows what the model
    // thought, so a fixture can see that the override, not a low score, decided this.
    const scored = scoreEvent(flare, NOTHING_STATED);
    const masked = scoreEvent(flare, { ...NOTHING_STATED, staticSourceMaskHit: true });
    expect(masked.features).toEqual(scored.features);
    expect(masked.z).toBe(scored.z);
    expect(masked.z).toBeGreaterThan(0);
  });

  it('cannot be skipped: the mask verdict is a required boolean, not a nullable one', () => {
    // Enforced by the type, and stated here so the intent survives a refactor: a caller
    // with no mask loaded has to write `false` and own the claim.
    const context: ScoreContext = { ...NOTHING_STATED, staticSourceMaskHit: false };
    expect(context.staticSourceMaskHit).toBe(false);
  });
});

describe('buckets', () => {
  it('is closed at the bottom of each band (§3.9, D6)', () => {
    expect(bucketOf(0.75)).toBe('confirmed');
    expect(bucketOf(0.749999)).toBe('likely');
    expect(bucketOf(0.45)).toBe('likely');
    expect(bucketOf(0.449999)).toBe('unverified');
    expect(bucketOf(0)).toBe('unverified');
    expect(bucketOf(1)).toBe('confirmed');
  });

  it('refuses a score that is not a probability', () => {
    expect(() => bucketOf(1.0000001)).toThrow(RangeError);
    expect(() => bucketOf(-0.0000001)).toThrow(RangeError);
    expect(() => bucketOf(Number.NaN)).toThrow(/probability/);
  });
});

describe('the logistic', () => {
  it('is quantised, so a bucket floor is a state the arithmetic can occupy', () => {
    // Math.exp is implementation-approximated in ECMAScript; without the quantum, two
    // engines could legally land on either side of 0.75 for the same z.
    expect(logistic(0)).toBe(0.5);
    expect(Number.isInteger(logistic(1.1) * 1e6)).toBe(true);
  });

  it('saturates without producing a value outside [0,1]', () => {
    expect(logistic(1000)).toBe(1);
    expect(logistic(-1000)).toBe(0);
  });

  it('refuses a non-finite z', () => {
    expect(() => logistic(Number.POSITIVE_INFINITY)).toThrow(RangeError);
  });

  it('is monotone in every feature, which is why the form was chosen', () => {
    for (const key of Object.keys(NO_FEATURES) as (keyof FeatureVector)[]) {
      const off = logistic(linearPredictor(NO_FEATURES));
      const on = logistic(linearPredictor({ ...NO_FEATURES, [key]: 1 }));
      if (PARAMS.weights[key] > 0) expect(on).toBeGreaterThan(off);
      else expect(on).toBeLessThan(off);
    }
  });

  it('folds the ten terms in the order §3.5 writes them', () => {
    // Float addition is not associative. Pinning the order keeps z bit-identical across
    // refactors, which is what CI-2's byte diff of a replay actually checks.
    const features: FeatureVector = {
      best: 0.95,
      persist: 1 / 3,
      multisrc: 1,
      night: 1,
      coherence: 1,
      frp: Math.log(41) / Math.log(101),
      fwi: 1,
      agri: 1,
      edge: 1,
      glint: 1,
    };
    const w = PARAMS.weights;
    let byHand = PARAMS.intercept;
    byHand += w.best * features.best;
    byHand += w.persist * features.persist;
    byHand += w.multisrc * features.multisrc;
    byHand += w.night * features.night;
    byHand += w.coherence * features.coherence;
    byHand += w.frp * features.frp;
    byHand += w.fwi * features.fwi;
    byHand += w.agri * features.agri;
    byHand += w.edge * features.edge;
    byHand += w.glint * features.glint;
    expect(linearPredictor(features)).toBe(byHand);
  });
});

describe('scoreChangeMayNotify — D6’s "score downgrades never notify"', () => {
  const at = (score: number, bucket: ScoreResult['bucket']): ScoreResult =>
    ({
      score,
      bucket,
      z: 0,
      features: NO_FEATURES,
      derivation: {
        features: NO_FEATURES,
        retained: [],
        waterGuarded: [],
        overpasses: 0,
        platforms: 0,
        maxFrpMw: null,
      },
      override: null,
      invalidated: false,
      paramsVersion: SCORE_PARAMS.version,
    }) satisfies ScoreResult;

  it('allows an upgrade', () => {
    expect(scoreChangeMayNotify(at(0.5, 'likely'), at(0.8, 'confirmed'))).toBe(true);
    expect(scoreChangeMayNotify(at(0.2, 'unverified'), at(0.5, 'likely'))).toBe(true);
  });

  it('never allows a downgrade, including the one a merge causes', () => {
    // §3.6(3): merges recompute from scratch and may lower the score; that is correct,
    // and it must never reach the user as a message.
    expect(scoreChangeMayNotify(at(0.8, 'confirmed'), at(0.5, 'likely'))).toBe(false);
    expect(scoreChangeMayNotify(at(0.5, 'likely'), at(0.2, 'unverified'))).toBe(false);
  });

  it('says nothing about a change that keeps the same bucket', () => {
    // 0.81 → 0.79 is the same public statement; re-announcing it would be noise.
    expect(scoreChangeMayNotify(at(0.81, 'confirmed'), at(0.79, 'confirmed'))).toBe(false);
    expect(scoreChangeMayNotify(at(0.79, 'confirmed'), at(0.81, 'confirmed'))).toBe(false);
  });

  it('never allows an invalidation to notify', () => {
    const masked: ScoreResult = {
      ...at(0, 'unverified'),
      override: 'static_source_mask',
      invalidated: true,
    };
    expect(scoreChangeMayNotify(at(0.9, 'confirmed'), masked)).toBe(false);
    expect(scoreChangeMayNotify(null, masked)).toBe(false);
  });

  it('opens the gate for an event that has no previous score', () => {
    expect(scoreChangeMayNotify(null, at(0.9, 'confirmed'))).toBe(true);
  });
});
