/**
 * How old the T2 object is *as the public hostname serves it*, against the `snapshot-push`
 * budget (TASKS E3; A1.2 "the R2 object gets its own liveness check against the T2
 * freshness bound, independent of origin health"; OPERATIONS §1.3 warn 5 min, critical
 * 15 min).
 *
 * **The age anchor is something the job wrote.** In order of preference:
 *   1. `x-amz-meta-generated-at` — the job's own stamp, identical to the body's
 *      `generated_at` the client's staleness clock reads, and written by the same clock the
 *      monitor reads (both loops run in the worker), so no cross-host skew;
 *   2. `Last-Modified` — the store's write time, which travels with the cached object.
 * Never `Date` or `Age`: those describe the response or the cache, and an edge that
 * revalidated a week-old object a second ago would otherwise read as fresh (the F4 304
 * lesson, from the server side).
 */

import type { FreshnessBudget } from '../config/freshness-budgets.js';
import type { EpochMs } from '../ports/clock.js';
import { isoFromEpochMs } from '../ports/clock.js';
import type { PublicObjectObservation } from '../ports/object-store.js';

/** A stamp this far in the future is a clock problem, not a fresh object. */
export const FUTURE_STAMP_TOLERANCE_MS = 60_000;

export type MirrorAgeLevel = 'ok' | 'warn' | 'critical';

export type MirrorAgeReason =
  'fresh' | 'stale' | 'future_stamp' | 'no_age_signal' | 'missing' | 'unreachable';

export interface MirrorAgeVerdict {
  readonly level: MirrorAgeLevel;
  readonly reason: MirrorAgeReason;
  readonly age_seconds: number | null;
  readonly anchor: 'metadata' | 'last-modified' | null;
  readonly generated_at: string | null;
  readonly warn_seconds: number;
  readonly critical_seconds: number;
  readonly status: number | null;
  readonly detail: string | null;
}

export function evaluateMirrorAge(
  observation: PublicObjectObservation,
  nowMs: EpochMs,
  budget: Pick<FreshnessBudget, 'warnSeconds' | 'criticalSeconds'>,
): MirrorAgeVerdict {
  const base = {
    warn_seconds: budget.warnSeconds,
    critical_seconds: budget.criticalSeconds,
  };
  if (observation.kind === 'unreachable') {
    // The fallback tier being unreachable is the fallback tier being down.
    return {
      ...base,
      level: 'critical',
      reason: 'unreachable',
      age_seconds: null,
      anchor: null,
      generated_at: null,
      status: null,
      detail: observation.reason,
    };
  }
  if (observation.kind === 'missing') {
    return {
      ...base,
      level: 'critical',
      reason: 'missing',
      age_seconds: null,
      anchor: null,
      generated_at: null,
      status: observation.status,
      detail: null,
    };
  }

  const anchor =
    observation.generatedAtMs !== null
      ? ({ at: observation.generatedAtMs, kind: 'metadata' } as const)
      : observation.lastModifiedMs !== null
        ? ({ at: observation.lastModifiedMs, kind: 'last-modified' } as const)
        : null;
  if (anchor === null) {
    // An object whose age cannot be told is treated as one that cannot be vouched for.
    return {
      ...base,
      level: 'critical',
      reason: 'no_age_signal',
      age_seconds: null,
      anchor: null,
      generated_at: null,
      status: observation.status,
      detail: null,
    };
  }

  const ageMs = nowMs - anchor.at;
  const common = {
    ...base,
    anchor: anchor.kind,
    generated_at: isoFromEpochMs(anchor.at),
    status: observation.status,
    detail: null,
  };
  if (ageMs < -FUTURE_STAMP_TOLERANCE_MS) {
    return {
      ...common,
      level: 'warn',
      reason: 'future_stamp',
      age_seconds: Math.floor(ageMs / 1000),
    };
  }
  const ageSeconds = Math.max(0, Math.floor(ageMs / 1000));
  const level: MirrorAgeLevel =
    ageSeconds >= budget.criticalSeconds
      ? 'critical'
      : ageSeconds >= budget.warnSeconds
        ? 'warn'
        : 'ok';
  return { ...common, level, reason: level === 'ok' ? 'fresh' : 'stale', age_seconds: ageSeconds };
}
