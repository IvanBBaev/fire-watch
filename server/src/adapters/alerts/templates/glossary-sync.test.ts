/**
 * CI-11 for alert copy: every `frozen` entry of the alert catalog must be the GLOSSARY
 * string, byte for byte, with its slots standing where the glossary puts its own
 * placeholders (GLOSSARY §3, §3b, §5.2).
 *
 * The slots are mapped onto the glossary's placeholder text (`{time}` → `HH:MM`,
 * `{officialStatus}` → `<contained|extinguished>` …) and the whole sentence is then
 * searched for in the de-markdowned glossary. A paraphrase, a swapped dash or a dropped
 * clause fails here; so does a slot the glossary does not have.
 *
 * Lives beside the adapter rather than in core because it reads `docs/GLOSSARY.md` off
 * disk, and core may not import node builtins.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  ALERT_COPY,
  ALERT_COPY_KEYS,
  ALERT_LOCALES,
  fillCopy,
  type AlertLocale,
} from '../../../core/alerts/templates/alert-copy.js';
import { formatAreaBothUnits } from '../../../core/alerts/templates/alert-templates.js';

const glossary = readFileSync(
  fileURLToPath(new URL('../../../../../docs/GLOSSARY.md', import.meta.url)),
  'utf8',
)
  // The same de-markdowning as the web's CI-11, so both compare against one text.
  .replaceAll('**', '')
  .replaceAll('\\<', '<')
  .replaceAll('\\>', '>')
  .replaceAll('\\|', '|');

/** Each slot a frozen entry may carry, as the glossary writes that placeholder. */
const GLOSSARY_PLACEHOLDERS: Readonly<Record<string, Readonly<Record<AlertLocale, string>>>> = {
  time: { en: 'HH:MM', bg: 'HH:MM' },
  detectedAt: { en: '<date HH:MM>', bg: '<дата HH:MM>' },
  officialStatus: { en: '<contained|extinguished>', bg: '<локализиран|ликвидиран>' },
  statementDate: { en: '<date>', bg: '<дата>' },
  source: { en: 'source', bg: 'източник' },
};

function slotsOf(text: string): string[] {
  return [...text.matchAll(/\{([a-zA-Z]+)\}/gu)].map((match) => match[1] ?? '');
}

const FROZEN_KEYS = ALERT_COPY_KEYS.filter((key) => ALERT_COPY[key].governance === 'frozen');

describe('CI-11 — frozen alert copy matches GLOSSARY', () => {
  it('has frozen entries to check', () => {
    expect(FROZEN_KEYS).toEqual([
      'frozen.active',
      'frozen.officialThenRedetected',
      'frozen.officialStatus.contained',
      'frozen.officialStatus.extinguished',
      'frozen.safetyNoTravel',
      'frozen.agriBurnTag',
    ]);
  });

  const sentences = FROZEN_KEYS.filter((key) => !key.startsWith('frozen.officialStatus.'));
  const cases = sentences.flatMap((key) => ALERT_LOCALES.map((locale) => [key, locale] as const));

  it.each(cases)('%s (%s) appears verbatim with its placeholders', (key, locale) => {
    const text = ALERT_COPY[key].text[locale];
    const slots = Object.fromEntries(
      slotsOf(text).map((slot) => {
        const placeholder = GLOSSARY_PLACEHOLDERS[slot];
        if (placeholder === undefined)
          throw new Error(`${key}: glossary has no placeholder for {${slot}}`);
        return [slot, placeholder[locale]];
      }),
    );
    expect(glossary).toContain(fillCopy(key, locale, slots));
  });

  it.each(ALERT_LOCALES)('official status words are the §3b alternatives (%s)', (locale) => {
    const alternatives = GLOSSARY_PLACEHOLDERS['officialStatus']?.[locale]
      .replace(/^<|>$/gu, '')
      .split('|');
    expect([
      ALERT_COPY['frozen.officialStatus.contained'].text[locale],
      ALERT_COPY['frozen.officialStatus.extinguished'].text[locale],
    ]).toEqual(alternatives);
  });

  it.each(ALERT_LOCALES)('area_both_units keeps the §5.2 shape (%s)', (locale) => {
    // Numbers are locale Intl output, as on the web; the glossary sample groups 3 200 with
    // a space, which CLDR Bulgarian only does from five digits.
    const rendered = formatAreaBothUnits(320, locale);
    const sample = locale === 'bg' ? '~3 200 дка (320 ha)' : '~320 ha (3 200 дка)';
    expect(glossary).toContain(sample);
    const shape = (text: string): string => text.replace(/[\d\s,.\u00a0\u202f]+/gu, '#');
    expect(shape(rendered)).toBe(shape(sample));
  });
});
