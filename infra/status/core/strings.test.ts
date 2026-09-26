import { describe, expect, it } from 'vitest';

import { BUDGETED_JOB_IDS, MONITORED_FEED_IDS } from '../../../packages/contracts/src/freshness.js';
import { lintAlertText } from '../../../packages/contracts/src/never-send.js';

import { COMPONENT_IDS, COMPONENT_LEVELS, REASON_CODES, SOURCE_LEVELS } from './status-model.js';
import {
  CATALOG,
  COPY_REVIEW_STATE,
  LOCALES,
  flattenMessages,
  format,
  sourceLabel,
} from './strings.js';

const placeholders = (text: string): string[] =>
  [...text.matchAll(/\{([a-z]+)\}/g)].map((m) => m[1] ?? '').sort();

describe('catalog', () => {
  it('is marked as pending founder review', () => {
    expect(COPY_REVIEW_STATE).toBe('pending-founder-review');
  });

  it('has the same keys and the same placeholders in both languages', () => {
    const en = flattenMessages(CATALOG.en);
    const bg = flattenMessages(CATALOG.bg);
    expect([...bg.keys()].sort()).toEqual([...en.keys()].sort());
    for (const [key, text] of en) {
      expect(placeholders(bg.get(key) ?? ''), key).toEqual(placeholders(text));
    }
  });

  it('has no empty message', () => {
    for (const locale of LOCALES) {
      for (const [key, text] of flattenMessages(CATALOG[locale])) {
        expect(text.trim().length, `${locale}.${key}`).toBeGreaterThan(0);
      }
    }
  });

  it('covers every model code and every contract freshness row', () => {
    for (const locale of LOCALES) {
      const m = CATALOG[locale];
      expect(Object.keys(m.level).sort()).toEqual([...COMPONENT_LEVELS].sort());
      expect(Object.keys(m.overall).sort()).toEqual([...COMPONENT_LEVELS].sort());
      expect(Object.keys(m.component).sort()).toEqual([...COMPONENT_IDS].sort());
      expect(Object.keys(m.reason).sort()).toEqual([...REASON_CODES].sort());
      expect(Object.keys(m.sourceLevel).sort()).toEqual([...SOURCE_LEVELS].sort());
      expect(Object.keys(m.source).sort()).toEqual(
        [...MONITORED_FEED_IDS, ...BUDGETED_JOB_IDS].sort(),
      );
    }
  });

  // OPERATIONS §10.4: the never-send list applies to the status page verbatim.
  it.each(LOCALES)('passes the never-send lint in own voice (%s)', (locale) => {
    for (const [key, text] of flattenMessages(CATALOG[locale])) {
      const filled = format(text, {
        time: '2026-09-25 12:00 UTC',
        age: '5 min',
        n: '5',
        m: '0',
        minutes: '45',
        channel: '@status',
      });
      expect(lintAlertText(filled, { voice: 'own' }), `${locale}.${key}`).toEqual([]);
    }
  });

  it('never names a transport tier or vendor', () => {
    for (const locale of LOCALES) {
      for (const [key, text] of flattenMessages(CATALOG[locale])) {
        expect(text, `${locale}.${key}`).not.toMatch(
          /\b(R2|T[0-9]|Cloudflare|Hetzner|GitHub|AWS|SES)\b/,
        );
      }
    }
  });
});

describe('format', () => {
  it('fills known placeholders and leaves unknown ones visible', () => {
    expect(format('{a} and {b}', { a: 'x' })).toBe('x and {b}');
  });
});

describe('sourceLabel', () => {
  it('names a known row and shows an unknown one by its id', () => {
    expect(sourceLabel(CATALOG.en, 'eumetsat:clm')).toBe('Cloud mask');
    expect(sourceLabel(CATALOG.en, 'future:feed')).toBe('future:feed');
    expect(sourceLabel(CATALOG.en, 'toString')).toBe('toString');
  });
});
