import { describe, expect, it } from 'vitest';

import { wholeDaysBetween } from './time.js';

describe('wholeDaysBetween', () => {
  const base = Date.parse('2026-08-09T12:00:00Z');

  it('counts exact whole days', () => {
    expect(wholeDaysBetween(base, '2026-08-06T12:00:00Z')).toBe(3);
  });

  it('floors partial days', () => {
    expect(wholeDaysBetween(base, '2026-08-06T13:00:00Z')).toBe(2);
    expect(wholeDaysBetween(base, '2026-08-09T00:00:00Z')).toBe(0);
  });

  it('never goes negative for future instants', () => {
    expect(wholeDaysBetween(base, '2026-08-10T12:00:00Z')).toBe(0);
  });

  it('answers 0 for unparseable input instead of NaN', () => {
    expect(wholeDaysBetween(base, 'not-a-date')).toBe(0);
  });
});
