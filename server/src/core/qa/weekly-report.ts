/**
 * The weekly QA report (TASKS D8; GLOSSARY §8; A2 shadow definitions; A11 formulas).
 *
 * One pure function from a week's inputs to a report, and two renderings of it: canonical
 * JSON (the record — byte-identical for identical inputs, under any `TZ` or `LC_ALL`) and
 * Markdown (the thing a person reads on Monday). The metrics themselves are the five pure
 * functions next to this file; this module decides only which of them the persisted data
 * can feed, and says so for each one.
 *
 * ## What is measured, and what is not
 *
 *   - **Shadow-PLB — measured, first two stages.** `available → ingested` from `detections`,
 *     `ingested → event updated` through the first-live-attachment proxy. The later stages
 *     are empty by construction in WP1 and are printed with n = 0, not dropped.
 *   - **DAR — measured** over the live pipeline's automatic outbox rows. A repeat of an alert
 *     decided just before Monday 00:00 is still a repeat, so the reader supplies a lead-in of
 *     one suppression window; lead-in alerts are compared against and never counted.
 *   - **Shadow-PCR, FER, FLR — unavailable**, each with the input it lacks. None of them is
 *     approximated: FER from `fire_events.status_changed_at` would lose precisely the
 *     events that re-activated — the premature declarations the numerator counts — so an
 *     approximation would be biased toward passing, which is worse than no number.
 *
 * CER and ZAP are in GLOSSARY §8 but not in D8's list; the report names them as not
 * implemented rather than leaving the omission to be discovered.
 */

import { LIFECYCLE_PARAMS } from '../config/lifecycle-params.js';
import { ALERT_GATING } from '../config/alert-gating.js';
import { canonicalJson } from '../determinism/canonical-json.js';
import type { EpochMs } from '../ports/clock.js';
import { isoFromEpochMs } from '../ports/clock.js';
import type { QaAlertRow } from '../ports/qa-report-store.js';
import { dar, type DispatchedAlert, type DuplicateAlert } from './dar.js';
import type { ReportWindow } from './iso-week.js';
import { QA_METRICS } from './qa-metrics-params.js';
import { meetsAtMost, rateOf, type Rate } from './rate.js';
import {
  SHADOW_STAGES,
  shadowPlb,
  type PipelineTrace,
  type PlbStage,
  type PlbStageReport,
  type ShadowPlbReport,
} from './shadow-plb.js';
import { QA_WEEKLY_REPORT, type OpenDecision } from './weekly-report-params.js';

export const REPORT_KIND = 'fire_watch_qa_weekly_report';

export interface WeeklyReportInput {
  readonly window: ReportWindow;
  readonly generatedAtMs: EpochMs;
  /** The ingest poll interval the week ran under; PLB's first budget depends on it. */
  readonly pollIntervalMs: number;
  /** Detections that arrived in the window (`available_at`), per `QaReportInputReader`. */
  readonly plbTraces: readonly PipelineTrace[];
  /** Automatic alerts decided in `[window.fromMs − suppression window, window.toMs)`. */
  readonly darAlerts: readonly QaAlertRow[];
}

export interface UnavailableMetric {
  readonly status: 'unavailable';
  readonly reason: string;
  /** What would have to exist for the metric to be computed. */
  readonly needs: readonly string[];
}

export interface MeasuredPlb {
  readonly status: 'measured';
  readonly traces: number;
  /** The stages the persisted data can populate; the rest are printed with n = 0. */
  readonly tracedStages: readonly PlbStage[];
  readonly eventUpdatedProxy: string;
  readonly excludedProductTiers: readonly string[];
  readonly report: ShadowPlbReport;
}

export interface MeasuredDar {
  readonly status: 'measured';
  readonly population: string;
  readonly instant: string;
  readonly alertGatingVersion: string;
  readonly suppressionWindowMs: number;
  readonly leadInFrom: string;
  /** Read only to be compared against; never in the numerator or the denominator. */
  readonly leadInAlerts: number;
  readonly rate: Rate;
  readonly shadowMaxRate: number;
  readonly steadyMaxRate: number;
  readonly meetsShadowTarget: boolean | null;
  readonly meetsSteadyTarget: boolean | null;
  readonly duplicates: readonly DuplicateAlert[];
}

export interface WeeklyQaReport {
  readonly kind: typeof REPORT_KIND;
  readonly reportVersion: string;
  readonly reportDigest: string;
  readonly metricsVersion: string;
  readonly metricsDigest: string;
  readonly window: {
    readonly isoWeek: string | null;
    readonly from: string;
    readonly to: string;
    readonly fromMs: EpochMs;
    readonly toMs: EpochMs;
    readonly calendar: string;
    readonly timeZone: string;
    readonly boundaryRatified: boolean;
  };
  readonly generatedAt: string;
  /** False when generated before the window closed: a partial week, never persisted. */
  readonly complete: boolean;
  readonly pollIntervalMs: number;
  readonly metrics: {
    readonly shadowPcr: UnavailableMetric;
    readonly shadowPlb: MeasuredPlb;
    readonly fer: UnavailableMetric;
    readonly flr: UnavailableMetric;
    readonly dar: MeasuredDar;
  };
  readonly notImplemented: readonly { readonly metric: string; readonly why: string }[];
  readonly openDecisions: readonly OpenDecision[];
}

const SHADOW_PCR_UNAVAILABLE: UnavailableMetric = Object.freeze({
  status: 'unavailable',
  reason:
    'No EFFIS burnt-area perimeter is persisted (the C4 refresh caches map layers, not ' +
    'perimeter geometries with an area and an end date), and alert decisions for the ' +
    'synthetic grid zones are computed nowhere and stored nowhere.',
  needs: Object.freeze([
    'a store of EFFIS BA perimeters: id, geometry, area_ha, end date',
    'the default-sensitivity decision per synthetic grid zone and event (GATES shadow-PCR (b))',
  ]),
});

const FER_UNAVAILABLE: UnavailableMetric = Object.freeze({
  status: 'unavailable',
  reason:
    'FER counts events entering no_longer_detected in the week; fire_events keeps only the ' +
    'current status and status_changed_at, so an event that re-activated has lost that ' +
    'entry — and those are exactly the premature declarations the numerator counts. A ' +
    'reconstruction would be biased toward passing.',
  needs: Object.freeze(['a lifecycle transition log: event, from, to, at, status_reason']),
});

const FLR_UNAVAILABLE: UnavailableMetric = Object.freeze({
  status: 'unavailable',
  reason:
    'FLR counts lifecycle direction reversals within 48 h; no table records a transition ' +
    'history, only the current status.',
  needs: Object.freeze([
    'a lifecycle transition log with 48 h of lead-in before the week',
    'the population of events active in the week',
  ]),
});

const NOT_IMPLEMENTED = Object.freeze([
  Object.freeze({ metric: 'CER', why: 'in GLOSSARY §8, not in TASKS D8' }),
  Object.freeze({ metric: 'ZAP', why: 'in GLOSSARY §8, not in TASKS D8' }),
]);

export function buildWeeklyReport(input: WeeklyReportInput): WeeklyQaReport {
  const { window } = input;
  if (!(window.fromMs < window.toMs))
    throw new RangeError('report window must end after it starts');
  if (!Number.isFinite(input.generatedAtMs)) {
    throw new RangeError('report generation instant must be finite');
  }
  const params = QA_WEEKLY_REPORT.values;

  return Object.freeze({
    kind: REPORT_KIND,
    reportVersion: QA_WEEKLY_REPORT.version,
    reportDigest: QA_WEEKLY_REPORT.digest,
    metricsVersion: QA_METRICS.version,
    metricsDigest: QA_METRICS.digest,
    window: Object.freeze({
      isoWeek: window.isoWeek,
      from: isoFromEpochMs(window.fromMs),
      to: isoFromEpochMs(window.toMs),
      fromMs: window.fromMs,
      toMs: window.toMs,
      calendar: params.week.calendar,
      timeZone: params.week.timeZone,
      boundaryRatified: params.week.ratified,
    }),
    generatedAt: isoFromEpochMs(input.generatedAtMs),
    complete: input.generatedAtMs >= window.toMs,
    pollIntervalMs: input.pollIntervalMs,
    metrics: Object.freeze({
      shadowPcr: SHADOW_PCR_UNAVAILABLE,
      shadowPlb: measurePlb(input),
      fer: FER_UNAVAILABLE,
      flr: FLR_UNAVAILABLE,
      dar: measureDar(input),
    }),
    notImplemented: NOT_IMPLEMENTED,
    openDecisions: params.openDecisions,
  });
}

function measurePlb(input: WeeklyReportInput): MeasuredPlb {
  const { fromMs, toMs } = input.window;
  for (const trace of input.plbTraces) {
    if (!(trace.availableAtMs >= fromMs && trace.availableAtMs < toMs)) {
      throw new RangeError(
        `trace ${JSON.stringify(trace.traceId)} arrived outside the report window; the ` +
          'reader and the report must agree on the population',
      );
    }
  }
  const params = QA_WEEKLY_REPORT.values.plb;
  return Object.freeze({
    status: 'measured',
    traces: input.plbTraces.length,
    tracedStages: SHADOW_STAGES,
    eventUpdatedProxy: params.eventUpdatedProxy,
    excludedProductTiers: params.excludedProductTiers,
    report: shadowPlb({ traces: input.plbTraces, pollIntervalMs: input.pollIntervalMs }),
  });
}

function measureDar(input: WeeklyReportInput): MeasuredDar {
  const { fromMs, toMs } = input.window;
  const gating = ALERT_GATING.values;
  const leadInFromMs = fromMs - gating.suppressionWindowMs;
  const inWindow = new Set<string>();
  const alerts: DispatchedAlert[] = input.darAlerts.map((row) => {
    if (!(row.decidedAtMs >= leadInFromMs && row.decidedAtMs < toMs)) {
      throw new RangeError(
        `alert ${JSON.stringify(row.alertId)} was decided outside the window and its lead-in`,
      );
    }
    if (row.decidedAtMs >= fromMs) inWindow.add(row.alertId);
    return {
      alertId: row.alertId,
      zoneId: row.zoneId,
      eventKey: row.eventKey,
      alertType: row.alertType,
      dispatchedAtMs: row.decidedAtMs,
      ladderStep: row.alertType === 'escalation' ? ladderStepFromSubkey(row.alertSubkey) : 0,
    };
  });

  // DAR over window + lead-in, so a repeat across the boundary is seen; then only the
  // window's own alerts are counted, on both sides of the ratio.
  const whole = dar({ alerts });
  const duplicates = whole.duplicates.filter((entry) => inWindow.has(entry.alertId));
  const rate = rateOf(duplicates.length, inWindow.size);
  const params = QA_METRICS.values;
  const choices = QA_WEEKLY_REPORT.values.dar;

  return Object.freeze({
    status: 'measured',
    population: choices.population,
    instant: choices.instant,
    alertGatingVersion: whole.alertGatingVersion,
    suppressionWindowMs: whole.suppressionWindowMs,
    leadInFrom: isoFromEpochMs(leadInFromMs),
    leadInAlerts: alerts.length - inWindow.size,
    rate,
    shadowMaxRate: params.dar.shadowMaxRate,
    steadyMaxRate: params.dar.steadyMaxRate,
    meetsShadowTarget: meetsAtMost(rate, params.dar.shadowMaxRate, params),
    meetsSteadyTarget: meetsAtMost(rate, params.dar.steadyMaxRate, params),
    duplicates: Object.freeze(duplicates),
  });
}

/** The `step-N` subkey `escalationSubkey` writes; anything else is a corrupt row. */
export function ladderStepFromSubkey(subkey: string): number {
  const match = /^step-([1-9]\d*)$/.exec(subkey);
  if (match === null) {
    throw new RangeError(`escalation subkey ${JSON.stringify(subkey)} is not step-N`);
  }
  return Number(match[1]);
}

/** The record: canonical JSON, one line, no trailing newline. */
export function renderReportJson(report: WeeklyQaReport): string {
  return canonicalJson(report);
}

/**
 * The human rendering. Number formatting is `toFixed` only — never `toLocaleString` or
 * `Intl`, which would print `1,5 %` under a Bulgarian locale and break byte stability.
 */
export function renderReportMarkdown(report: WeeklyQaReport): string {
  const { window, metrics } = report;
  const plb = metrics.shadowPlb.report;
  const darMetric = metrics.dar;
  const lines: string[] = [];
  const title = window.isoWeek ?? `${window.from} – ${window.to}`;

  lines.push(`# Fire Watch weekly QA report: ${title}`, '');
  lines.push(
    `- Window: ${window.from} to ${window.to} (${window.calendar}, ${window.timeZone}; ` +
      `boundary ${window.boundaryRatified ? 'ratified' : 'NOT ratified'})`,
    `- Generated: ${report.generatedAt}${report.complete ? '' : ' (window still open: partial)'}`,
    `- Metrics config: ${report.metricsVersion} (${report.metricsDigest})`,
    `- Report config: ${report.reportVersion} (${report.reportDigest})`,
    `- Poll interval: ${formatMs(report.pollIntervalMs)}`,
    '',
  );

  const pcrTargets = QA_METRICS.values.perimeters.strata
    .map((s) => `>= ${pct(s.targetRate)} (>= ${String(s.minAreaHa)} ha)`)
    .join('; ');
  const lifecycle = LIFECYCLE_PARAMS.values;
  lines.push('## Summary', '');
  lines.push('| Metric | Status | Value | Population | Target | Meets |');
  lines.push('|---|---|---|---|---|---|');
  lines.push(`| Shadow-PCR | unavailable | - | - | ${pcrTargets} | - |`);
  lines.push(
    `| Shadow-PLB (available to event updated, p95) | measured | ` +
      `${quantileText(plb.shadowTotal.p95.value)} | n = ${String(plb.shadowTotal.n)} | ` +
      `<= ${formatMs(plb.shadowTotal.budgetMs)} | ${verdict(plb.shadowTotal.withinBudget)} |`,
  );
  lines.push(
    `| FER | unavailable | - | - | <= ${pct(lifecycle.ferMaxRate)} overall, ` +
      `<= ${pct(lifecycle.ferMaxRateLarge)} large | - |`,
  );
  lines.push('| FLR | unavailable | - | - | flag + review (no numeric gate) | - |');
  lines.push(
    `| DAR | measured | ${rateText(darMetric.rate)} | ${String(darMetric.rate.denominator)} alerts | ` +
      `<= ${pct(darMetric.shadowMaxRate)} shadow, <= ${pct(darMetric.steadyMaxRate)} steady | ` +
      `shadow ${verdict(darMetric.meetsShadowTarget)}, steady ${verdict(darMetric.meetsSteadyTarget)} |`,
  );
  lines.push('');

  lines.push('## Shadow-PLB stages', '');
  lines.push(
    `${String(metrics.shadowPlb.traces)} detection traces; product tiers excluded: ` +
      `${metrics.shadowPlb.excludedProductTiers.join(', ')}; event-updated proxy: ` +
      `${metrics.shadowPlb.eventUpdatedProxy}. Traced stages: ` +
      `${metrics.shadowPlb.tracedStages.join(', ')}.`,
    '',
  );
  lines.push('| Stage | n | p50 | p95 | Budget (p95) | Within budget |');
  lines.push('|---|---|---|---|---|---|');
  for (const stage of [...plb.stages, plb.shadowTotal, plb.controllableTotal]) {
    lines.push(stageRow(stage));
  }
  lines.push('');

  lines.push('## DAR', '');
  lines.push(
    `Population: ${darMetric.population}, measured at ${darMetric.instant}; suppression ` +
      `window ${formatMs(darMetric.suppressionWindowMs)} (${darMetric.alertGatingVersion}); ` +
      `lead-in from ${darMetric.leadInFrom}: ${String(darMetric.leadInAlerts)} alerts, compared ` +
      'against and never counted.',
    '',
  );
  if (darMetric.duplicates.length === 0) {
    lines.push('No duplicates.');
  } else {
    lines.push('| Alert | Repeats | Gap |');
    lines.push('|---|---|---|');
    for (const duplicate of darMetric.duplicates) {
      lines.push(
        `| ${duplicate.alertId} | ${duplicate.repeatsAlertId} | ${formatMs(duplicate.gapMs)} |`,
      );
    }
  }
  lines.push('');

  lines.push('## Unavailable metrics', '');
  for (const [name, metric] of [
    ['Shadow-PCR', metrics.shadowPcr],
    ['FER', metrics.fer],
    ['FLR', metrics.flr],
  ] as const) {
    lines.push(`- **${name}**: ${metric.reason}`);
    for (const need of metric.needs) lines.push(`  - needs ${need}`);
  }
  lines.push('');

  lines.push('## Not implemented', '');
  for (const entry of report.notImplemented) lines.push(`- ${entry.metric}: ${entry.why}`);
  lines.push('');

  lines.push('## Open decisions', '');
  for (const decision of report.openDecisions) {
    lines.push(`- \`${decision.id}\`: ${decision.question} Interim: ${decision.interim}`);
  }
  lines.push('');
  return lines.join('\n');
}

function stageRow(stage: PlbStageReport): string {
  return (
    `| ${stage.stage} | ${String(stage.n)} | ${quantileText(stage.p50.value)} | ` +
    `${quantileText(stage.p95.value)} | ${formatMs(stage.budgetMs)} | ${verdict(stage.withinBudget)} |`
  );
}

function quantileText(value: number | null): string {
  return value === null ? '-' : formatMs(value);
}

function rateText(rate: Rate): string {
  const ratio = `${String(rate.numerator)}/${String(rate.denominator)}`;
  return rate.rate === null ? `unmeasured (${ratio})` : `${pct(rate.rate)} (${ratio})`;
}

function verdict(value: boolean | null): string {
  if (value === null) return 'unmeasured';
  return value ? 'yes' : 'no';
}

function pct(rate: number): string {
  return `${(rate * 100).toFixed(2)} %`;
}

function formatMs(ms: number): string {
  if (ms >= 3_600_000) return `${(ms / 3_600_000).toFixed(1)} h`;
  if (ms >= 60_000) return `${(ms / 60_000).toFixed(1)} min`;
  return `${(ms / 1_000).toFixed(1)} s`;
}
