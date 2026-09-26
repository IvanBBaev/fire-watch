/**
 * FER and FLR for one report window, from the lifecycle transition log (TASKS D8;
 * GLOSSARY §8; migration 019).
 *
 * `fer.ts` and `flr.ts` are the metrics. This module turns the log's rows into their
 * inputs, and decides — for each — whether the log can answer at all.
 *
 * ## When the log cannot answer
 *
 * The log begins with migration 019 (`lifecycle_log_origin`). A week it does not fully
 * cover would read as an empty history, and an empty history is a perfect score. So:
 *
 *   - **FER** is measured only if the log began at or before the start of its declaration
 *     window (below).
 *   - **FLR** is measured only if the log began at or before the window start minus FLR's
 *     own lead-in (48 h): a reversal pattern that completes on Monday began on Saturday.
 *
 * Otherwise the metric is reported unavailable, with the instant the log began.
 *
 * ## FER's declaration window is shifted by FER's own window
 *
 * FER counts a declaration as premature if a detection re-attaches within 72 h. A report
 * built minutes after Sunday midnight has not seen Wednesday, so a declaration made on
 * Sunday would count as correct only for want of time — a bias toward passing. The
 * report for `[from, to)` therefore grades declarations made in
 * `[from − 72 h, to − 72 h)`: consecutive weeks grade every declaration exactly once, and
 * every one of them had its full window before the report could be built. The reading is
 * stamped in the report (`qa_weekly_report_v2`, open decision `fer_declaration_window`).
 *
 * ## Populations
 *
 *   - **FER** — every event that entered `no_longer_detected` in the declaration window,
 *     merged-away events included: the declaration happened, whatever the event became. A
 *     second closure of the same event in one window is a second declaration and gets a
 *     distinct id (`<public id>#2`, …, in time order), as `fer()` requires. The closure
 *     reason is `unobservable` when the log says so — A2.3(3)'s class — and `miss_evidence`
 *     otherwise. The large-event class is judged by `isLargeEvent` from the facts the log
 *     recorded *at the declaration*; peat/landfill fuel is unknown live and counts as no.
 *   - **FLR** — events not merged away that transitioned in the window or its lead-in, or
 *     were `active` at the window start. A merge sets `merged_into` with no instant and no
 *     status change, so a tombstone keeps its last status forever and would read as
 *     active every week after; tombstones are therefore left out (open decision
 *     `flr_tombstones`). "Active in the window" means the status `active` at the start or
 *     entered during the window. Creation rows are not transitions for FLR: an event's
 *     birth is not a change of direction.
 */

import type { LifecycleState } from '@fire-watch/contracts';

import { LIFECYCLE_PARAMS, type LifecycleParams } from '../config/lifecycle-params.js';
import { isLargeEvent } from '../lifecycle/lifecycle-state.js';
import { isoFromEpochMs, type EpochMs } from '../ports/clock.js';
import { fer, type ExtinguishDeclaration, type FerReport } from './fer.js';
import { flr, type FlrEvent, type FlrReport, type LifecycleTransition } from './flr.js';
import { QA_METRICS, type QaMetricsParams } from './qa-metrics-params.js';

const HOUR_MS = 3_600_000;

/** One `fire_event_transitions` row, as the reader returns it. */
export interface QaTransitionRow {
  readonly publicId: string;
  readonly atMs: EpochMs;
  /** `null` on the row that records the event's creation. */
  readonly from: LifecycleState | null;
  readonly to: LifecycleState;
  readonly reason: string | null;
  readonly maxFrpMw: number | null;
  readonly hullAreaHa: number | null;
  /** The event has since been merged into another (`merged_into` is set now). */
  readonly merged: boolean;
  /**
   * For a row entering `no_longer_detected`: the first detection attached to the event in
   * a live clustering run strictly after this transition, or `null`. Ignored otherwise.
   */
  readonly reattachedAtMs: EpochMs | null;
}

/** An FLR candidate: an event not merged away, and its status at the window start. */
export interface QaLifecyclePopulationRow {
  readonly publicId: string;
  /** `null` when the event did not exist yet at the window start. */
  readonly statusAtStart: LifecycleState | null;
}

export interface QaLifecycleHistory {
  /** When the transition log began, or `null` if the reader found no origin row. */
  readonly logStartedAtMs: EpochMs | null;
  /** Every row with `atMs` in `[from − lifecycleLeadInMs(), to)`, in (event, time) order. */
  readonly transitions: readonly QaTransitionRow[];
  readonly population: readonly QaLifecyclePopulationRow[];
}

export interface LifecycleUnavailable {
  readonly status: 'unavailable';
  readonly reason: string;
  readonly needs: readonly string[];
}

export interface MeasuredFer {
  readonly status: 'measured';
  /** The shifted window the declarations were taken from. */
  readonly declarationsFrom: string;
  readonly declarationsTo: string;
  readonly declarations: number;
  readonly report: FerReport;
}

export interface MeasuredFlr {
  readonly status: 'measured';
  readonly transitionsFrom: string;
  readonly report: FlrReport;
}

/** How far before the window the reader must read: the longer of the two metrics' needs. */
export function lifecycleLeadInMs(
  params: QaMetricsParams = QA_METRICS.values,
  lifecycle: LifecycleParams = LIFECYCLE_PARAMS.values,
): number {
  return Math.max(params.flr.windowHours, lifecycle.ferWindowHours) * HOUR_MS;
}

export function measureFer(
  window: { readonly fromMs: EpochMs; readonly toMs: EpochMs },
  history: QaLifecycleHistory,
  params: QaMetricsParams = QA_METRICS.values,
  lifecycle: LifecycleParams = LIFECYCLE_PARAMS.values,
): MeasuredFer | LifecycleUnavailable {
  const shiftMs = lifecycle.ferWindowHours * HOUR_MS;
  const fromMs = window.fromMs - shiftMs;
  const toMs = window.toMs - shiftMs;
  const uncovered = coverageGap(history.logStartedAtMs, fromMs, 'FER');
  if (uncovered !== null) return uncovered;

  const closures = new Map<string, number>();
  const declarations: ExtinguishDeclaration[] = [];
  for (const row of history.transitions) {
    if (row.to !== 'no_longer_detected' || row.atMs < fromMs || row.atMs >= toMs) continue;
    const n = (closures.get(row.publicId) ?? 0) + 1;
    closures.set(row.publicId, n);
    declarations.push({
      publicId: n === 1 ? row.publicId : `${row.publicId}#${String(n)}`,
      declaredAtMs: row.atMs,
      reason: row.reason === 'unobservable' ? 'unobservable' : 'miss_evidence',
      large: isLargeEvent(
        { hullAreaHa: row.hullAreaHa, maxFrpMw: row.maxFrpMw, peatOrLandfill: false },
        lifecycle,
      ),
      reattachedAtMs: row.reattachedAtMs,
    });
  }

  return Object.freeze({
    status: 'measured',
    declarationsFrom: isoFromEpochMs(fromMs),
    declarationsTo: isoFromEpochMs(toMs),
    declarations: declarations.length,
    report: fer({ declarations }, params, lifecycle),
  });
}

export function measureFlr(
  window: { readonly fromMs: EpochMs; readonly toMs: EpochMs },
  history: QaLifecycleHistory,
  params: QaMetricsParams = QA_METRICS.values,
): MeasuredFlr | LifecycleUnavailable {
  const leadInFromMs = window.fromMs - params.flr.windowHours * HOUR_MS;
  const uncovered = coverageGap(history.logStartedAtMs, leadInFromMs, 'FLR');
  if (uncovered !== null) return uncovered;

  const population = new Map(history.population.map((row) => [row.publicId, row]));
  const transitions: LifecycleTransition[] = [];
  const enteredActive = new Set<string>();
  for (const row of history.transitions) {
    if (row.merged || row.from === null) continue;
    if (row.atMs < leadInFromMs || row.atMs >= window.toMs) continue;
    if (!population.has(row.publicId)) {
      throw new Error(
        `transition of ${JSON.stringify(row.publicId)} has no FLR population row; the reader ` +
          'and the report must agree on the population',
      );
    }
    transitions.push({ publicId: row.publicId, atMs: row.atMs, from: row.from, to: row.to });
    if (row.to === 'active' && row.atMs >= window.fromMs) enteredActive.add(row.publicId);
  }
  // A creation inside the window starts the event active; creation rows are not
  // transitions, so they are read for this alone.
  for (const row of history.transitions) {
    if (row.merged || row.from !== null || row.to !== 'active') continue;
    if (row.atMs >= window.fromMs && row.atMs < window.toMs) enteredActive.add(row.publicId);
  }

  const events: FlrEvent[] = history.population.map((row) => ({
    publicId: row.publicId,
    activeInWindow: row.statusAtStart === 'active' || enteredActive.has(row.publicId),
  }));

  return Object.freeze({
    status: 'measured',
    transitionsFrom: isoFromEpochMs(leadInFromMs),
    report: flr(
      { windowStartMs: window.fromMs, windowEndMs: window.toMs, events, transitions },
      params,
    ),
  });
}

function coverageGap(
  logStartedAtMs: EpochMs | null,
  neededFromMs: EpochMs,
  metric: 'FER' | 'FLR',
): LifecycleUnavailable | null {
  if (logStartedAtMs !== null && logStartedAtMs <= neededFromMs) return null;
  const began =
    logStartedAtMs === null ? 'has no recorded origin' : `began ${isoFromEpochMs(logStartedAtMs)}`;
  return Object.freeze({
    status: 'unavailable',
    reason:
      `${metric} needs the lifecycle transition log from ${isoFromEpochMs(neededFromMs)}; the ` +
      `log ${began}. An uncovered week would read an empty history as a perfect score.`,
    needs: Object.freeze([`transition history from ${isoFromEpochMs(neededFromMs)}`]),
  });
}
