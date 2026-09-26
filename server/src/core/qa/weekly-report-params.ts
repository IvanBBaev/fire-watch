/**
 * The weekly QA report's own choices, as versioned config-as-data (TASKS D8; ADR-002 D5).
 *
 * `qa_metrics_v1` holds the metrics' definitions and targets. This config holds what the
 * *report* decides on top of them — the week, and how each measured metric's population is
 * read from the live tables — because each of those is a choice the documents did not make
 * and a founder may overturn. Stamping them with a version and a digest means a report
 * written under an unratified reading says so in its own bytes, and a ruling is a version
 * bump rather than an edit that silently re-grades old weeks.
 *
 * Nothing here is a threshold. Every target the report compares against comes from
 * `qa_metrics_v1`, `lifecycle_params_v1` or `alert_gating_v1`; a value those leave open
 * stays open here.
 */

import { defineConfig, type VersionedConfig } from '../config/versioned-config.js';

export interface OpenDecision {
  readonly id: string;
  readonly question: string;
  /** What this version does until the question is answered. */
  readonly interim: string;
}

export interface QaWeeklyReportParams {
  readonly week: {
    readonly calendar: 'iso8601';
    readonly timeZone: 'UTC';
    /** False until the founder rules on the week boundary (see `iso-week.ts`). */
    readonly ratified: boolean;
  };
  readonly plb: {
    /** `product_tier`s left out of the trace population, as in the C9 lag histograms. */
    readonly excludedProductTiers: readonly string[];
    /** What stands in for `event_updated_at`, which no column records per detection. */
    readonly eventUpdatedProxy: 'first_live_attachment';
  };
  readonly dar: {
    /** Automatic `alert_outbox` rows; `manual` is a human's call, not the rule's. */
    readonly population: 'alert_outbox_automatic';
    /** The instant a repeat is measured from: WP1 shadow mode decides and never sends. */
    readonly instant: 'decided_at';
    /** Alerts this long before the window are read so a repeat across Monday 00:00 counts. */
    readonly leadIn: 'suppression_window';
  };
  readonly openDecisions: readonly OpenDecision[];
}

export const QA_WEEKLY_REPORT: VersionedConfig<QaWeeklyReportParams> = defineConfig(
  'qa_weekly_report',
  'qa_weekly_report_v1',
  {
    week: { calendar: 'iso8601', timeZone: 'UTC', ratified: false },
    plb: { excludedProductTiers: ['SP'], eventUpdatedProxy: 'first_live_attachment' },
    dar: {
      population: 'alert_outbox_automatic',
      instant: 'decided_at',
      leadIn: 'suppression_window',
    },
    openDecisions: [
      {
        id: 'week_boundary',
        question:
          'GLOSSARY §8 says "per calendar week in season" without a week start or a time zone.',
        interim: 'ISO-8601 week, Monday 00:00 UTC to Monday 00:00 UTC.',
      },
      {
        id: 'season_bounds',
        question: 'Which weeks are "in season" for D8? L-12 set season bounds for another use.',
        interim: 'None applied: any closed week is reported; the reader judges the season.',
      },
      {
        id: 'plb_event_updated',
        question:
          'No column records when a detection first changed its event (GLOSSARY §8.1 event_updated_at).',
        interim:
          "The detection's earliest attachment in a live clustering run (event_detections.attached_at).",
      },
      {
        id: 'dar_instant',
        question:
          'DAR divides by alerts "dispatched"; in WP1 shadow mode nothing is dispatched (ADR-004 rollout).',
        interim:
          'Automatic alert_outbox rows by decided_at, the instant the suppression window is applied at.',
      },
      {
        id: 'lifecycle_transition_log',
        question:
          'FER and FLR need the lifecycle transition history; fire_events keeps only the current status.',
        interim: 'FER and FLR are reported unavailable.',
      },
      {
        id: 'effis_perimeter_store',
        question:
          'Shadow-PCR needs EFFIS burnt-area perimeters and per-grid-zone decisions; neither is persisted.',
        interim: 'Shadow-PCR is reported unavailable.',
      },
    ],
  } as const,
);
