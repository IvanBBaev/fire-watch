/**
 * The worded elapsed time, per locale. The regression this guards is concrete: the UI
 * used to render a raw minute count, so a fixture two weeks old said "(преди 19103 мин)".
 * Nothing here may render a bare minute count above an hour.
 */

import { describe, expect, it } from 'vitest';

import bg from './bg.js';
import en from './en.js';
import type { RelativeAge } from './format.js';

const cases: readonly (readonly [string, RelativeAge, string, string])[] = [
  ['under a minute', { unit: 'now' }, 'току-що', 'just now'],
  ['minutes', { unit: 'minutes', minutes: 43 }, 'преди 43 мин', '43 min ago'],
  ['whole hours', { unit: 'hours', hours: 6, minutes: 0 }, 'преди 6 ч', '6 h ago'],
  [
    'hours and minutes',
    { unit: 'hours', hours: 6, minutes: 23 },
    'преди 6 ч и 23 мин',
    '6 h 23 min ago',
  ],
  // Past a day the minutes are dropped: they are below the resolution anyone acts on.
  [
    'days and hours — minutes dropped',
    { unit: 'days', days: 13, hours: 6, minutes: 23 },
    'преди 13 дни и 6 ч',
    '13 days 6 h ago',
  ],
  ['whole days', { unit: 'days', days: 13, hours: 0, minutes: 0 }, 'преди 13 дни', '13 days ago'],
  [
    'days with only minutes left over',
    { unit: 'days', days: 2, hours: 0, minutes: 5 },
    'преди 2 дни',
    '2 days ago',
  ],
  ['exactly one day', { unit: 'days', days: 1, hours: 0, minutes: 0 }, 'преди 1 ден', '1 day ago'],
];

describe.each(cases)('relativeAge — %s', (_label, age, expectedBg, expectedEn) => {
  it('renders the Bulgarian wording', () => {
    expect(bg.relativeAge(age)).toBe(expectedBg);
  });

  it('renders the English wording', () => {
    expect(en.relativeAge(age)).toBe(expectedEn);
  });
});

describe('the raw-minute-count regression', () => {
  it('never renders a bare minute count for an age past an hour', () => {
    const twoWeeks: RelativeAge = { unit: 'days', days: 13, hours: 6, minutes: 23 };
    for (const rendered of [bg.relativeAge(twoWeeks), en.relativeAge(twoWeeks)]) {
      expect(rendered).not.toContain('19103');
      expect(rendered).not.toContain('19 103');
    }
  });
});
