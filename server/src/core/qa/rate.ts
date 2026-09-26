/**
 * A rate that carries the arithmetic that produced it (TASKS D8).
 *
 * Every metric in GLOSSARY §8 is a fraction, and a fraction reported as one number is not
 * auditable: 5 % of 20 perimeters and 5 % of 2,000 are the same number and different
 * facts. Nothing in this package returns a bare `number`.
 *
 * The empty denominator is the case the type exists for. A week with no qualifying
 * perimeters, no closures and no dispatched alerts has *no* rate — not 0, which reads as
 * a perfect score, and not 1, which reads as total failure. It is `null`, and a target
 * comparison against it is `null` too, so a report cannot accidentally claim a pass it
 * never measured.
 */

import { QA_METRICS, type QaMetricsParams } from './qa-metrics-params.js';

export interface Rate {
  readonly numerator: number;
  readonly denominator: number;
  /** `numerator / denominator`, or `null` when the denominator is 0 — see the header. */
  readonly rate: number | null;
}

export const UNMEASURED: Rate = Object.freeze({ numerator: 0, denominator: 0, rate: null });

export function rateOf(numerator: number, denominator: number): Rate {
  if (!Number.isInteger(numerator) || numerator < 0) {
    throw new RangeError(`rate numerator must be a non-negative integer, got ${String(numerator)}`);
  }
  if (!Number.isInteger(denominator) || denominator < 0) {
    throw new RangeError(
      `rate denominator must be a non-negative integer, got ${String(denominator)}`,
    );
  }
  if (numerator > denominator) {
    throw new RangeError(
      `rate numerator ${String(numerator)} exceeds denominator ${String(denominator)}`,
    );
  }
  return Object.freeze({
    numerator,
    denominator,
    rate: denominator === 0 ? null : numerator / denominator,
  });
}

/**
 * Rounds to the parameter quantum before comparing, so "exactly at the target" is a state
 * a fixture can reach. Same argument as `quantizeE`.
 */
export function quantizeRate(value: number, params: QaMetricsParams = QA_METRICS.values): number {
  if (!Number.isFinite(value)) {
    throw new RangeError(`rate must be finite, got ${String(value)}`);
  }
  return Math.round(value / params.rateQuantum) * params.rateQuantum;
}

/** `null` when there is nothing to judge — an unmeasured rate meets no target and fails none. */
export function meetsAtLeast(
  rate: Rate,
  target: number,
  params: QaMetricsParams = QA_METRICS.values,
): boolean | null {
  if (rate.rate === null) return null;
  return quantizeRate(rate.rate, params) >= quantizeRate(target, params);
}

/** @see meetsAtLeast */
export function meetsAtMost(
  rate: Rate,
  target: number,
  params: QaMetricsParams = QA_METRICS.values,
): boolean | null {
  if (rate.rate === null) return null;
  return quantizeRate(rate.rate, params) <= quantizeRate(target, params);
}
