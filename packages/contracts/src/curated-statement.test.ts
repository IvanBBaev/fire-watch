import { describe, expect, it } from 'vitest';

import {
  CURATED_STATEMENT_TYPES,
  STATEMENT_ISSUES,
  parseCuratedStatementDraft,
  publicViewOf,
  validateCuratedStatement,
  type CuratedStatementDraft,
} from './curated-statement.js';

const NOW = new Date('2026-08-01T12:00:00Z');

const contained: CuratedStatementDraft = {
  eventId: 'evt-2026-0412',
  statementType: 'officially_contained',
  source: {
    tier: 'T1',
    url: 'https://www.mvr.bg/gdpbzn/bulletin/2026-08-01',
    capture: 'captures/2026-08-01/gdpbzn-bulletin.pdf',
  },
  statedAt: '2026-08-01T09:30:00Z',
  secondSource: {
    tier: 'T2',
    url: 'https://example.org/rdpbzn-post/123',
    capture: 'captures/2026-08-01/rdpbzn-post.png',
  },
  exception: null,
  justification: 'Regional bulletin and the directorate post agree the fire is contained.',
  correctionText: null,
};

const correction: CuratedStatementDraft = {
  ...contained,
  statementType: 'curated_correction',
  secondSource: null,
  exception: 'own_correction',
  correctionText: 'the fire flared up again on 2 August and is active.',
};

const issues = (draft: CuratedStatementDraft): readonly string[] =>
  validateCuratedStatement(draft, NOW);

describe('curated statement vocabulary', () => {
  it('is the two official states plus the correction', () => {
    expect(CURATED_STATEMENT_TYPES).toEqual([
      'officially_contained',
      'officially_extinguished',
      'curated_correction',
    ]);
  });

  it('has snake_case issue codes, each once', () => {
    expect(new Set(STATEMENT_ISSUES).size).toBe(STATEMENT_ISSUES.length);
    for (const issue of STATEMENT_ISSUES) expect(issue).toMatch(/^[a-z]+(?:_[a-z]+)*$/);
  });
});

describe('validateCuratedStatement', () => {
  it('accepts a two-source official state and a correction under its exception', () => {
    expect(issues(contained)).toEqual([]);
    expect(issues(correction)).toEqual([]);
  });

  it('refuses a T4 source for a public statement (§5.10)', () => {
    expect(issues({ ...contained, source: { ...contained.source, tier: 'T4' } })).toContain(
      'source_unverified',
    );
    expect(
      issues({
        ...contained,
        secondSource: { ...contained.secondSource!, tier: 'T4' },
      }),
    ).toContain('second_source_unverified');
  });

  it('refuses to save without a capture (§5.10)', () => {
    expect(issues({ ...contained, source: { ...contained.source, capture: '  ' } })).toContain(
      'capture_missing',
    );
    expect(
      issues({ ...contained, secondSource: { ...contained.secondSource!, capture: '' } }),
    ).toContain('second_source_capture_missing');
  });

  it('requires a second source unless a valid exception is recorded (§5.3)', () => {
    expect(issues({ ...contained, secondSource: null })).toEqual(['second_source_required']);
    expect(issues({ ...contained, secondSource: null, exception: 't1_de_escalation' })).toEqual([]);
    // The de-escalation exception holds for a T1 bulletin only.
    expect(
      issues({
        ...contained,
        source: { ...contained.source, tier: 'T2' },
        secondSource: null,
        exception: 't1_de_escalation',
      }),
    ).toEqual(['exception_not_applicable', 'second_source_required']);
    // Our own correction is not a basis for a state, and a relay never is (§6 Q2).
    expect(issues({ ...contained, secondSource: null, exception: 'own_correction' })).toContain(
      'exception_not_applicable',
    );
    expect(issues({ ...contained, exception: 'life_safety_relay' })).toEqual([
      'exception_not_applicable',
    ]);
  });

  it('needs one of the two sources to be an authority, and the two to differ', () => {
    expect(
      issues({
        ...correction,
        exception: null,
        source: { ...correction.source, tier: 'T3' },
        secondSource: { tier: 'T3', url: 'https://news.example/b', capture: 'c/b' },
      }),
    ).toEqual(['official_source_missing']);
    expect(
      issues({
        ...contained,
        secondSource: {
          ...contained.secondSource!,
          url: 'https://WWW.mvr.bg/gdpbzn/bulletin/2026-08-01/',
        },
      }),
    ).toEqual(['second_source_not_independent']);
  });

  it('never lets a journalistic report carry an official state', () => {
    expect(issues({ ...contained, source: { ...contained.source, tier: 'T3' } })).toContain(
      'journalistic_source_for_state',
    );
  });

  it('checks the URL, the authority timestamp and the one-line justification', () => {
    expect(
      issues({ ...contained, source: { ...contained.source, url: 'javascript:alert(1)' } }),
    ).toEqual(['source_url_invalid']);
    expect(issues({ ...contained, statedAt: 'yesterday' })).toEqual(['stated_at_invalid']);
    expect(issues({ ...contained, statedAt: '2026-08-02T00:00:00Z' })).toEqual([
      'stated_at_in_future',
    ]);
    expect(issues({ ...contained, justification: ' ' })).toEqual(['justification_missing']);
    expect(issues({ ...contained, justification: 'one\ntwo' })).toEqual([
      'justification_not_one_line',
    ]);
    expect(issues({ ...contained, justification: 'x'.repeat(281) })).toEqual([
      'justification_not_one_line',
    ]);
    expect(issues({ ...contained, eventId: '../etc' })).toEqual(['event_id_invalid']);
  });

  it('keeps the correction text to corrections', () => {
    expect(issues({ ...correction, correctionText: '' })).toEqual(['correction_text_missing']);
    expect(issues({ ...contained, correctionText: 'x' })).toEqual(['correction_text_not_allowed']);
  });

  it('refuses a type outside the frozen vocabulary', () => {
    expect(
      issues({ ...contained, statementType: 'out' as CuratedStatementDraft['statementType'] }),
    ).toContain('statement_type_invalid');
  });
});

describe('parseCuratedStatementDraft', () => {
  it('reads a well-shaped body and refuses a malformed one', () => {
    expect(parseCuratedStatementDraft(JSON.parse(JSON.stringify(contained)))).toEqual(contained);
    const { secondSource: _omit, ...withoutSecond } = contained;
    expect(parseCuratedStatementDraft(withoutSecond)).toEqual({ ...contained, secondSource: null });
    expect(parseCuratedStatementDraft({ ...contained, source: 'x' })).toBeNull();
    expect(parseCuratedStatementDraft({ ...contained, secondSource: 3 })).toBeNull();
    expect(parseCuratedStatementDraft({ ...contained, justification: 1 })).toBeNull();
    expect(parseCuratedStatementDraft([])).toBeNull();
    expect(parseCuratedStatementDraft(null)).toBeNull();
  });
});

describe('publicViewOf', () => {
  it('never carries a capture or the internal justification (§5.4)', () => {
    const view = JSON.stringify(publicViewOf(contained));
    expect(view).not.toContain('captures/');
    expect(view).not.toContain('justification');
    expect(publicViewOf(contained).source).toEqual({
      tier: 'T1',
      url: contained.source.url,
    });
  });
});
