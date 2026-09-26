/**
 * The weekly QA report's week (TASKS D8; GLOSSARY §8).
 *
 * GLOSSARY §8 and 06 §5.1.2 say only "per calendar week in season". Neither names the week
 * start nor the time zone, and H8 left "UTC day vs Sofia day" open. Until the founder rules,
 * the report uses **ISO-8601 weeks (Monday 00:00 to Monday 00:00) in UTC**, and every report
 * says so, with `ratified: false` (`weekly-report-params.ts`). UTC was picked because every
 * instant the pipeline stores is UTC and a UTC week has exactly 7 × 24 h in every season;
 * a Europe/Sofia week would have 167 h or 169 h twice a year, and the D8 report would be
 * the only artifact in the repository that has to know about DST.
 *
 * Pure date arithmetic on epoch milliseconds through `Date.UTC` and the `getUTC*` family:
 * nothing here reads the host's zone, so `TZ=Pacific/Kiritimati` changes no output.
 */

import type { EpochMs } from '../ports/clock.js';

export const DAY_MS = 86_400_000;
export const WEEK_MS = 7 * DAY_MS;

const ISO_WEEK_RE = /^(\d{4})-W(\d{2})$/;
const UTC_DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** A half-open report window `[fromMs, toMs)`, UTC. */
export interface ReportWindow {
  /** `YYYY-Www` when the window is exactly one ISO week, otherwise `null` (an ad-hoc range). */
  readonly isoWeek: string | null;
  readonly fromMs: EpochMs;
  readonly toMs: EpochMs;
}

/** Monday 00:00 UTC of ISO week 1 of `year` — the week that holds 4 January. */
function mondayOfWeekOne(year: number): EpochMs {
  const jan4 = Date.UTC(year, 0, 4);
  // getUTCDay: Sunday 0 … Saturday 6; days since Monday is (day + 6) % 7.
  const sinceMonday = (new Date(jan4).getUTCDay() + 6) % 7;
  return jan4 - sinceMonday * DAY_MS;
}

export function isoWeeksInYear(year: number): number {
  return (mondayOfWeekOne(year + 1) - mondayOfWeekOne(year)) / WEEK_MS;
}

/** Parses `YYYY-Www` into its window. Throws `RangeError` on anything else. */
export function isoWeekWindow(label: string): ReportWindow {
  const match = ISO_WEEK_RE.exec(label);
  if (match === null) {
    throw new RangeError(`week must look like 2026-W38, got ${JSON.stringify(label)}`);
  }
  const year = Number(match[1]);
  const week = Number(match[2]);
  // `Date.UTC` maps years 0–99 onto 1900–1999; nothing this project reports predates 1970.
  if (year < 1970) throw new RangeError(`${label}: year must be 1970 or later`);
  if (week < 1 || week > isoWeeksInYear(year)) {
    throw new RangeError(
      `${label}: ISO year ${String(year)} has weeks 1–${String(isoWeeksInYear(year))}`,
    );
  }
  const fromMs = mondayOfWeekOne(year) + (week - 1) * WEEK_MS;
  return Object.freeze({ isoWeek: label, fromMs, toMs: fromMs + WEEK_MS });
}

/** The ISO week an instant falls in, as `YYYY-Www`. */
export function isoWeekOf(ms: EpochMs): string {
  if (!Number.isFinite(ms)) throw new RangeError(`instant must be finite, got ${String(ms)}`);
  let year = new Date(ms).getUTCFullYear();
  if (ms < mondayOfWeekOne(year)) year -= 1;
  else if (ms >= mondayOfWeekOne(year + 1)) year += 1;
  const week = Math.floor((ms - mondayOfWeekOne(year)) / WEEK_MS) + 1;
  return `${String(year).padStart(4, '0')}-W${String(week).padStart(2, '0')}`;
}

/**
 * The most recent week that has fully ended at `nowMs`. The week holding `nowMs` is still
 * open — its report would be a partial week presented as a whole one.
 */
export function lastClosedIsoWeek(nowMs: EpochMs): ReportWindow {
  const current = isoWeekWindow(isoWeekOf(nowMs));
  return isoWeekWindow(isoWeekOf(current.fromMs - 1));
}

/**
 * An ad-hoc window over inclusive UTC days `fromDay … toDay`. Labelled with its ISO week
 * when it happens to be exactly one, so the same seven days never get two identities.
 */
export function utcDayRangeWindow(fromDay: string, toDay: string): ReportWindow {
  const fromMs = utcDayStart(fromDay);
  const toMs = utcDayStart(toDay) + DAY_MS;
  if (toMs <= fromMs) throw new RangeError(`${toDay} is before ${fromDay}`);
  const week = isoWeekWindow(isoWeekOf(fromMs));
  const isoWeek = week.fromMs === fromMs && week.toMs === toMs ? week.isoWeek : null;
  return Object.freeze({ isoWeek, fromMs, toMs });
}

export function utcDayStart(day: string): EpochMs {
  const match = UTC_DAY_RE.exec(day);
  if (match === null) {
    throw new RangeError(`day must look like 2026-09-14, got ${JSON.stringify(day)}`);
  }
  const [year, month, date] = [Number(match[1]), Number(match[2]), Number(match[3])];
  if (year < 1970) throw new RangeError(`${day}: year must be 1970 or later`);
  const ms = Date.UTC(year, month - 1, date);
  const back = new Date(ms);
  if (
    back.getUTCFullYear() !== year ||
    back.getUTCMonth() !== month - 1 ||
    back.getUTCDate() !== date
  ) {
    throw new RangeError(`${day} is not a calendar day`);
  }
  return ms;
}
