/**
 * The weekly QA report's inputs and its record (TASKS D8; migration 011).
 *
 * Two ports, because the inputs come from the pipeline's tables and the report goes to
 * `qa_weekly_reports`, and a test of the job should be able to fake either alone. The
 * inclusion rules are stated here so an adapter cannot quietly pick others; the choices
 * that are not the documents' own are also stamped on every report through
 * `qa_weekly_report_v1` (`core/qa/weekly-report-params.ts`).
 *
 * ## PLB traces (`loadPlbTraces`)
 *
 *   - **One trace per detection**, keyed by `detection_uid`, whose `available_at` is in the
 *     half-open window. The window is on arrival, as for the C9 lag histograms.
 *   - **SP rows are excluded**: a D7 promotion stamps the fetch instant as `available_at`,
 *     and a two-month-old acquisition is not pipeline latency.
 *   - **Quarantined rows are included.** Their `available → ingested` span is real; they
 *     never reach an event, so they add nothing to the later stages.
 *   - `eventUpdatedAtMs` is the detection's **earliest `attached_at` over live clustering
 *     runs** — offline and promoted runs are a backfill's timing, not the pipeline's — or
 *     `null` when no live run holds it. It is a proxy (see the report's open decisions).
 *   - `decidedAtMs`, `providerAckAtMs`, `providerChannel` and `broadcastAtMs` are always
 *     `null`: no key links an outbox row to the detection that triggered it, and no column
 *     records a broadcast. In WP1 those stages are empty by construction (A2).
 *
 * ## DAR alerts (`loadDarAlerts`)
 *
 *   - **Automatic `alert_outbox` rows** (`trigger_type <> 'manual'`) whose `decided_at` is in
 *     the half-open window, every status included — a row cancelled by erasure was still
 *     decided, and the rule that decided it is what DAR grades.
 *   - `eventKey` is the **merge-resolved** survivor's public id, following `merged_into` to
 *     its end, because DAR's definition makes that a precondition (`core/qa/dar.ts`).
 *   - `alertId` is the outbox row id as text.
 */

import type { AlertType } from '../config/alert-gating.js';
import type { PipelineTrace } from '../qa/shadow-plb.js';
import type { EpochMs } from './clock.js';

export interface QaWindowQuery {
  readonly fromMs: EpochMs;
  readonly toMs: EpochMs;
}

export interface QaAlertRow {
  readonly alertId: string;
  readonly zoneId: string;
  readonly eventKey: string;
  readonly alertType: AlertType;
  readonly alertSubkey: string;
  readonly decidedAtMs: EpochMs;
}

export interface QaReportInputReader {
  loadPlbTraces(window: QaWindowQuery): Promise<readonly PipelineTrace[]>;
  loadDarAlerts(window: QaWindowQuery): Promise<readonly QaAlertRow[]>;
}

export interface StoredWeeklyReport {
  readonly isoWeek: string;
  readonly fromMs: EpochMs;
  readonly toMs: EpochMs;
  readonly metricsVersion: string;
  readonly metricsDigest: string;
  readonly reportVersion: string;
  readonly reportDigest: string;
  readonly generatedAtMs: EpochMs;
  /** The canonical JSON, byte for byte as rendered. */
  readonly reportJson: string;
  readonly reportMarkdown: string;
}

export interface QaReportStore {
  /** Whether a report for this week is already stored under these two versions. */
  has(query: {
    readonly isoWeek: string;
    readonly metricsVersion: string;
    readonly reportVersion: string;
  }): Promise<boolean>;
  /**
   * Inserts, or replaces the row for the same week, metrics version and report version.
   * Refuses — throws — when the stored row carries another digest under either version: an
   * in-place edit of a config must not silently rewrite a graded week. A version bump is a
   * new row beside the old one, so a ruling re-grades a week without erasing its grade.
   */
  save(report: StoredWeeklyReport): Promise<void>;
}
