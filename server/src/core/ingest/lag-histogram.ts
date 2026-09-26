/**
 * NRT-lag histograms — how long after acquisition a detection became visible to us (TASKS
 * C9; A23; 13 §3.3(14); 06 §5.2.2).
 *
 * The lag of one detection is `available_at − acq_ts`. `available_at` is the instant of the
 * first poll that returned the row (the detection insert is `ON CONFLICT DO NOTHING`, so a
 * later poll never moves it); `acq_ts` is the provider's acquisition minute. The histograms
 * are the input D5's `availability.json` is sampled from, and the evidence behind any
 * statement about how late FIRMS actually is over Bulgaria.
 *
 * ## What the number is, and is not
 *
 *   - **An upper bound, quantized by the poll cadence.** A row published one second after
 *     a poll is first seen one poll interval later. The histogram measures *our* lag, which
 *     is what replay needs; the provider's own publication lag is at most this.
 *   - **Inflated after an outage.** The first poll after a worker outage sees every row
 *     published during it, each with the outage added. The rows are not dropped — dropping
 *     them would need a rule nobody has signed — so a day with a known outage should be read
 *     beside `ingest_batches` (see the report on C9).
 *   - **Live rows only.** SP backfill rows carry the fetch instant as `available_at` and are
 *     excluded by the reader, not here; GEO rows are included under their own source.
 *     Quarantined rows are included: a quarantine is a verdict on the *content*, and the
 *     row still arrived when it arrived.
 *
 * ## Properties
 *
 * Pure and deterministic: the same samples give the same histograms in any input order.
 * Mergeable: `mergeLagHistograms` is associative and commutative, so a window is the merge
 * of its closed UTC days and a day recomputed from scratch equals the merge of its parts.
 */

import type { SourceId } from '@fire-watch/contracts';

import type { VersionedConfig } from '../config/versioned-config.js';
import { canonicalJson } from '../determinism/canonical-json.js';
import { epochMsFromIso, isoFromEpochMs, type EpochMs } from '../ports/clock.js';
import type { NrtLagHistogramParams } from './lag-histogram-params.js';

const MS_PER_MINUTE = 60_000;

export interface LagSample {
  readonly source: SourceId;
  readonly acqTsMs: EpochMs;
  readonly availableAtMs: EpochMs;
}

export interface LagHistogram {
  readonly source: SourceId;
  readonly histogramVersion: string;
  readonly histogramDigest: string;
  /** Carried on every histogram so a persisted one is readable without the code. */
  readonly edgesMinutes: readonly number[];
  /** `counts[i]` is the number of lags in `[edges[i], edges[i + 1])` minutes. */
  readonly counts: readonly number[];
  /** Lags below 0 — `available_at < acq_ts`, which only a wrong clock produces. */
  readonly below: number;
  /** Lags at or past the last edge. */
  readonly overflow: number;
  readonly total: number;
  /** Null exactly when `total` is 0. */
  readonly minLagMs: number | null;
  readonly maxLagMs: number | null;
}

export interface DailyLagHistogram {
  /** The UTC calendar day of `available_at`, `YYYY-MM-DD`. */
  readonly day: string;
  readonly histogram: LagHistogram;
}

/** Thrown for edges that could not bucket a lag unambiguously. */
export function assertLagEdges(edgesMinutes: readonly number[]): void {
  if (edgesMinutes.length < 2) {
    throw new RangeError('lag histogram needs at least two edges');
  }
  if (edgesMinutes[0] !== 0) {
    throw new RangeError('lag histogram edges must start at 0');
  }
  for (let i = 0; i < edgesMinutes.length; i += 1) {
    const edge = edgesMinutes[i] ?? Number.NaN;
    if (!Number.isSafeInteger(edge)) {
      throw new RangeError(`lag histogram edge ${String(i)} is not a whole number of minutes`);
    }
    if (i > 0 && edge <= (edgesMinutes[i - 1] ?? Number.NaN)) {
      throw new RangeError('lag histogram edges must be strictly increasing');
    }
  }
}

export function emptyLagHistogram(
  source: SourceId,
  config: VersionedConfig<NrtLagHistogramParams>,
): LagHistogram {
  const edgesMinutes = config.values.edgesMinutes;
  assertLagEdges(edgesMinutes);
  return {
    source,
    histogramVersion: config.version,
    histogramDigest: config.digest,
    edgesMinutes: [...edgesMinutes],
    counts: edgesMinutes.slice(1).map(() => 0),
    below: 0,
    overflow: 0,
    total: 0,
    minLagMs: null,
    maxLagMs: null,
  };
}

/** Returns a new histogram; the argument is never mutated. */
export function addLag(histogram: LagHistogram, lagMs: number): LagHistogram {
  if (!Number.isFinite(lagMs)) throw new RangeError('lag must be a finite number');
  const edges = histogram.edgesMinutes;
  const lastEdgeMs = (edges[edges.length - 1] ?? 0) * MS_PER_MINUTE;
  const counts = [...histogram.counts];
  let { below, overflow } = histogram;
  if (lagMs < 0) {
    below += 1;
  } else if (lagMs >= lastEdgeMs) {
    overflow += 1;
  } else {
    const bucket = bucketOf(edges, lagMs);
    counts[bucket] = (counts[bucket] ?? 0) + 1;
  }
  return {
    ...histogram,
    counts,
    below,
    overflow,
    total: histogram.total + 1,
    minLagMs: histogram.minLagMs === null ? lagMs : Math.min(histogram.minLagMs, lagMs),
    maxLagMs: histogram.maxLagMs === null ? lagMs : Math.max(histogram.maxLagMs, lagMs),
  };
}

/** The largest `i` with `edges[i]` minutes ≤ lag. Callers guarantee `0 ≤ lag < last edge`. */
function bucketOf(edgesMinutes: readonly number[], lagMs: number): number {
  let bucket = 0;
  for (let i = 1; i < edgesMinutes.length - 1; i += 1) {
    if (lagMs >= (edgesMinutes[i] ?? 0) * MS_PER_MINUTE) bucket = i;
  }
  return bucket;
}

/** One histogram per source present in `samples`, sorted by source. */
export function buildLagHistograms(
  samples: Iterable<LagSample>,
  config: VersionedConfig<NrtLagHistogramParams>,
): LagHistogram[] {
  const bySource = new Map<SourceId, LagHistogram>();
  for (const sample of samples) {
    const current = bySource.get(sample.source) ?? emptyLagHistogram(sample.source, config);
    bySource.set(sample.source, addLag(current, sample.availableAtMs - sample.acqTsMs));
  }
  return [...bySource.values()].sort(bySourceOrder);
}

/**
 * One histogram per (UTC day of `available_at`, source), sorted by day then source. A day
 * is keyed by arrival, not acquisition, so a day that has ended can gain no more samples —
 * the property that lets a closed day be persisted once and trusted.
 */
export function dailyLagHistograms(
  samples: Iterable<LagSample>,
  config: VersionedConfig<NrtLagHistogramParams>,
): DailyLagHistogram[] {
  const byDay = new Map<string, LagSample[]>();
  for (const sample of samples) {
    const day = utcDayOf(sample.availableAtMs);
    const list = byDay.get(day);
    if (list === undefined) byDay.set(day, [sample]);
    else list.push(sample);
  }
  return [...byDay.keys()]
    .sort()
    .flatMap((day) =>
      buildLagHistograms(byDay.get(day) ?? [], config).map((histogram) => ({ day, histogram })),
    );
}

export function utcDayOf(ms: EpochMs): string {
  return isoFromEpochMs(ms).slice(0, 10);
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** `YYYY-MM-DD` → its 00:00Z. A date that does not exist is refused, not rolled over. */
export function utcDayStartMs(day: string): EpochMs {
  if (!DAY_RE.test(day)) throw new RangeError(`day must be YYYY-MM-DD, got ${JSON.stringify(day)}`);
  const ms = epochMsFromIso(`${day}T00:00Z`);
  if (utcDayOf(ms) !== day) throw new RangeError(`not a calendar date: ${JSON.stringify(day)}`);
  return ms;
}

/**
 * The sum of two histograms of the same source under the same edges. Refuses anything
 * else: adding counts bucketed under different edges is a number with no meaning.
 */
export function mergeLagHistograms(a: LagHistogram, b: LagHistogram): LagHistogram {
  if (a.source !== b.source) {
    throw new RangeError(`cannot merge lag histograms of ${a.source} and ${b.source}`);
  }
  if (
    a.histogramVersion !== b.histogramVersion ||
    a.histogramDigest !== b.histogramDigest ||
    canonicalJson(a.edgesMinutes) !== canonicalJson(b.edgesMinutes) ||
    a.counts.length !== b.counts.length
  ) {
    throw new RangeError(
      `cannot merge lag histograms under different edges (${a.histogramVersion}/${a.histogramDigest} vs ${b.histogramVersion}/${b.histogramDigest})`,
    );
  }
  return {
    ...a,
    counts: a.counts.map((count, i) => count + (b.counts[i] ?? 0)),
    below: a.below + b.below,
    overflow: a.overflow + b.overflow,
    total: a.total + b.total,
    minLagMs: minOf(a.minLagMs, b.minLagMs),
    maxLagMs: maxOf(a.maxLagMs, b.maxLagMs),
  };
}

/**
 * The inverse CDF at `q ∈ [0, 1]`, linearly interpolated inside a bucket — what D5 needs
 * to turn a seeded uniform draw into a lag. Every bucket is clamped to the observed
 * `[minLagMs, maxLagMs]`, which also gives the open-ended `below` and `overflow` buckets
 * finite bounds. Rounded to a whole millisecond; null for an empty histogram.
 */
export function lagQuantileMs(histogram: LagHistogram, q: number): number | null {
  if (!(q >= 0 && q <= 1)) throw new RangeError(`quantile must be in [0, 1], got ${String(q)}`);
  const { minLagMs, maxLagMs } = histogram;
  if (histogram.total === 0 || minLagMs === null || maxLagMs === null) return null;

  const edges = histogram.edgesMinutes.map((edge) => edge * MS_PER_MINUTE);
  const segments: { count: number; lo: number; hi: number }[] = [
    { count: histogram.below, lo: minLagMs, hi: 0 },
    ...histogram.counts.map((count, i) => ({
      count,
      lo: edges[i] ?? 0,
      hi: edges[i + 1] ?? 0,
    })),
    { count: histogram.overflow, lo: edges[edges.length - 1] ?? 0, hi: maxLagMs },
  ];

  const rank = q * histogram.total;
  let seen = 0;
  for (const segment of segments) {
    if (segment.count === 0) continue;
    if (seen + segment.count >= rank) {
      const lo = Math.max(segment.lo, minLagMs);
      const hi = Math.min(segment.hi, maxLagMs);
      const fraction = (rank - seen) / segment.count;
      return Math.round(lo + (hi - lo) * fraction);
    }
    seen += segment.count;
  }
  return maxLagMs;
}

// ── availability profile ────────────────────────────────────────────────────────

/**
 * The version of the profile document. `@0` because no schema for `availability.json`
 * exists anywhere in the corpus: 06 §5.2.2 describes it as "per-row availability offsets
 * … sampled from the measured NRT lag distribution; deterministic seed", which makes the
 * *distribution* the thing C9 owes and the per-row sampling D5's. This document is that
 * distribution, minimally; D5 may wrap or replace it, and the version says so.
 */
export const AVAILABILITY_PROFILE_FORMAT = 'fire-watch/availability-profile@0';

export interface AvailabilityProfileSource extends Omit<LagHistogram, 'source'> {
  /** How many daily histograms were merged — days with no sample are not counted. */
  readonly days: number;
  /** Printed beside the distribution for a reader without a sampler; derived, not data. */
  readonly quantilesMs: Readonly<Record<'p50' | 'p90' | 'p99', number | null>>;
}

export interface AvailabilityProfile {
  readonly format: typeof AVAILABILITY_PROFILE_FORMAT;
  readonly histogramVersion: string;
  /** Inclusive UTC days of `available_at`. */
  readonly window: { readonly fromDay: string; readonly toDay: string };
  readonly sources: Readonly<Record<string, AvailabilityProfileSource>>;
}

/**
 * Merges daily histograms per source over an inclusive day window. Every input must be
 * under `histogramVersion`; a mixed input throws rather than silently merging edges that
 * disagree.
 */
export function availabilityProfile(input: {
  readonly histogramVersion: string;
  readonly window: { readonly fromDay: string; readonly toDay: string };
  readonly daily: readonly DailyLagHistogram[];
}): AvailabilityProfile {
  const merged = new Map<SourceId, { histogram: LagHistogram; days: number }>();
  for (const { day, histogram } of input.daily) {
    if (day < input.window.fromDay || day > input.window.toDay) continue;
    if (histogram.histogramVersion !== input.histogramVersion) {
      throw new RangeError(
        `daily histogram ${day}/${histogram.source} is ${histogram.histogramVersion}, not ${input.histogramVersion}`,
      );
    }
    const current = merged.get(histogram.source);
    merged.set(
      histogram.source,
      current === undefined
        ? { histogram, days: 1 }
        : { histogram: mergeLagHistograms(current.histogram, histogram), days: current.days + 1 },
    );
  }

  const sources: Record<string, AvailabilityProfileSource> = {};
  for (const source of [...merged.keys()].sort()) {
    const entry = merged.get(source);
    if (entry === undefined) continue;
    const { source: _source, ...histogram } = entry.histogram;
    sources[source] = {
      ...histogram,
      days: entry.days,
      quantilesMs: {
        p50: lagQuantileMs(entry.histogram, 0.5),
        p90: lagQuantileMs(entry.histogram, 0.9),
        p99: lagQuantileMs(entry.histogram, 0.99),
      },
    };
  }

  return {
    format: AVAILABILITY_PROFILE_FORMAT,
    histogramVersion: input.histogramVersion,
    window: { fromDay: input.window.fromDay, toDay: input.window.toDay },
    sources,
  };
}

/** The bytes of `availability.json`: canonical, so a re-export over the same rows is identical. */
export function renderAvailabilityProfile(profile: AvailabilityProfile): string {
  return canonicalJson(profile);
}

function bySourceOrder(a: LagHistogram, b: LagHistogram): number {
  return a.source < b.source ? -1 : a.source > b.source ? 1 : 0;
}

function minOf(a: number | null, b: number | null): number | null {
  if (a === null) return b;
  if (b === null) return a;
  return Math.min(a, b);
}

function maxOf(a: number | null, b: number | null): number | null {
  if (a === null) return b;
  if (b === null) return a;
  return Math.max(a, b);
}
