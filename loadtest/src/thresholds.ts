/**
 * The pass/fail criteria of GATES L-3, as data.
 *
 * Every row names the metric it reads (see `evaluate.ts`), the comparison, the bound, the
 * phase whose numbers it is judged on, and the sentence of the spec it comes from, so the
 * report can print the source next to each verdict and a spec change is a one-row diff.
 *
 * A bound is either a literal or a reference to a scenario figure (`sseCap`,
 * `t2ObjectAgeBudgetSeconds`), because those are inputs the operator may change for a
 * rehearsal and the criterion must follow them rather than drift from them.
 */

export type Comparison = 'gte' | 'lte' | 'eq';

export type ThresholdPhase = 'steady' | 'origin-kill' | 'load' | 'all';

export type BoundRef = 'sseCap' | 't2ObjectAgeBudgetSeconds';

export type Applicability = 'always' | 'sseTargetAboveCap' | 'originKillPhase';

export interface Threshold {
  readonly id: string;
  /** Key into the evaluated metric table (`evaluate.ts` → `MetricTable`). */
  readonly metric: MetricName;
  readonly op: Comparison;
  readonly bound: number | { readonly ref: BoundRef };
  readonly unit: string;
  readonly phase: ThresholdPhase;
  readonly appliesWhen: Applicability;
  /**
   * `gate` rows decide the L-3 verdict. `validity` rows judge the generator itself: a
   * failed validity row makes the run `invalid` (re-run it), never `fail`.
   */
  readonly kind: 'gate' | 'validity';
  readonly source: string;
}

export const METRIC_NAMES = [
  'edgeHitRatio',
  'originRps',
  'snapshotP95Ms',
  'ssePeakOpen',
  'sseDemotionObserved',
  'sseUncleanCloses',
  'sseUnexpectedStatus',
  'clientConfigFlipSeconds',
  'mapClient5xx',
  't2SuccessRatio',
  't2MaxObjectAgeSeconds',
  'generatorAchievedRatio',
] as const;
export type MetricName = (typeof METRIC_NAMES)[number];

export const L3_THRESHOLDS: readonly Threshold[] = [
  {
    id: 'edge-hit-ratio',
    metric: 'edgeHitRatio',
    op: 'gte',
    bound: 0.95,
    unit: 'ratio',
    phase: 'steady',
    appliesWhen: 'always',
    kind: 'gate',
    source: 'GATES L-3: edge cache-hit ratio ≥ 95 % on /snapshot.json',
  },
  {
    id: 'origin-rps',
    metric: 'originRps',
    op: 'lte',
    bound: 5,
    unit: 'req/s',
    phase: 'steady',
    appliesWhen: 'always',
    kind: 'gate',
    source: 'GATES L-3: origin sees ≤ 5 req/s of snapshot traffic',
  },
  {
    id: 'snapshot-p95',
    metric: 'snapshotP95Ms',
    op: 'lte',
    bound: 300,
    unit: 'ms',
    phase: 'steady',
    appliesWhen: 'always',
    kind: 'gate',
    source: 'GATES L-3 / L-2: p95 snapshot fetch ≤ 300 ms at the edge',
  },
  {
    id: 'sse-peak-open',
    metric: 'ssePeakOpen',
    op: 'lte',
    bound: { ref: 'sseCap' },
    unit: 'streams',
    phase: 'load',
    appliesWhen: 'always',
    kind: 'gate',
    source: 'GATES L-3 / ADR-003 D1: SSE clamps at the 5,000 hard cap',
  },
  {
    id: 'sse-demotion-observed',
    metric: 'sseDemotionObserved',
    op: 'gte',
    bound: 1,
    unit: 'bool',
    phase: 'load',
    appliesWhen: 'sseTargetAboveCap',
    kind: 'gate',
    source: 'GATES L-3 / ADR-003 A1.1: demand above the cap demotes the fleet T0 → T1',
  },
  {
    id: 'sse-unclean-closes',
    metric: 'sseUncleanCloses',
    op: 'lte',
    bound: 0,
    unit: 'streams',
    phase: 'load',
    appliesWhen: 'always',
    kind: 'gate',
    source: 'GATES L-3: clean T0 → T1 demotion (every stream closed after a degrade frame)',
  },
  {
    id: 'sse-unexpected-status',
    metric: 'sseUnexpectedStatus',
    op: 'lte',
    bound: 0,
    unit: 'responses',
    phase: 'load',
    appliesWhen: 'always',
    kind: 'gate',
    source: 'E2/E4: a refused stream is a 503/429 with Retry-After, never another status',
  },
  {
    id: 'client-config-flip',
    metric: 'clientConfigFlipSeconds',
    op: 'lte',
    bound: 30,
    unit: 's',
    phase: 'load',
    appliesWhen: 'sseTargetAboveCap',
    kind: 'gate',
    source:
      'ADR-003 D1 / E4: client-config says "poll" within its 30 s cache lifetime of a demotion',
  },
  {
    id: 'map-client-5xx',
    metric: 'mapClient5xx',
    op: 'lte',
    bound: 0,
    unit: 'responses',
    phase: 'all',
    appliesWhen: 'always',
    kind: 'gate',
    source: 'GATES L-3: no 5xx to map clients (snapshot, client-config and T2 requests)',
  },
  {
    id: 't2-success-ratio',
    metric: 't2SuccessRatio',
    op: 'gte',
    bound: 1,
    unit: 'ratio',
    phase: 'origin-kill',
    appliesWhen: 'originKillPhase',
    kind: 'gate',
    source: 'GATES L-3: with the origin killed, T2 keeps serving',
  },
  {
    id: 't2-max-object-age',
    metric: 't2MaxObjectAgeSeconds',
    op: 'lte',
    bound: { ref: 't2ObjectAgeBudgetSeconds' },
    unit: 's',
    phase: 'origin-kill',
    appliesWhen: 'originKillPhase',
    kind: 'gate',
    source: 'GATES L-3 / OPERATIONS §1.3: T2 object age within the snapshot-push budget',
  },
  {
    id: 'generator-achieved-rate',
    metric: 'generatorAchievedRatio',
    op: 'gte',
    bound: 0.9,
    unit: 'ratio',
    phase: 'all',
    appliesWhen: 'always',
    kind: 'validity',
    source:
      'loadtest: the generator issued ≥ 90 % of the planned arrivals (else the run proves nothing)',
  },
];

export interface BoundContext {
  readonly sseCap: number;
  readonly t2ObjectAgeBudgetSeconds: number;
}

export function resolveBound(threshold: Threshold, context: BoundContext): number {
  return typeof threshold.bound === 'number' ? threshold.bound : context[threshold.bound.ref];
}

export function compare(op: Comparison, observed: number, bound: number): boolean {
  switch (op) {
    case 'gte':
      return observed >= bound;
    case 'lte':
      return observed <= bound;
    case 'eq':
      return observed === bound;
  }
}
