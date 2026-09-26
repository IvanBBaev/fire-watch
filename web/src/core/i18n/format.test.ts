import { describe, expect, it } from 'vitest';

import {
  formatDateSofia,
  formatDateTimeSofia,
  formatNumber,
  formatObservedStampSofia,
  formatShortDateTimeSofia,
  formatTimeSofia,
  minutesAgoFrom,
  relativeAgeFrom,
  roundToTwoSignificantFigures,
} from './format.js';

// Two fixed instants pin both Bulgarian UTC offsets: EEST (UTC+3, summer) and EET
// (UTC+2, winter). 12:00Z is 15:00 and 14:00 in Sofia respectively.
const SUMMER_NOON_UTC = '2026-08-09T12:00:00Z';
const WINTER_NOON_UTC = '2026-01-15T12:00:00Z';
// 22:00Z in winter is 00:00 in Sofia — the midnight case that separates h23 from h24.
const WINTER_MIDNIGHT_EDGE_UTC = '2026-01-15T22:00:00Z';

describe('formatTimeSofia', () => {
  it('renders EEST (summer, UTC+3) instants in Sofia local time', () => {
    expect(formatTimeSofia(SUMMER_NOON_UTC, 'bg')).toBe('15:00');
    expect(formatTimeSofia(SUMMER_NOON_UTC, 'en')).toBe('15:00');
  });

  it('renders EET (winter, UTC+2) instants in Sofia local time', () => {
    expect(formatTimeSofia(WINTER_NOON_UTC, 'bg')).toBe('14:00');
    expect(formatTimeSofia(WINTER_NOON_UTC, 'en')).toBe('14:00');
  });

  it('is 24-hour and renders midnight as 00:00, never 24:00 or 12:00 AM', () => {
    expect(formatTimeSofia(WINTER_MIDNIGHT_EDGE_UTC, 'bg')).toBe('00:00');
    expect(formatTimeSofia(WINTER_MIDNIGHT_EDGE_UTC, 'en')).toBe('00:00');
  });

  it('renders afternoon hours without AM/PM in both locales', () => {
    const summerEvening = formatTimeSofia('2026-08-09T18:30:00Z', 'en'); // 21:30 Sofia
    expect(summerEvening).toBe('21:30');
  });
});

describe('formatDateSofia', () => {
  it('renders the Sofia-local calendar date', () => {
    // 2026-08-09T22:30Z is already 2026-08-10 in Sofia (UTC+3).
    expect(formatDateSofia('2026-08-09T22:30:00Z', 'bg')).toContain('10.08.2026');
    expect(formatDateSofia('2026-08-09T22:30:00Z', 'en')).toContain('10/08/2026');
  });
});

describe('formatDateTimeSofia', () => {
  it('carries both the Sofia date and the 24-hour Sofia time', () => {
    const bg = formatDateTimeSofia(SUMMER_NOON_UTC, 'bg');
    expect(bg).toContain('09.08.2026');
    expect(bg).toContain('15:00');

    const en = formatDateTimeSofia(WINTER_NOON_UTC, 'en');
    expect(en).toContain('15/01/2026');
    expect(en).toContain('14:00');
  });
});

describe('minutesAgoFrom', () => {
  const observedMs = Date.parse(SUMMER_NOON_UTC);

  it('returns whole minutes, floored', () => {
    expect(minutesAgoFrom(observedMs + 5 * 60_000 + 59_999, SUMMER_NOON_UTC)).toBe(5);
    expect(minutesAgoFrom(observedMs + 90_000, SUMMER_NOON_UTC)).toBe(1);
  });

  it('returns 0 at the observation instant', () => {
    expect(minutesAgoFrom(observedMs, SUMMER_NOON_UTC)).toBe(0);
  });

  it('clamps to 0 when the observation is in the future of server time', () => {
    expect(minutesAgoFrom(observedMs - 10 * 60_000, SUMMER_NOON_UTC)).toBe(0);
  });

  it('returns 0 for an unparseable timestamp instead of NaN', () => {
    expect(minutesAgoFrom(observedMs, 'not-a-timestamp')).toBe(0);
  });
});

describe('relativeAgeFrom', () => {
  const observedMs = Date.parse(SUMMER_NOON_UTC);
  const after = (minutes: number) =>
    relativeAgeFrom(observedMs + minutes * 60_000, SUMMER_NOON_UTC);

  it('answers "now" under a minute rather than a zero count', () => {
    expect(after(0)).toEqual({ unit: 'now' });
    expect(after(0.9)).toEqual({ unit: 'now' });
  });

  it('stays in minutes for the first hour, switching exactly at 60', () => {
    expect(after(1)).toEqual({ unit: 'minutes', minutes: 1 });
    expect(after(59)).toEqual({ unit: 'minutes', minutes: 59 });
    expect(after(60)).toEqual({ unit: 'hours', hours: 1, minutes: 0 });
  });

  it('keeps the minute remainder in the hours case', () => {
    expect(after(6 * 60 + 43)).toEqual({ unit: 'hours', hours: 6, minutes: 43 });
    expect(after(23 * 60 + 59)).toEqual({ unit: 'hours', hours: 23, minutes: 59 });
  });

  it('keeps hours and minutes in the days case — 19 103 min is 13 d 6 h 23 min', () => {
    expect(after(19_103)).toEqual({ unit: 'days', days: 13, hours: 6, minutes: 23 });
    expect(after(24 * 60)).toEqual({ unit: 'days', days: 1, hours: 0, minutes: 0 });
  });

  it('clamps a future observation to "now" instead of a negative age', () => {
    expect(after(-120)).toEqual({ unit: 'now' });
  });
});

describe('formatObservedStampSofia', () => {
  // 2026-08-09 15:00 Sofia; "now" values below are all Sofia-local by construction.
  const observed = SUMMER_NOON_UTC;

  it('shows the bare time while the observation is still on the same Sofia date', () => {
    const laterSameDay = Date.parse('2026-08-09T20:30:00Z'); // 23:30 Sofia, same date
    expect(formatObservedStampSofia(observed, laterSameDay, 'bg')).toBe('15:00');
  });

  it('adds day and month once the Sofia date differs, without the year', () => {
    const nextWeek = Date.parse('2026-08-16T09:00:00Z');
    const rendered = formatObservedStampSofia(observed, nextWeek, 'bg');
    expect(rendered).toBe(formatShortDateTimeSofia(observed, 'bg'));
    expect(rendered).toContain('09.08');
    expect(rendered).toContain('15:00');
    expect(rendered).not.toContain('2026');
  });

  it('falls back to the full date once the year differs', () => {
    const nextYear = Date.parse('2027-02-01T09:00:00Z');
    expect(formatObservedStampSofia(observed, nextYear, 'en')).toBe(
      formatDateTimeSofia(observed, 'en'),
    );
  });

  it('adds no failure mode of its own for an unparseable input', () => {
    // Every formatter in this module rejects garbage the same way; the stamp must not
    // quietly invent a time to paper over it.
    const nowMs = Date.parse(SUMMER_NOON_UTC);
    expect(() => formatObservedStampSofia('not-a-timestamp', nowMs, 'bg')).toThrow(RangeError);
    expect(() => formatDateTimeSofia('not-a-timestamp', 'bg')).toThrow(RangeError);
  });
});

describe('formatNumber', () => {
  it('groups with the locale convention', () => {
    expect(formatNumber(1_234_567, 'en')).toBe('1,234,567');
    // Bulgarian groups with a non-breaking space.
    expect(formatNumber(1_234_567, 'bg')).toBe('1\u00a0234\u00a0567');
  });

  it('documents the Bulgarian minimum-two-grouping-digits convention', () => {
    // CLDR bg only groups from five integer digits up; 3200 stays solid.
    expect(formatNumber(3_200, 'bg')).toBe('3200');
    expect(formatNumber(32_000, 'bg')).toBe('32\u00a0000');
  });
});

describe('roundToTwoSignificantFigures', () => {
  it('rounds to two significant figures across magnitudes', () => {
    expect(roundToTwoSignificantFigures(3_247)).toBe(3_200);
    expect(roundToTwoSignificantFigures(987)).toBe(990);
    expect(roundToTwoSignificantFigures(15.4)).toBe(15);
    expect(roundToTwoSignificantFigures(0.037)).toBe(0.037);
  });

  it('passes zero through unchanged', () => {
    expect(roundToTwoSignificantFigures(0)).toBe(0);
  });
});
