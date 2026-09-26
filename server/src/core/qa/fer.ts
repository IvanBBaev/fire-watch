/**
 * FER — False Extinguish Rate (GLOSSARY §8; ADR-002 D6 as amended by A2.3; 11 §5.8).
 *
 * "events that re-attach a detection **within 72 h** of entering `no_longer_detected` ÷
 * events entering `no_longer_detected` in the window — i.e. the declaration was
 * premature." Targets: ≤ 5 % overall, ≤ 10 % large-event class.
 *
 * FER is not a dashboard number. 11 §5.8 makes it "the **fitting objective** for the E
 * weights and E_min", which is why every threshold it is judged against lives in
 * `lifecycle_params_v1` beside the weights it grades — this module reads them and does
 * not restate them. A refit that bumps to `lifecycle_params_v2` changes what FER is
 * measured against, and the report says which version it ran under.
 *
 * ## The A2.3(3) exclusion, and why it is applied to the whole population
 *
 * The ≥ 14-day unobservability fallback closes an event "regardless of E". ADR-002 A2.3(3)
 * says such a closure is "excluded from the FER numerator and reported as its own class …
 * so the fallback can never be used to flatter the FER metric". Numerator-only exclusion
 * has the opposite effect of the sentence that justifies it: the closure stays in the
 * denominator, its re-attachment does not count, and the rate goes *down*. Taking the
 * stated purpose as normative over the stated mechanism, the class leaves both halves and
 * is reported separately — which is also the plain reading of "reported as its own class".
 * The choice is a config parameter (`fer.excludeUnobservableClosures`), so the literal
 * reading is one version bump away and neither reading is silent.
 */

import { LIFECYCLE_PARAMS, type LifecycleParams } from '../config/lifecycle-params.js';
import type { EpochMs } from '../ports/clock.js';
import { QA_METRICS, type QaMetricsParams } from './qa-metrics-params.js';
import { meetsAtMost, rateOf, type Rate } from './rate.js';

/**
 * Why the event entered `no_longer_detected`. `miss_evidence` is the E rule reaching its
 * threshold; `unobservable` is the A2.3(3) fallback closing an event no sensor could have
 * seen for `unobservableDays`.
 */
export const CLOSURE_REASONS = ['miss_evidence', 'unobservable'] as const;
export type ClosureReason = (typeof CLOSURE_REASONS)[number];

export interface ExtinguishDeclaration {
  readonly publicId: string;
  /** When the event entered `no_longer_detected`. Places it in the reporting window. */
  readonly declaredAtMs: EpochMs;
  readonly reason: ClosureReason;
  /**
   * The large-event class of ADR-002 D6 — hull ≥ 100 ha OR `max_frp` ≥ 100 MW OR
   * peat/landfill fuel. A caller-asserted boolean rather than the three facts, so that
   * `isLargeEvent` in `lifecycle/lifecycle-state.ts` stays the single implementation of
   * the rule; a second one here could disagree with the one that set the E threshold.
   */
  readonly large: boolean;
  /**
   * The first detection attached to the event **after** the declaration, or `null` if
   * none ever was. Only its distance from the declaration matters; a re-attachment after
   * the window is not a false extinguish, it is a reignition.
   */
  readonly reattachedAtMs: EpochMs | null;
}

export interface FerInput {
  /**
   * Every event that entered `no_longer_detected` inside the reporting window — the
   * denominator's definition, so the caller's window selection *is* the metric's window.
   */
  readonly declarations: readonly ExtinguishDeclaration[];
}

export type FerStratumName = 'overall' | 'large' | 'standard';

export interface FerStratum {
  readonly name: FerStratumName;
  readonly rate: Rate;
  /** `null` for `standard`: no document states a threshold for the non-large class alone. */
  readonly maxRate: number | null;
  readonly meetsTarget: boolean | null;
}

export interface FerReport {
  readonly configVersion: string;
  readonly configDigest: string;
  /** The version whose weights this rate is the fitting objective for. */
  readonly lifecycleParamsVersion: string;
  readonly windowHours: number;
  readonly strata: readonly FerStratum[];
  /**
   * A2.3(3)'s own class: closures the ≥ 14-day fallback made, held out of the rate.
   * Listed by id, because a class that is only counted is a class that can absorb.
   */
  readonly excludedUnobservable: readonly string[];
  /** Ids that re-attached inside the window, in input order. */
  readonly falseExtinguishIds: readonly string[];
}

export function fer(
  input: FerInput,
  params: QaMetricsParams = QA_METRICS.values,
  lifecycle: LifecycleParams = LIFECYCLE_PARAMS.values,
): FerReport {
  const windowMs = lifecycle.ferWindowHours * 3_600_000;
  const seen = new Set<string>();
  const excluded: string[] = [];
  const population: { readonly declaration: ExtinguishDeclaration; readonly premature: boolean }[] =
    [];

  for (const declaration of input.declarations) {
    if (seen.has(declaration.publicId)) {
      throw new RangeError(
        `event ${JSON.stringify(declaration.publicId)} appears twice in one FER window; a second ` +
          'closure of the same event is a second row and needs a distinct id',
      );
    }
    seen.add(declaration.publicId);
    if (!Number.isFinite(declaration.declaredAtMs)) {
      throw new RangeError(`event ${declaration.publicId} has a non-finite declaration instant`);
    }
    if (declaration.reattachedAtMs !== null) {
      if (!Number.isFinite(declaration.reattachedAtMs)) {
        throw new RangeError(`event ${declaration.publicId} has a non-finite re-attachment`);
      }
      if (declaration.reattachedAtMs < declaration.declaredAtMs) {
        // A detection before the declaration is evidence the rule already weighed, not a
        // re-attachment. Silently keeping it would charge the E weights for their input.
        throw new RangeError(
          `event ${JSON.stringify(declaration.publicId)} re-attaches before it was declared ` +
            'no_longer_detected',
        );
      }
    }
    if (params.fer.excludeUnobservableClosures && declaration.reason === 'unobservable') {
      excluded.push(declaration.publicId);
      continue;
    }
    const premature =
      declaration.reattachedAtMs !== null &&
      declaration.reattachedAtMs - declaration.declaredAtMs <= windowMs;
    population.push({ declaration, premature });
  }

  const stratum = (
    name: FerStratumName,
    members: readonly { readonly premature: boolean }[],
    maxRate: number | null,
  ): FerStratum => {
    const rate = rateOf(members.filter((member) => member.premature).length, members.length);
    return Object.freeze({
      name,
      rate,
      maxRate,
      meetsTarget: maxRate === null ? null : meetsAtMost(rate, maxRate, params),
    });
  };

  return Object.freeze({
    configVersion: QA_METRICS.version,
    configDigest: QA_METRICS.digest,
    lifecycleParamsVersion: LIFECYCLE_PARAMS.version,
    windowHours: lifecycle.ferWindowHours,
    strata: Object.freeze([
      stratum('overall', population, lifecycle.ferMaxRate),
      stratum(
        'large',
        population.filter((member) => member.declaration.large),
        lifecycle.ferMaxRateLarge,
      ),
      // Reported without a threshold rather than omitted: a pooled 5 % made of a passing
      // large class and a failing small one is a fact the report should not have to be
      // asked for.
      stratum(
        'standard',
        population.filter((member) => !member.declaration.large),
        null,
      ),
    ]),
    excludedUnobservable: Object.freeze(excluded),
    falseExtinguishIds: Object.freeze(
      population.filter((member) => member.premature).map((member) => member.declaration.publicId),
    ),
  });
}
