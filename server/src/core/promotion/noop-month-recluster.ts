/**
 * The documented no-op behind the A1.4 step-4 hook (TASKS C7): until the D-track
 * clustering engine exists there is nothing to re-cluster — the backfill months have no
 * `event_detections` rows to reconcile — and answering `skipped_no_engine` out loud
 * keeps the run summary honest about which half of the promotion actually ran. The
 * D-track replaces this constant with a real `MonthRecluster`; the promotion run does
 * not change.
 */

import type { MonthRecluster, MonthReclusterResult } from '../ports/month-recluster.js';

export const noopMonthRecluster: MonthRecluster = {
  reclusterMonth(): Promise<MonthReclusterResult> {
    return Promise.resolve({ status: 'skipped_no_engine' });
  },
};
