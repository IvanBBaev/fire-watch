/**
 * The month, as D7 swaps it (ADR-002 D7 as amended by A1.4; TASKS C7).
 *
 * Promotion is whole-month, never row-level: the unit that is staged, checked and
 * swapped is one partition of `detections`, and everything about it — the half-open UTC
 * interval, the live partition's name, the staging table, the name the detached NRT
 * partition is retained under — derives from the one `YYYY-MM` string the operator
 * typed. Deriving all of it here, once, is what keeps "which table did we just detach"
 * a function of the input rather than of whichever adapter ran first.
 *
 * The names follow migration 001's `detections_YYYY_MM` partition naming; the suffixes
 * keep every derived name well under Postgres's 63-byte identifier limit.
 */

import { epochMsFromIso } from '../ports/clock.js';

export interface MonthWindow {
  /** `YYYY-MM`, validated. */
  readonly month: string;
  /** First instant of the month, inclusive — `YYYY-MM-01T00:00:00Z`. */
  readonly startIso: string;
  /** First instant of the next month, exclusive — the partition-bound convention. */
  readonly endIso: string;
  readonly startMs: number;
  readonly endMs: number;
  /** `detections_YYYY_MM` — the live partition, exactly as migration 001 named it. */
  readonly livePartition: string;
  /** Where the month's SP rows are staged before the swap. */
  readonly stagingTable: string;
  /**
   * What the detached NRT partition is renamed to. Retained, never dropped (A1.4 step
   * 3): it is the append-only archive's evidence for every alert that was sent from it.
   */
  readonly retiredTable: string;
}

const MONTH_RE = /^(\d{4})-(0[1-9]|1[0-2])$/;

export function monthWindow(month: string): MonthWindow {
  const match = MONTH_RE.exec(month);
  const yearText = match?.[1];
  const monthText = match?.[2];
  if (yearText === undefined || monthText === undefined) {
    throw new RangeError(`month must be YYYY-MM (01–12), got ${JSON.stringify(month)}`);
  }

  const year = Number(yearText);
  const monthNumber = Number(monthText);
  const nextYear = monthNumber === 12 ? year + 1 : year;
  const nextMonth = monthNumber === 12 ? 1 : monthNumber + 1;

  const startIso = `${month}-01T00:00:00Z`;
  const endIso = `${String(nextYear)}-${String(nextMonth).padStart(2, '0')}-01T00:00:00Z`;
  const suffix = `${yearText}_${monthText}`;

  return {
    month,
    startIso,
    endIso,
    startMs: epochMsFromIso(startIso),
    endMs: epochMsFromIso(endIso),
    livePartition: `detections_${suffix}`,
    stagingTable: `detections_${suffix}_sp_staging`,
    retiredTable: `detections_${suffix}_nrt_retired`,
  };
}
