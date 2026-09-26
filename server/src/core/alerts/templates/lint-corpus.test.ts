/**
 * CI-10's good-must-pass / bad-must-fail corpus for alert copy (GLOSSARY §5.1 item 7).
 */

import { lintAlertText } from '@fire-watch/contracts';
import { describe, expect, it } from 'vitest';

import { LINT_CORPUS_FAIL, LINT_CORPUS_PASS, type LintCorpusEntry } from './lint-corpus.js';

const OWN = { voice: 'own' } as const;

function ruleIds(entry: LintCorpusEntry): readonly string[] {
  return lintAlertText(entry.text, entry.context ?? OWN).map((violation) => violation.ruleId);
}

describe('CI-10 alert lint corpus', () => {
  it.each(LINT_CORPUS_PASS.map((entry) => [entry.note, entry] as const))(
    'passes: %s',
    (_note, entry) => {
      expect(ruleIds(entry), entry.text).toEqual([]);
    },
  );

  it.each(LINT_CORPUS_FAIL.map((entry) => [entry.note, entry] as const))(
    'fails: %s',
    (_note, entry) => {
      expect(entry.expect.length, 'a must-fail entry names its rules').toBeGreaterThan(0);
      expect(ruleIds(entry), entry.text).toEqual(entry.expect);
    },
  );

  it('carries the §5.1 minimum fail set verbatim', () => {
    const texts = LINT_CORPUS_FAIL.map((entry) => entry.text);
    for (const required of [
      'the fire is out',
      'пожарът е изгасен',
      'no fires in your area',
      'няма пожари във вашия район',
      'safe to return',
      'можете да се върнете',
      'heading for Ivaylovgrad',
      'евакуирайте се',
    ]) {
      expect(texts).toContain(required);
    }
  });

  it('carries a paraphrase of every §3 state in both languages', () => {
    const states = [
      'active',
      'signal_weakening',
      'no_longer_detected',
      'officially_contained',
      'officially_extinguished',
      'archived',
    ];
    for (const state of states) {
      for (const locale of ['bg', 'en'] as const) {
        const found = LINT_CORPUS_FAIL.some(
          (entry) => entry.locale === locale && entry.note.startsWith(`§3 ${state} `),
        );
        expect(found, `${state} ${locale}`).toBe(true);
      }
    }
  });
});
