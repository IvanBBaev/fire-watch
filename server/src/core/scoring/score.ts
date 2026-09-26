/**
 * The v0 confidence score (ADR-002 D6, specified in 11 §3.5–§3.9).
 *
 * `score = σ(z)`, `z = intercept + Σ wᵢ·xᵢ` over the ten features of `features.ts`, then a
 * bucket. The weights are hand-set, not fitted — the review is explicit that they are a
 * starting point to be replaced once the QA harness has labelled events — which is what
 * `_v0` in `score_params_v0` means and why every result carries the version that produced
 * it.
 *
 * ## The overrides are not terms
 *
 * §3.6's static-source mask is applied here, **around** the formula, never as an eleventh
 * weight: "a weight can be outvoted; a power plant must not be". A logistic sum has no way
 * to express "regardless of everything else", so a large negative weight would still lose
 * to a bright, persistent, multi-source, night-time flare — which is exactly what a steel
 * works looks like from orbit. The mask therefore short-circuits to 0 after the features
 * have been computed, and the features are still returned, so a fixture can show what the
 * event *would* have scored and see that the override, not a small number, is what
 * decided it.
 *
 * The second override — the water/glint guard — is specified pre-clustering and lives in
 * `features.ts`, which drops the guarded detections before any feature reads them.
 *
 * ## Determinism
 *
 * `Math.exp` is implementation-approximated in ECMAScript, exactly like the trigonometry
 * `geometry.ts` refuses to use: two engines may legally differ in the last bits. A bucket
 * floor is a comparison, so a difference in the last bits at exactly 0.75 would flip a
 * published bucket. The score is therefore quantised to `scoreQuantum` before it is
 * compared to anything or handed to a caller, on the same argument (and with the same
 * multiply-then-divide rounding) as `quantizeKm` and `quantizeE`. `z` is left exact: it is
 * a fold of `+` and `×` in a fixed order, which is bit-reproducible.
 */

import type { ScoreBucket } from '@fire-watch/contracts';

import {
  computeFeatures,
  type FeatureDerivation,
  type FeatureVector,
  type ScoringContext,
  type ScoringDetection,
} from './features.js';
import { quantizeScore, SCORE_PARAMS, type ScoreParams } from './score-params.js';

/**
 * The §3.6 overrides that can decide a score on their own. One member today; it is a union
 * so that `override: null` versus `override: 'static_source_mask'` is a fact a fixture can
 * assert, rather than a boolean that would have to be renamed when the second one lands.
 */
export const SCORE_OVERRIDES = ['static_source_mask'] as const;
export type ScoreOverride = (typeof SCORE_OVERRIDES)[number];

/**
 * Everything the score needs that is not in the detections. The three fields are all
 * facts about the world that this repo cannot yet derive (see `features.ts`), which is why
 * the caller is made to state them.
 */
export interface ScoreContext extends ScoringContext {
  /**
   * Does the event fall inside the static hot-source mask (§3.6, D9)? **Not** nullable,
   * unlike the other two: an override that could be skipped by passing `null` would not be
   * an override. A caller with no mask loaded has to write `false` and thereby own the
   * claim that this is not a flare.
   */
  readonly staticSourceMaskHit: boolean;
}

/** One scoring of one event. Total: everything that went into the number comes back out. */
export interface ScoreResult {
  /** σ(z), quantised — or exactly 0 when an override fired. In [0,1]. */
  readonly score: number;
  readonly bucket: ScoreBucket;
  /** The linear predictor, unquantised, for fixtures that need to see the arithmetic. */
  readonly z: number;
  readonly features: FeatureVector;
  readonly derivation: FeatureDerivation;
  readonly override: ScoreOverride | null;
  /** ADR-002 D6's status for a masked event. Set only by an override. */
  readonly invalidated: boolean;
  readonly paramsVersion: string;
}

/** `σ(z) = 1 / (1 + e^−z)`, quantised. Saturates cleanly: `e^−z` overflowing to ∞ gives 0. */
export function logistic(z: number, params: ScoreParams = SCORE_PARAMS.values): number {
  if (!Number.isFinite(z)) {
    throw new RangeError(`z must be finite, got ${String(z)}`);
  }
  return quantizeScore(1 / (1 + Math.exp(-z)), params);
}

/**
 * `z` from a feature vector, folded in the order §3.5 writes the formula.
 *
 * The order is fixed and pinned by test because float addition is not associative: the
 * same ten terms summed right-to-left can differ in the last bits, and a `z` that depends
 * on iteration order is a `z` that a refactor can silently change. The weights carry their
 * own sign (agri, edge and glint are negative in `score_params_v0`), so this is a plain
 * sum and the subtractions of §3.5 live in the data where they can be re-fitted.
 */
export function linearPredictor(
  features: FeatureVector,
  params: ScoreParams = SCORE_PARAMS.values,
): number {
  const w = params.weights;
  let z = params.intercept;
  z += w.best * features.best;
  z += w.persist * features.persist;
  z += w.multisrc * features.multisrc;
  z += w.night * features.night;
  z += w.coherence * features.coherence;
  z += w.frp * features.frp;
  z += w.fwi * features.fwi;
  z += w.agri * features.agri;
  z += w.edge * features.edge;
  z += w.glint * features.glint;
  return z;
}

/**
 * The bucket of a score (§3.9, D6): Confirmed ≥ 0.75, Likely 0.45–0.75, Unverified < 0.45.
 *
 * Closed at the bottom, so a score sitting exactly on a floor takes the higher bucket —
 * which is why the quantisation above matters, since without it "exactly 0.75" is a state
 * the arithmetic can miss. Reads the floors from the params rather than from the contracts
 * constant, because §3.9 puts the thresholds in versioned config; a drift test pins the
 * two equal so the API and the engine can never disagree about what "Confirmed" means.
 */
export function bucketOf(score: number, params: ScoreParams = SCORE_PARAMS.values): ScoreBucket {
  if (!Number.isFinite(score) || score < 0 || score > 1) {
    throw new RangeError(`score must be a probability in [0,1], got ${String(score)}`);
  }
  if (score >= params.bucketFloor.confirmed) return 'confirmed';
  if (score >= params.bucketFloor.likely) return 'likely';
  return 'unverified';
}

/**
 * Scores one event: features, `z`, `σ(z)`, bucket, overrides.
 *
 * A mask hit does not skip the feature computation. Running it anyway costs nothing on an
 * event of a few dozen detections and buys the property the review asks for — that the
 * override is visibly *outside* the model — because `features` and `z` in the result
 * describe the fire the formula saw while `score` is 0 regardless of them.
 */
export function scoreEvent(
  detections: readonly ScoringDetection[],
  context: ScoreContext,
  params: ScoreParams = SCORE_PARAMS.values,
): ScoreResult {
  const derivation = computeFeatures(detections, context, params);
  const z = linearPredictor(derivation.features, params);

  if (context.staticSourceMaskHit) {
    return {
      score: 0,
      // Not `bucketOf(0)`: the two agree today, and tying the masked case to the floors
      // would let a future re-fit of `bucketFloor.likely` to 0 quietly promote every
      // invalidated event. D6 states the bucket, so it is stated here.
      bucket: 'unverified',
      z,
      features: derivation.features,
      derivation,
      override: 'static_source_mask',
      invalidated: true,
      paramsVersion: SCORE_PARAMS.version,
    };
  }

  const score = logistic(z, params);
  return {
    score,
    bucket: bucketOf(score, params),
    z,
    features: derivation.features,
    derivation,
    override: null,
    invalidated: false,
    paramsVersion: SCORE_PARAMS.version,
  };
}

/**
 * The gate D6 puts in front of the notifier: "score downgrades never notify".
 *
 * This is the gate, not the policy — it answers "is this change allowed to notify", and
 * whether an allowed change actually does is the notifier's business (quiet hours, dedupe,
 * the user's subscriptions). It compares buckets rather than scores, because a score that
 * drifts from 0.81 to 0.79 is the same public statement and must not produce a message;
 * only a change of the word shown to the user is a candidate.
 *
 * An override always answers `false`. Invalidating an event is by definition a downgrade,
 * and the one thing worse than not telling someone about a flare is telling them twice.
 */
export function scoreChangeMayNotify(previous: ScoreResult | null, next: ScoreResult): boolean {
  if (next.override !== null) return false;
  if (previous === null) return true;
  return bucketRank(next.bucket) > bucketRank(previous.bucket);
}

function bucketRank(bucket: ScoreBucket): number {
  switch (bucket) {
    case 'unverified':
      return 0;
    case 'likely':
      return 1;
    case 'confirmed':
      return 2;
  }
}
