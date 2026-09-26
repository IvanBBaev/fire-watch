/**
 * PLB — pipeline latency budget compliance (GLOSSARY §8 and §8.1; GATES §4 CP1
 * shadow-PLB).
 *
 * One function computes both readings, because they are the same arithmetic over
 * different columns of the same trace:
 *
 *   - **shadow-PLB** (CP1): "p95 of `available_at` → event visible in the registry
 *     (`event_updated_at`) — the ingest and clustering stages only. Decision, dispatch and
 *     provider-ack stages enter the metric at L-7, when they exist." ≤ 15 min p95.
 *   - **PLB** (steady): every stage of §8.1 plus the controllable total,
 *     "detection row → push ack ≤ 15 min p95".
 *
 * A stage with no observations reports `n = 0` and a `null` value rather than a pass. At
 * CP1 the later stages have no observations *by construction* — there is no alert stack —
 * and that is exactly the shape the report should show.
 *
 * ## What is not budgeted, on purpose
 *
 * Upstream source latency (`acq_ts` → `available_at`, up to ~3 h for FIRMS NRT) "is
 * measured and displayed honestly but never budgeted — it is not ours to control". It is
 * absent from this module. A caller wanting the honest number reports it beside this one;
 * it must never enter a stage that has a budget.
 *
 * ## What this function deliberately cannot answer
 *
 * CP1's second half — "no stage red > 1 day" — is a statement about a *series* of daily
 * evaluations, not about one window. It needs a run per day and a scan across the runs,
 * and inventing a per-window proxy for it would be inventing a threshold. The caller
 * evaluates a day at a time and checks the series; each run's `withinBudget` per stage is
 * the input to that check.
 */

import type { EpochMs } from '../ports/clock.js';
import { QA_METRICS, type QaMetricsParams } from './qa-metrics-params.js';
import { quantileOf, type Quantile } from './quantile.js';

/** The §8.1 stages, in pipeline order. Push and email split because their budgets differ. */
export const PLB_STAGES = [
  'available_to_ingested',
  'ingested_to_event_updated',
  'event_updated_to_decided',
  'decided_to_push_ack',
  'decided_to_email_ack',
  'event_updated_to_broadcast',
] as const;
export type PlbStage = (typeof PLB_STAGES)[number];

/** The stages CP1 measures. The rest exist in the type and report `n = 0` until L-7. */
export const SHADOW_STAGES: readonly PlbStage[] = Object.freeze([
  'available_to_ingested',
  'ingested_to_event_updated',
] as const);

export const PROVIDER_CHANNELS = ['push', 'email'] as const;
export type ProviderChannel = (typeof PROVIDER_CHANNELS)[number];

/**
 * One detection row's journey. Every timestamp after `availableAtMs` is nullable because
 * a trace can legitimately stop anywhere: a detection that joined no event has no
 * `event_updated_at`, and one that triggered no alert has no `decided_at`. A null is "did
 * not happen", never "happened at 0".
 *
 * `availableAt` is §8.1's approximation — "the poll time of the first poll that returned
 * the row" — and not the source's acquisition time.
 */
export interface PipelineTrace {
  readonly traceId: string;
  readonly availableAtMs: EpochMs;
  readonly ingestedAtMs: EpochMs | null;
  readonly eventUpdatedAtMs: EpochMs | null;
  readonly decidedAtMs: EpochMs | null;
  readonly providerAckAtMs: EpochMs | null;
  /** Which budget the ack is judged by. Required whenever there is an ack. */
  readonly providerChannel: ProviderChannel | null;
  readonly broadcastAtMs: EpochMs | null;
}

export interface ShadowPlbInput {
  readonly traces: readonly PipelineTrace[];
  /**
   * The deployed poll interval the ingest budget is stated relative to
   * (`FIRE_WATCH_POLL_INTERVAL_MS`; §8.1 "≤ poll interval + 2 min"). An input rather than
   * a QA parameter, because it is deployment configuration and the budget must follow it.
   */
  readonly pollIntervalMs: number;
}

export interface PlbStageReport {
  readonly stage: PlbStage | 'shadow_total' | 'controllable_total';
  readonly n: number;
  readonly p50: Quantile;
  readonly p95: Quantile;
  readonly budgetMs: number;
  /** `null` when nothing was observed — an unmeasured stage neither passes nor fails. */
  readonly withinBudget: boolean | null;
}

export interface ShadowPlbReport {
  readonly configVersion: string;
  readonly configDigest: string;
  readonly pollIntervalMs: number;
  readonly stages: readonly PlbStageReport[];
  /** CP1's criterion: `available_at` → `event_updated_at`. */
  readonly shadowTotal: PlbStageReport;
  /** §8.1's bottom row: `available_at` → `provider_ack_at`. */
  readonly controllableTotal: PlbStageReport;
}

export function shadowPlb(
  input: ShadowPlbInput,
  params: QaMetricsParams = QA_METRICS.values,
): ShadowPlbReport {
  if (!Number.isFinite(input.pollIntervalMs) || input.pollIntervalMs <= 0) {
    throw new RangeError(
      `poll interval must be a positive number of ms, got ${String(input.pollIntervalMs)}`,
    );
  }
  const samples = new Map<PlbStageReport['stage'], number[]>();
  const push = (stage: PlbStageReport['stage'], value: number): void => {
    const bucket = samples.get(stage);
    if (bucket === undefined) samples.set(stage, [value]);
    else bucket.push(value);
  };

  const seen = new Set<string>();
  for (const trace of input.traces) {
    if (seen.has(trace.traceId)) {
      throw new RangeError(`duplicate pipeline trace ${JSON.stringify(trace.traceId)}`);
    }
    seen.add(trace.traceId);
    assertTrace(trace);

    span(trace, trace.availableAtMs, trace.ingestedAtMs, (ms) => {
      push('available_to_ingested', ms);
    });
    span(trace, trace.ingestedAtMs, trace.eventUpdatedAtMs, (ms) => {
      push('ingested_to_event_updated', ms);
    });
    span(trace, trace.eventUpdatedAtMs, trace.decidedAtMs, (ms) => {
      push('event_updated_to_decided', ms);
    });
    span(trace, trace.decidedAtMs, trace.providerAckAtMs, (ms) => {
      push(trace.providerChannel === 'email' ? 'decided_to_email_ack' : 'decided_to_push_ack', ms);
    });
    span(trace, trace.eventUpdatedAtMs, trace.broadcastAtMs, (ms) => {
      push('event_updated_to_broadcast', ms);
    });
    span(trace, trace.availableAtMs, trace.eventUpdatedAtMs, (ms) => {
      push('shadow_total', ms);
    });
    span(trace, trace.availableAtMs, trace.providerAckAtMs, (ms) => {
      push('controllable_total', ms);
    });
  }

  const report = (stage: PlbStageReport['stage']): PlbStageReport => {
    const values = samples.get(stage) ?? [];
    const budgetMs = budgetFor(stage, input.pollIntervalMs, params);
    const p95 = quantileOf(values, params.quantile.p95, params);
    return Object.freeze({
      stage,
      n: values.length,
      p50: quantileOf(values, params.quantile.p50, params),
      p95,
      budgetMs,
      withinBudget: p95.value === null ? null : p95.value <= budgetMs,
    });
  };

  return Object.freeze({
    configVersion: QA_METRICS.version,
    configDigest: QA_METRICS.digest,
    pollIntervalMs: input.pollIntervalMs,
    stages: Object.freeze(PLB_STAGES.map(report)),
    shadowTotal: report('shadow_total'),
    controllableTotal: report('controllable_total'),
  });
}

/** The §8.1 budget for a stage, in ms. */
export function budgetFor(
  stage: PlbStageReport['stage'],
  pollIntervalMs: number,
  params: QaMetricsParams = QA_METRICS.values,
): number {
  const { plb } = params;
  switch (stage) {
    case 'available_to_ingested':
      return pollIntervalMs + plb.ingestAllowanceMs;
    case 'ingested_to_event_updated':
      return plb.ingestedToEventUpdatedMs;
    case 'event_updated_to_decided':
      return plb.eventUpdatedToDecidedMs;
    case 'decided_to_push_ack':
      return plb.decidedToPushAckMs;
    case 'decided_to_email_ack':
      return plb.decidedToEmailAckMs;
    case 'event_updated_to_broadcast':
      return plb.eventUpdatedToBroadcastMs;
    case 'shadow_total':
      return plb.shadowTotalMs;
    case 'controllable_total':
      return plb.controllableTotalMs;
  }
}

function span(
  trace: PipelineTrace,
  from: EpochMs | null,
  to: EpochMs | null,
  take: (ms: number) => void,
): void {
  if (from === null || to === null) return;
  const ms = to - from;
  if (ms < 0) {
    // A stage that ran backwards is corrupt data, not a fast pipeline. Absorbing it would
    // pull a p95 down with a negative number and hide whatever wrote the row.
    throw new RangeError(
      `pipeline trace ${JSON.stringify(trace.traceId)} has a stage ending ${String(-ms)} ms ` +
        'before it began',
    );
  }
  take(ms);
}

function assertTrace(trace: PipelineTrace): void {
  const stamps: readonly (readonly [string, EpochMs | null])[] = [
    ['availableAtMs', trace.availableAtMs],
    ['ingestedAtMs', trace.ingestedAtMs],
    ['eventUpdatedAtMs', trace.eventUpdatedAtMs],
    ['decidedAtMs', trace.decidedAtMs],
    ['providerAckAtMs', trace.providerAckAtMs],
    ['broadcastAtMs', trace.broadcastAtMs],
  ];
  for (const [name, value] of stamps) {
    if (value !== null && !Number.isFinite(value)) {
      throw new RangeError(
        `pipeline trace ${JSON.stringify(trace.traceId)} has a non-finite ${name}`,
      );
    }
  }
  if (trace.providerAckAtMs !== null && trace.providerChannel === null) {
    throw new RangeError(
      `pipeline trace ${JSON.stringify(trace.traceId)} acknowledges a dispatch without saying ` +
        'which channel, so no budget applies to it',
    );
  }
}
