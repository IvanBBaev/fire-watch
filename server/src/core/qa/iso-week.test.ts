import { describe, expect, it } from 'vitest';

import {
  DAY_MS,
  isoWeekOf,
  isoWeeksInYear,
  isoWeekWindow,
  lastClosedIsoWeek,
  utcDayRangeWindow,
  utcDayStart,
  WEEK_MS,
} from './iso-week.js';

describe('isoWeekWindow', () => {
  it('opens on Monday 00:00 UTC and spans exactly seven days', () => {
    const week = isoWeekWindow('2026-W38');
    expect(new Date(week.fromMs).toISOString()).toBe('2026-09-14T00:00:00.000Z');
    expect(new Date(week.toMs).toISOString()).toBe('2026-09-21T00:00:00.000Z');
    expect(week.toMs - week.fromMs).toBe(WEEK_MS);
    expect(week.isoWeek).toBe('2026-W38');
  });

  it('puts week 1 around 4 January, across the calendar-year boundary', () => {
    // 2026-01-01 is a Thursday, so week 1 of 2026 starts Monday 2025-12-29.
    expect(new Date(isoWeekWindow('2026-W01').fromMs).toISOString()).toBe(
      '2025-12-29T00:00:00.000Z',
    );
    // 2021-01-01 is a Friday: it belongs to 2020-W53, and 2021-W01 starts on 4 January.
    expect(new Date(isoWeekWindow('2021-W01').fromMs).toISOString()).toBe(
      '2021-01-04T00:00:00.000Z',
    );
  });

  it('knows which years have 53 weeks', () => {
    expect(isoWeeksInYear(2020)).toBe(53);
    expect(isoWeeksInYear(2026)).toBe(53);
    expect(isoWeeksInYear(2025)).toBe(52);
    expect(isoWeeksInYear(2027)).toBe(52);
    expect(() => isoWeekWindow('2027-W53')).toThrow(RangeError);
    expect(isoWeekWindow('2026-W53').isoWeek).toBe('2026-W53');
  });

  it.each(['2026-W00', '2026-W54', '2026W38', '2026-w38', '2026-W8', '1969-W10', ''])(
    'refuses %j',
    (label) => {
      expect(() => isoWeekWindow(label)).toThrow(RangeError);
    },
  );
});

describe('isoWeekOf', () => {
  it('labels instants at and around the week boundaries', () => {
    const week = isoWeekWindow('2026-W38');
    expect(isoWeekOf(week.fromMs)).toBe('2026-W38');
    expect(isoWeekOf(week.toMs - 1)).toBe('2026-W38');
    expect(isoWeekOf(week.fromMs - 1)).toBe('2026-W37');
    expect(isoWeekOf(week.toMs)).toBe('2026-W39');
  });

  it('assigns early-January and late-December days to the ISO year', () => {
    expect(isoWeekOf(Date.UTC(2021, 0, 1))).toBe('2020-W53');
    expect(isoWeekOf(Date.UTC(2025, 11, 30))).toBe('2026-W01');
    expect(isoWeekOf(Date.UTC(2027, 0, 3))).toBe('2026-W53');
  });

  it('round-trips every week of a range of years', () => {
    for (let year = 2019; year <= 2031; year += 1) {
      for (let week = 1; week <= isoWeeksInYear(year); week += 1) {
        const label = `${String(year)}-W${String(week).padStart(2, '0')}`;
        const window = isoWeekWindow(label);
        expect(isoWeekOf(window.fromMs)).toBe(label);
        expect(isoWeekOf(window.toMs - 1)).toBe(label);
      }
    }
  });

  it('refuses a non-finite instant', () => {
    expect(() => isoWeekOf(Number.NaN)).toThrow(RangeError);
  });
});

describe('lastClosedIsoWeek', () => {
  it('is the week before the one holding now', () => {
    expect(lastClosedIsoWeek(Date.parse('2026-09-23T12:00:00Z')).isoWeek).toBe('2026-W38');
  });

  it('turns over exactly at Monday 00:00 UTC', () => {
    const monday = isoWeekWindow('2026-W39').fromMs;
    expect(lastClosedIsoWeek(monday - 1).isoWeek).toBe('2026-W37');
    expect(lastClosedIsoWeek(monday).isoWeek).toBe('2026-W38');
  });
});

describe('utcDayRangeWindow', () => {
  it('is half-open over inclusive days', () => {
    const window = utcDayRangeWindow('2026-09-01', '2026-09-10');
    expect(window.fromMs).toBe(Date.UTC(2026, 8, 1));
    expect(window.toMs).toBe(Date.UTC(2026, 8, 11));
    expect(window.isoWeek).toBeNull();
  });

  it('carries the ISO week label when the range is exactly one', () => {
    expect(utcDayRangeWindow('2026-09-14', '2026-09-20').isoWeek).toBe('2026-W38');
    expect(utcDayRangeWindow('2026-09-15', '2026-09-21').isoWeek).toBeNull();
  });

  it('accepts a single day and refuses a reversed range', () => {
    const single = utcDayRangeWindow('2026-09-14', '2026-09-14');
    expect(single.toMs - single.fromMs).toBe(DAY_MS);
    expect(() => utcDayRangeWindow('2026-09-14', '2026-09-13')).toThrow(RangeError);
  });
});

describe('utcDayStart', () => {
  it.each(['2026-02-30', '2026-13-01', '2026-9-14', '1969-12-31', 'yesterday'])(
    'refuses %j',
    (day) => {
      expect(() => utcDayStart(day)).toThrow(RangeError);
    },
  );

  it('accepts a leap day', () => {
    expect(utcDayStart('2028-02-29')).toBe(Date.UTC(2028, 1, 29));
  });
});
