import { describe, expect, it } from 'vitest';

import {
  AGE_WINDOW_IDS,
  AGE_WINDOW_STORAGE_KEY,
  DEFAULT_AGE_WINDOW,
  ageCutoffMs,
  ageWindowHours,
  isWithinCutoff,
  parseAgeWindow,
  partitionByAge,
} from './age-filter.js';

const NOW_MS = Date.parse('2026-08-22T12:00:00Z');
const MS_PER_HOUR = 3_600_000;

function observedHoursAgo(hours: number): { readonly lastObservedAt: string } {
  return { lastObservedAt: new Date(NOW_MS - hours * MS_PER_HOUR).toISOString() };
}

describe('the offered windows', () => {
  it('runs narrowest first and ends unbounded', () => {
    expect([...AGE_WINDOW_IDS]).toEqual(['6h', '24h', '48h', 'all']);
    expect(ageWindowHours('6h')).toBe(6);
    expect(ageWindowHours('24h')).toBe(24);
    expect(ageWindowHours('48h')).toBe(48);
    expect(ageWindowHours('all')).toBeNull();
  });

  it('defaults to a day — long enough to span the gap between passes', () => {
    expect(DEFAULT_AGE_WINDOW).toBe('24h');
    expect(ageWindowHours(DEFAULT_AGE_WINDOW)).toBe(24);
  });

  it('offers nothing shorter than the revisit rate can fill', () => {
    const shortest = Math.min(
      ...AGE_WINDOW_IDS.map((id) => ageWindowHours(id) ?? Number.POSITIVE_INFINITY),
    );
    expect(shortest).toBeGreaterThanOrEqual(6);
  });

  it('pins the storage key — changing it silently forgets everyone’s choice', () => {
    expect(AGE_WINDOW_STORAGE_KEY).toBe('fw.age-window');
  });
});

describe('ageCutoffMs', () => {
  it('subtracts the window from the supplied now, never a real clock', () => {
    expect(ageCutoffMs(NOW_MS, '6h')).toBe(NOW_MS - 6 * MS_PER_HOUR);
    expect(ageCutoffMs(NOW_MS, '48h')).toBe(NOW_MS - 48 * MS_PER_HOUR);
  });

  it('answers null for the unbounded window', () => {
    expect(ageCutoffMs(NOW_MS, 'all')).toBeNull();
  });
});

describe('isWithinCutoff', () => {
  const cutoff = ageCutoffMs(NOW_MS, '24h');

  it('keeps everything when there is no cutoff', () => {
    expect(isWithinCutoff(observedHoursAgo(400), null)).toBe(true);
  });

  it('keeps an observation newer than the cutoff', () => {
    expect(isWithinCutoff(observedHoursAgo(1), cutoff)).toBe(true);
  });

  it('keeps an observation exactly on the cutoff', () => {
    expect(isWithinCutoff(observedHoursAgo(24), cutoff)).toBe(true);
  });

  it('drops an observation older than the cutoff', () => {
    expect(isWithinCutoff(observedHoursAgo(24.5), cutoff)).toBe(false);
  });

  it('keeps a future stamp — clock skew must not hide a live fire', () => {
    expect(isWithinCutoff(observedHoursAgo(-2), cutoff)).toBe(true);
  });

  it('drops an unparseable stamp rather than claim it is recent', () => {
    expect(isWithinCutoff({ lastObservedAt: 'not-a-date' }, cutoff)).toBe(false);
    expect(isWithinCutoff({ lastObservedAt: '' }, cutoff)).toBe(false);
  });
});

describe('partitionByAge', () => {
  const items = [
    { id: 'fresh', ...observedHoursAgo(0.5) },
    { id: 'morning', ...observedHoursAgo(5) },
    { id: 'yesterday', ...observedHoursAgo(20) },
    { id: 'ancient', ...observedHoursAgo(300) },
  ];

  it('counts every row the window leaves out', () => {
    const partition = partitionByAge(items, ageCutoffMs(NOW_MS, '6h'));
    expect(partition.recent.map((item) => item.id)).toEqual(['fresh', 'morning']);
    expect(partition.olderCount).toBe(2);
  });

  it('preserves the caller’s order so a recency sort survives', () => {
    const partition = partitionByAge(items, ageCutoffMs(NOW_MS, '48h'));
    expect(partition.recent.map((item) => item.id)).toEqual(['fresh', 'morning', 'yesterday']);
  });

  it('hides nothing and counts nothing when unbounded', () => {
    const partition = partitionByAge(items, null);
    expect(partition.recent).toHaveLength(items.length);
    expect(partition.olderCount).toBe(0);
  });

  it('reports the whole set as older when nothing survives', () => {
    const partition = partitionByAge([items[3]!], ageCutoffMs(NOW_MS, '6h'));
    expect(partition.recent).toHaveLength(0);
    expect(partition.olderCount).toBe(1);
  });

  it('handles an empty input without inventing a count', () => {
    expect(partitionByAge([], ageCutoffMs(NOW_MS, '6h'))).toEqual({ recent: [], olderCount: 0 });
  });
});

describe('parseAgeWindow', () => {
  it('accepts every offered id', () => {
    for (const id of AGE_WINDOW_IDS) expect(parseAgeWindow(id)).toBe(id);
  });

  it('rejects absent, empty and unknown values', () => {
    expect(parseAgeWindow(null)).toBeNull();
    expect(parseAgeWindow('')).toBeNull();
    expect(parseAgeWindow('12h')).toBeNull();
    expect(parseAgeWindow('ALL')).toBeNull();
    expect(parseAgeWindow('toString')).toBeNull();
  });
});
