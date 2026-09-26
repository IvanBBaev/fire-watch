/**
 * The quantile the latency metrics are stated in (GLOSSARY §8: "p50/p95 per stage").
 *
 * The convention — nearest-rank inclusive, the order statistic at 1-based rank
 * `ceil(p · n)` — is argued for where it is pinned, in
 * {@link QUANTILE_METHODS}'s doc comment in `qa-metrics-params.ts`. It is a *pinned*
 * convention and not a default, because an unstated quantile rule is a silent parameter:
 * the same latencies read 12 or 15 minutes depending on it, and a checkpoint graded
 * "≤ 15 min p95" would then be graded by an implementation detail.
 *
 * The result carries `n` and `isMaximum` because the honest failure mode of nearest-rank
 * is a small sample: at p = 0.95 any n ≤ 19 puts the rank at n, so the "p95" is the
 * largest observation and says nothing about a tail. Reporting that is the alternative to
 * inventing a minimum sample size no document states.
 */

import { QA_METRICS, type QaMetricsParams, type QuantileMethod } from './qa-metrics-params.js';

export interface Quantile {
  readonly p: number;
  readonly method: QuantileMethod;
  readonly n: number;
  /** 1-based rank of the returned observation, or `null` for an empty sample. */
  readonly rank: number | null;
  /** The observation at `rank`, or `null` for an empty sample. */
  readonly value: number | null;
  /**
   * The rank landed on the largest observation. True for every p over a sample of one,
   * and for p = 0.95 over any n ≤ 19: the quantile is the maximum and carries no
   * information about the shape of the tail.
   */
  readonly isMaximum: boolean;
}

/**
 * @param samples unordered; sorted here so a caller cannot change the answer by changing
 *   the order it happened to read rows in.
 */
export function quantileOf(
  samples: readonly number[],
  p: number,
  params: QaMetricsParams = QA_METRICS.values,
): Quantile {
  if (!Number.isFinite(p) || p <= 0 || p > 1) {
    throw new RangeError(`quantile probability must be in (0, 1], got ${String(p)}`);
  }
  for (const sample of samples) {
    if (!Number.isFinite(sample)) {
      throw new RangeError(`quantile sample must be finite, got ${String(sample)}`);
    }
  }
  const method = params.quantile.method;
  const n = samples.length;
  if (n === 0) {
    return Object.freeze({ p, method, n, rank: null, value: null, isMaximum: false });
  }
  // Ascending numeric order. An explicit comparator, because the default `sort` compares
  // string forms and would put 100 before 20.
  const sorted = samples.slice().sort((a, b) => a - b);
  const rank = rankFor(n, p);
  // `sorted[rank - 1]` is in range by construction; the fallback exists only because
  // `noUncheckedIndexedAccess` cannot see that, and 0 would be a lie if it ever ran.
  const value = sorted[rank - 1];
  if (value === undefined) {
    throw new RangeError(`quantile rank ${String(rank)} is outside a sample of ${String(n)}`);
  }
  return Object.freeze({ p, method, n, rank, value, isMaximum: rank === n });
}

/**
 * `ceil(p · n)`, clamped into `[1, n]`. The clamp is defensive rather than load-bearing —
 * for `0 < p ≤ 1` the product cannot round above `n` — but a rank is an index into real
 * data, and an index that depends on being lucky with rounding is not an index.
 */
export function rankFor(n: number, p: number): number {
  if (!Number.isInteger(n) || n < 1) {
    throw new RangeError(`quantile sample size must be a positive integer, got ${String(n)}`);
  }
  return Math.min(Math.max(Math.ceil(p * n), 1), n);
}
