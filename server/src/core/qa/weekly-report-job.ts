/**
 * The weekly QA report job (TASKS D8): read one week's inputs, build the report, keep it.
 *
 * Driven two ways. The worker's loop calls it with no window, and it reports the **last
 * closed** ISO week — once: a week already stored under the current metrics and report
 * versions is skipped, so an hourly loop costs one indexed lookup an hour. The CLI passes
 * an explicit window and always builds (a re-run replaces the stored row under the same
 * digests, and is refused under a different one — `QaReportStore.save`).
 *
 * Only a **closed, labelled ISO week** is persisted. An ad-hoc `--from/--to` range, or a
 * week still open at `clock.now()`, is built and returned but never stored: the table holds
 * one row per week, and a partial week filed under a week's name would be read as the whole.
 */

import type { Clock } from '../ports/clock.js';
import type { QaReportInputReader, QaReportStore } from '../ports/qa-report-store.js';
import { ALERT_GATING } from '../config/alert-gating.js';
import { lastClosedIsoWeek, type ReportWindow } from './iso-week.js';
import { lifecycleLeadInMs } from './lifecycle-metrics.js';
import { QA_METRICS } from './qa-metrics-params.js';
import {
  buildWeeklyReport,
  renderReportJson,
  renderReportMarkdown,
  type WeeklyQaReport,
} from './weekly-report.js';
import { QA_WEEKLY_REPORT } from './weekly-report-params.js';

export interface WeeklyQaReportDeps {
  readonly reader: QaReportInputReader;
  readonly store: QaReportStore;
  readonly clock: Clock;
  readonly pollIntervalMs: number;
}

export interface WeeklyQaReportOptions {
  /** An explicit window (CLI). Absent: the last closed ISO week, skipped if stored. */
  readonly window?: ReportWindow;
}

export type WeeklyQaReportOutcome =
  | { readonly outcome: 'skipped'; readonly isoWeek: string; readonly reason: 'already_stored' }
  | {
      readonly outcome: 'built';
      readonly isoWeek: string | null;
      readonly persisted: boolean;
      readonly report: WeeklyQaReport;
      readonly json: string;
      readonly markdown: string;
    };

export async function runWeeklyQaReport(
  deps: WeeklyQaReportDeps,
  options: WeeklyQaReportOptions = {},
): Promise<WeeklyQaReportOutcome> {
  const scheduled = options.window === undefined;
  const window = options.window ?? lastClosedIsoWeek(deps.clock.now());

  if (scheduled && window.isoWeek !== null) {
    const stored = await deps.store.has({
      isoWeek: window.isoWeek,
      metricsVersion: QA_METRICS.version,
      reportVersion: QA_WEEKLY_REPORT.version,
    });
    if (stored) return { outcome: 'skipped', isoWeek: window.isoWeek, reason: 'already_stored' };
  }

  const leadIn = ALERT_GATING.values.suppressionWindowMs;
  const [plbTraces, darAlerts, lifecycle] = await Promise.all([
    deps.reader.loadPlbTraces({ fromMs: window.fromMs, toMs: window.toMs }),
    deps.reader.loadDarAlerts({ fromMs: window.fromMs - leadIn, toMs: window.toMs }),
    deps.reader.loadLifecycleHistory({
      fromMs: window.fromMs,
      toMs: window.toMs,
      leadInMs: lifecycleLeadInMs(),
    }),
  ]);
  // Stamped after the reads, so `complete` cannot claim a week closed that was still open
  // when the rows were read.
  const generatedAtMs = deps.clock.now();
  const report = buildWeeklyReport({
    window,
    generatedAtMs,
    pollIntervalMs: deps.pollIntervalMs,
    plbTraces,
    darAlerts,
    lifecycle,
  });
  const json = renderReportJson(report);
  const markdown = renderReportMarkdown(report);

  const persisted = window.isoWeek !== null && report.complete;
  if (persisted && window.isoWeek !== null) {
    await deps.store.save({
      isoWeek: window.isoWeek,
      fromMs: window.fromMs,
      toMs: window.toMs,
      metricsVersion: report.metricsVersion,
      metricsDigest: report.metricsDigest,
      reportVersion: report.reportVersion,
      reportDigest: report.reportDigest,
      generatedAtMs,
      reportJson: json,
      reportMarkdown: markdown,
    });
  }
  return { outcome: 'built', isoWeek: window.isoWeek, persisted, report, json, markdown };
}

/** The loop's one-line summary: counts and verdicts, never the report body. */
export function summarizeOutcome(outcome: WeeklyQaReportOutcome): Record<string, unknown> {
  if (outcome.outcome === 'skipped') {
    return { outcome: 'skipped', isoWeek: outcome.isoWeek, reason: outcome.reason };
  }
  const { metrics } = outcome.report;
  return {
    outcome: 'built',
    isoWeek: outcome.isoWeek,
    persisted: outcome.persisted,
    complete: outcome.report.complete,
    metricsVersion: outcome.report.metricsVersion,
    reportVersion: outcome.report.reportVersion,
    plbTraces: metrics.shadowPlb.traces,
    plbShadowP95Ms: metrics.shadowPlb.report.shadowTotal.p95.value,
    plbWithinBudget: metrics.shadowPlb.report.shadowTotal.withinBudget,
    darNumerator: metrics.dar.rate.numerator,
    darDenominator: metrics.dar.rate.denominator,
    darMeetsShadowTarget: metrics.dar.meetsShadowTarget,
    unavailable: ['shadowPcr', 'fer', 'flr'],
  };
}
