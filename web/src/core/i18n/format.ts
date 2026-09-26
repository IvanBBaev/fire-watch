/**
 * Intl formatting helpers for the one timezone the product speaks in: Europe/Sofia.
 *
 * Every visible timestamp is satellite observation time (07-product-ux P1); these helpers
 * only *render* instants the caller already holds. Nothing here reads the wall clock —
 * "now" is always a parameter derived from `serverNow()` (core/ports.ts), which is what
 * keeps ages honest under client clock skew and keeps every function replayable in tests.
 */

import type { Locale } from '../types.js';

const SOFIA_TIME_ZONE = 'Europe/Sofia';

/**
 * BCP-47 tags per product locale. English uses `en-GB` so dates render day-first, which
 * matches how the Bulgarian audience reads them; times are 24-hour in both locales.
 */
const LOCALE_TAG: Readonly<Record<Locale, string>> = {
  bg: 'bg-BG',
  en: 'en-GB',
};

const TIME_OPTIONS: Intl.DateTimeFormatOptions = {
  hour: '2-digit',
  minute: '2-digit',
  // `h23` rather than `hour12: false`: it pins midnight to "00:00" (never "24:00").
  hourCycle: 'h23',
  timeZone: SOFIA_TIME_ZONE,
};

const DATE_OPTIONS: Intl.DateTimeFormatOptions = {
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  timeZone: SOFIA_TIME_ZONE,
};

const DATE_TIME_OPTIONS: Intl.DateTimeFormatOptions = { ...DATE_OPTIONS, ...TIME_OPTIONS };

/** Day and month without the year — the compact stamp list rows use inside one year. */
const SHORT_DATE_TIME_OPTIONS: Intl.DateTimeFormatOptions = {
  day: '2-digit',
  month: '2-digit',
  ...TIME_OPTIONS,
};

/** `Intl.DateTimeFormat` construction is expensive; instances are cached per locale+kind. */
const dateTimeFormatters = new Map<string, Intl.DateTimeFormat>();

function dateTimeFormatter(
  locale: Locale,
  kind: 'time' | 'date' | 'dateTime' | 'shortDateTime' | 'year',
  options: Intl.DateTimeFormatOptions,
): Intl.DateTimeFormat {
  const key = `${locale}:${kind}`;
  let formatter = dateTimeFormatters.get(key);
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat(LOCALE_TAG[locale], options);
    dateTimeFormatters.set(key, formatter);
  }
  return formatter;
}

const numberFormatters = new Map<Locale, Intl.NumberFormat>();

function numberFormatter(locale: Locale): Intl.NumberFormat {
  let formatter = numberFormatters.get(locale);
  if (formatter === undefined) {
    formatter = new Intl.NumberFormat(LOCALE_TAG[locale]);
    numberFormatters.set(locale, formatter);
  }
  return formatter;
}

/** "HH:MM" (24-hour) in Europe/Sofia — the shape every §3/§3b template expects. */
export function formatTimeSofia(iso: string, locale: Locale): string {
  return dateTimeFormatter(locale, 'time', TIME_OPTIONS).format(new Date(iso));
}

/** Numeric date in Europe/Sofia, locale-idiomatic (bg: "09.08.2026 г.", en: "09/08/2026"). */
export function formatDateSofia(iso: string, locale: Locale): string {
  return dateTimeFormatter(locale, 'date', DATE_OPTIONS).format(new Date(iso));
}

/** Date and 24-hour time in Europe/Sofia — for the `<date HH:MM>` template slots. */
export function formatDateTimeSofia(iso: string, locale: Locale): string {
  return dateTimeFormatter(locale, 'dateTime', DATE_TIME_OPTIONS).format(new Date(iso));
}

/**
 * Whole minutes between a server-time "now" (epoch ms, from `serverNow()`) and an
 * observation instant. Clamped to zero: an observation "in the future" is clock skew or
 * a garbage timestamp, and a negative age must never render.
 */
export function minutesAgoFrom(nowMs: number, iso: string): number {
  const observedMs = new Date(iso).getTime();
  if (!Number.isFinite(observedMs)) return 0;
  return Math.max(0, Math.floor((nowMs - observedMs) / 60_000));
}

/**
 * An elapsed span broken into the largest unit worth saying out loud. Copy that renders
 * a raw minute count is only honest for the first hour: "19 028 min ago" is technically
 * true and practically unreadable, and events legitimately persist for days
 * (`officially_contained`, `archived`). The catalogs turn this into words — the split
 * itself carries no language, which is what keeps the thresholds testable once instead
 * of once per locale.
 *
 * Every case carries its full remainder — the split stays lossless so the decision about
 * what is worth saying belongs to the copy, not to the arithmetic. The catalogs drop what
 * is below the resolution a reader acts on (zero components everywhere, and the minutes
 * once the age is measured in days).
 */
export type RelativeAge =
  | { readonly unit: 'now' }
  | { readonly unit: 'minutes'; readonly minutes: number }
  | { readonly unit: 'hours'; readonly hours: number; readonly minutes: number }
  | {
      readonly unit: 'days';
      readonly days: number;
      readonly hours: number;
      readonly minutes: number;
    };

const MINUTES_PER_HOUR = 60;
const HOURS_PER_DAY = 24;

/**
 * Elapsed time from an observation to a server-time "now", floored per unit and clamped
 * at zero for the same reason {@link minutesAgoFrom} clamps: a future observation is
 * skew or garbage, never a negative age. Under a minute answers `now` rather than
 * "0 min", which reads as a stuck clock.
 */
export function relativeAgeFrom(nowMs: number, iso: string): RelativeAge {
  const totalMinutes = minutesAgoFrom(nowMs, iso);
  if (totalMinutes < 1) return { unit: 'now' };
  if (totalMinutes < MINUTES_PER_HOUR) return { unit: 'minutes', minutes: totalMinutes };

  const minutes = totalMinutes % MINUTES_PER_HOUR;
  const totalHours = Math.floor(totalMinutes / MINUTES_PER_HOUR);
  if (totalHours < HOURS_PER_DAY) {
    return { unit: 'hours', hours: totalHours, minutes };
  }
  return {
    unit: 'days',
    days: Math.floor(totalHours / HOURS_PER_DAY),
    hours: totalHours % HOURS_PER_DAY,
    minutes,
  };
}

/** Day and month, no year, in Europe/Sofia (bg: "09.08, 14:14", en: "09/08, 14:14"). */
export function formatShortDateTimeSofia(iso: string, locale: Locale): string {
  return dateTimeFormatter(locale, 'shortDateTime', SHORT_DATE_TIME_OPTIONS).format(new Date(iso));
}

function sofiaDate(date: Date, locale: Locale): string {
  return dateTimeFormatter(locale, 'date', DATE_OPTIONS).format(date);
}

function sofiaYear(date: Date, locale: Locale): string {
  return dateTimeFormatter(locale, 'year', { year: 'numeric', timeZone: SOFIA_TIME_ZONE }).format(
    date,
  );
}

/**
 * The timestamp a compact row shows next to a relative age: bare time while the
 * observation is still on today's Sofia date, day+month once it is not, and the full
 * date once the year differs. A bare "12:47" on a thirteen-day-old event is ambiguous —
 * the age says how long ago, the stamp must say *when*, and the two must not disagree.
 */
export function formatObservedStampSofia(iso: string, nowMs: number, locale: Locale): string {
  const observed = new Date(iso);
  const now = new Date(nowMs);
  // An unparseable input cannot be compared against today, so it falls through to the
  // full-date formatter and fails exactly the way every other formatter in this module
  // fails on garbage — no new failure mode, and no invented timestamp either.
  if (!Number.isFinite(observed.getTime()) || !Number.isFinite(now.getTime())) {
    return formatDateTimeSofia(iso, locale);
  }

  if (sofiaDate(observed, locale) === sofiaDate(now, locale)) {
    return formatTimeSofia(iso, locale);
  }
  if (sofiaYear(observed, locale) === sofiaYear(now, locale)) {
    return formatShortDateTimeSofia(iso, locale);
  }
  return formatDateTimeSofia(iso, locale);
}

/** Locale-grouped integer/decimal rendering (bg groups with NBSP, en with commas). */
export function formatNumber(value: number, locale: Locale): string {
  return numberFormatter(locale).format(value);
}

/**
 * Two significant figures, per the both-units rule (GLOSSARY §5.2): areas are rounded to
 * two significant figures and prefixed `~` wherever they render. Display rounding only —
 * never an identity or hash input.
 */
export function roundToTwoSignificantFigures(value: number): number {
  if (!Number.isFinite(value) || value === 0) return value;
  return Number(value.toPrecision(2));
}
