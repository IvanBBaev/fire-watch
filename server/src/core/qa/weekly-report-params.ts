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
  readonly fer: {
    /** Declarations graded are those made in the window shifted back by FER's own window. */
    readonly declarationWindow: 'shifted_by_fer_window';
    /** Merged-away events keep their declarations: the declaration happened. */
    readonly population: 'all_events';
    readonly reattachment: 'first_live_attachment_after_declaration';
  };
  readonly flr: {
    /** Tombstones have no dated merge and keep their last status forever. */
    readonly population: 'not_merged_moved_or_active';
    readonly activeMeans: 'status_active';
  };
  readonly openDecisions: readonly OpenDecision[];
}

export const QA_WEEKLY_REPORT: VersionedConfig<QaWeeklyReportParams> = defineConfig(
  'qa_weekly_report',
  // v2 (2026-09-26): FER and FLR measured from the transition log (migration 020).
  'qa_weekly_report_v2',
  {
    week: { calendar: 'iso8601', timeZone: 'UTC', ratified: false },
    plb: { excludedProductTiers: ['SP'], eventUpdatedProxy: 'first_live_attachment' },
    dar: {
      population: 'alert_outbox_automatic',
      instant: 'decided_at',
      leadIn: 'suppression_window',
    },
    fer: {
      declarationWindow: 'shifted_by_fer_window',
      population: 'all_events',
      reattachment: 'first_live_attachment_after_declaration',
    },
    flr: { population: 'not_merged_moved_or_active', activeMeans: 'status_active' },
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
        id: 'fer_declaration_window',
        question:
          'GLOSSARY §8 counts declarations "in the window", but a report built at the window end ' +
          'cannot yet see a re-attachment up to 72 h later.',
        interim:
          'Each report grades declarations made in its window shifted back by the FER window, so ' +
          'every one had its full window and consecutive weeks grade each exactly once.',
      },
      {
        id: 'flr_tombstones',
        question:
          'A merge sets merged_into with no instant and no status change, so a merged-away event ' +
          'would read as active every week after.',
        interim:
          'Events merged away by the time the report is built are left out of FLR; FER keeps them.',
      },
      {
        id: 'fer_large_fuel',
        question:
          'The large-event class includes peat/landfill fuel, which no live input provides (D10).',
        interim:
          'Judged from hull area and max FRP as recorded at the declaration; fuel counts as no.',
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
