/**
 * Metrics + scenario + thresholds → verdicts. Pure: a saved report can be re-evaluated
 * (after a classification fix, or against a revised threshold table) without re-running.
 *
 * Every metric is either a number or `null` ("not measured": the run did not produce the
 * evidence — no edge header, no T2 URL, no origin-kill phase). A gate row that is not
 * measured makes the run `incomplete`, never `pass`: L-3 is passed on evidence only.
 */

import { Histogram } from './histogram.js';
import type { MetricsData, StreamPhaseStats } from './metrics.js';
import { PHASES, REQUEST_STREAMS, type PhaseName, type Scenario } from './scenario.js';
import {
  L3_THRESHOLDS,
  compare,
  resolveBound,
  type MetricName,
  type Threshold,
  type ThresholdPhase,
} from './thresholds.js';

/**
 * How the edge's cache-status values classify (Cloudflare `cf-cache-status` vocabulary;
 * the emulator in the smoke speaks the same words). Anything not listed is `unknown`.
 * `REVALIDATED` is an edge answer after a conditional check with the origin — the origin
 * saw a request, but a cheap 304 one; it is counted as served by the edge for the hit
 * ratio and as an origin request for origin req/s, which is the conservative reading of
 * both criteria.
 */
export const CACHE_STATUS_CLASSES: Readonly<Record<string, 'edge' | 'origin' | 'both'>> = {
  HIT: 'edge',
  STALE: 'edge',
  UPDATING: 'edge',
  REVALIDATED: 'both',
  MISS: 'origin',
  EXPIRED: 'origin',
  BYPASS: 'origin',
  DYNAMIC: 'origin',
};

/** Above this share of unclassifiable answers the hit ratio is not measured, not guessed. */
export const MAX_UNKNOWN_CACHE_SHARE = 0.01;

export type MetricTable = Readonly<Record<MetricName, number | null>>;

export type VerdictState = 'pass' | 'fail' | 'not_measured' | 'not_applicable';

export interface Verdict {
  readonly id: string;
  readonly kind: Threshold['kind'];
  readonly metric: MetricName;
  readonly observed: number | null;
  readonly op: Threshold['op'];
  readonly bound: number;
  readonly unit: string;
  readonly state: VerdictState;
  readonly source: string;
}

export type Overall = 'pass' | 'fail' | 'invalid' | 'incomplete';

export interface Evaluation {
  readonly metrics: MetricTable;
  readonly verdicts: readonly Verdict[];
  readonly overall: Overall;
  /** True whenever the run was not the gate's own configuration (50×, scale 1, measured). */
  readonly rehearsal: boolean;
  readonly notes: readonly string[];
}

export function evaluate(
  scenario: Scenario,
  metrics: MetricsData,
  thresholds: readonly Threshold[] = L3_THRESHOLDS,
): Evaluation {
  const notes: string[] = [];
  const table = computeMetrics(scenario, metrics, notes);
  const context = {
    sseCap: scenario.sseCap,
    t2ObjectAgeBudgetSeconds: scenario.assumptions.t2ObjectAgeBudgetSeconds,
  };
  const hasOriginKill = scenario.phases.some((p) => p.name === 'origin-kill');
  const sseAboveCap = scenario.totals.sseConnections > scenario.sseCap;

  const verdicts = thresholds.map((threshold): Verdict => {
    const bound = resolveBound(threshold, context);
    const observed = table[threshold.metric];
    const applies =
      threshold.appliesWhen === 'always' ||
      (threshold.appliesWhen === 'sseTargetAboveCap' && sseAboveCap) ||
      (threshold.appliesWhen === 'originKillPhase' && hasOriginKill);
    const state: VerdictState = !applies
      ? 'not_applicable'
      : observed === null
        ? 'not_measured'
        : compare(threshold.op, observed, bound)
          ? 'pass'
          : 'fail';
    return {
      id: threshold.id,
      kind: threshold.kind,
      metric: threshold.metric,
      observed,
      op: threshold.op,
      bound,
      unit: threshold.unit,
      state,
      source: threshold.source,
    };
  });

  const rehearsal =
    scenario.multiplier !== 50 || scenario.scale !== 1 || scenario.baseline.source !== 'measured';
  if (scenario.baseline.source !== 'measured') {
    notes.push('baseline is the planning figure, not a measured season-1 hour (GATES L-3 1×)');
  }
  if (scenario.multiplier !== 50 || scenario.scale !== 1) {
    notes.push(
      `run at ${scenario.multiplier}× × scale ${scenario.scale}, not the gate's 50× × 1: a rehearsal`,
    );
  }

  return { metrics: table, verdicts, overall: overallOf(verdicts), rehearsal, notes };
}

/**
 * `invalid` outranks everything: a generator that could not deliver its own load also
 * inflates the latencies it measured, so the run is re-run, not judged. Then any failed
 * gate row fails the run; then any unmeasured one leaves it incomplete.
 */
export function overallOf(verdicts: readonly Verdict[]): Overall {
  if (verdicts.some((v) => v.kind === 'validity' && v.state === 'fail')) return 'invalid';
  const gates = verdicts.filter((v) => v.kind === 'gate');
  if (gates.some((v) => v.state === 'fail')) return 'fail';
  if (verdicts.some((v) => v.state === 'not_measured')) return 'incomplete';
  return 'pass';
}

export function computeMetrics(
  scenario: Scenario,
  metrics: MetricsData,
  notes: string[] = [],
): MetricTable {
  const steadySnapshot = metrics.phases.steady.streams.snapshot;
  const steadySeconds = metrics.phases.steady.durationMs / 1000;

  // Edge hit ratio and origin req/s, both from the edge's own cache-status header.
  let origin = 0;
  let unknown = 0;
  for (const [value, count] of Object.entries(steadySnapshot.cacheStatus)) {
    const cls = CACHE_STATUS_CLASSES[value];
    if (cls === 'origin' || cls === 'both') origin += count;
    else if (cls === undefined) unknown += count;
  }
  const classified = steadySnapshot.completed - unknown;
  const unknownShare = steadySnapshot.completed === 0 ? 1 : unknown / steadySnapshot.completed;
  const cacheMeasured = classified > 0 && unknownShare <= MAX_UNKNOWN_CACHE_SHARE;
  if (!cacheMeasured && steadySnapshot.completed > 0) {
    notes.push(
      `edge cache-status unclassifiable on ${unknown}/${steadySnapshot.completed} steady snapshot answers: ` +
        'hit ratio and origin req/s not measured (is the generator hitting the edge?)',
    );
  }
  const hitCount = Object.entries(steadySnapshot.cacheStatus).reduce((sum, [value, count]) => {
    const cls = CACHE_STATUS_CLASSES[value];
    return cls === 'edge' || cls === 'both' ? sum + count : sum;
  }, 0);
  const edgeHitRatio = cacheMeasured ? hitCount / classified : null;
  const originRps = cacheMeasured && steadySeconds > 0 ? origin / steadySeconds : null;

  const snapshotP95Ms = Histogram.from(steadySnapshot.latency).quantile(0.95);

  // SSE, over the load phases (ramp + steady).
  const load = phasesOf('load', scenario);
  let ssePeakOpen = 0;
  let uncleanCloses = 0;
  let unexpected = 0;
  let degrades = 0;
  let attempts = 0;
  for (const phase of load) {
    const sse = metrics.phases[phase].sse;
    ssePeakOpen = Math.max(ssePeakOpen, sse.peakOpen);
    uncleanCloses += sse.uncleanCloses;
    attempts += sse.attempts;
    unexpected += sse.refusedWithoutRetryAfter;
    for (const [status, count] of Object.entries(sse.refused)) {
      if (status !== '503' && status !== '429') unexpected += count;
    }
    for (const count of Object.values(sse.degradeFrames)) degrades += count;
  }
  const flipMs = metrics.clientConfig.flipMs;

  // 5xx to map clients: snapshot, client-config and T2 answers in every phase.
  let mapClient5xx = 0;
  for (const phase of PHASES) {
    for (const stream of REQUEST_STREAMS) {
      mapClient5xx += count5xx(metrics.phases[phase].streams[stream]);
    }
  }

  // T2 during the origin-kill phase.
  const t2 = metrics.phases['origin-kill'].streams.t2;
  const t2Attempted = t2.completed + t2.networkErrors;
  const t2Ok = countWhere(t2.status, (s) => (s >= 200 && s < 300) || s === 304);
  const t2SuccessRatio = t2Attempted > 0 ? t2Ok / t2Attempted : null;
  const t2MaxObjectAgeSeconds = t2Attempted > 0 ? metrics.t2.maxObjectAgeSeconds : null;
  if (t2Attempted > 0 && metrics.t2.undated > 0) {
    notes.push(`${metrics.t2.undated} T2 answers carried no object date`);
  }

  // Generator health: arrivals sent against arrivals owed, over the streams it drove.
  let planned = 0;
  let issued = 0;
  for (const stream of REQUEST_STREAMS) {
    if (metrics.planned[stream] <= 0) continue;
    planned += metrics.planned[stream];
    for (const phase of PHASES) issued += metrics.phases[phase].streams[stream].issued;
  }

  return {
    edgeHitRatio,
    originRps,
    snapshotP95Ms,
    ssePeakOpen: attempts > 0 ? ssePeakOpen : null,
    sseDemotionObserved: attempts > 0 ? (degrades > 0 ? 1 : 0) : null,
    sseUncleanCloses: attempts > 0 ? uncleanCloses : null,
    sseUnexpectedStatus: attempts > 0 ? unexpected : null,
    clientConfigFlipSeconds: flipMs === null ? null : flipMs / 1000,
    mapClient5xx,
    t2SuccessRatio,
    t2MaxObjectAgeSeconds,
    generatorAchievedRatio: planned > 0 ? issued / planned : null,
  };
}

function phasesOf(phase: ThresholdPhase, scenario: Scenario): PhaseName[] {
  const present = scenario.phases.map((p) => p.name);
  switch (phase) {
    case 'steady':
      return ['steady'];
    case 'origin-kill':
      return present.filter((p) => p === 'origin-kill');
    case 'load':
      return present.filter((p) => p === 'ramp' || p === 'steady');
    case 'all':
      return present;
  }
}

function count5xx(stats: StreamPhaseStats): number {
  return countWhere(stats.status, (s) => s >= 500 && s < 600);
}

function countWhere(
  counts: Readonly<Record<string, number>>,
  keep: (status: number) => boolean,
): number {
  let total = 0;
  for (const [status, count] of Object.entries(counts)) if (keep(Number(status))) total += count;
  return total;
}
