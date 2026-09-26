import { describe, expect, it } from 'vitest';

import {
  ALERT_VOICES,
  FOOTER_REQUIREMENTS,
  FOOTER_RULE_IDS,
  FROZEN_HONEST_COPY,
  NEVER_SEND_RULES,
  NEVER_SEND_RULE_IDS,
  NeverSendError,
  assertSendable,
  lintAlert,
  lintAlertFooter,
  lintAlertText,
  type NeverSendContext,
  type NeverSendViolation,
} from './never-send.js';

/** A footer that satisfies all three of ADR-004 D7's positive obligations. */
const FOOTER =
  'Source: NASA FIRMS (LANCE). Near real-time data, not advised for tactical decision-making. ' +
  'Fire Watch is best-effort informational monitoring — in an emergency call 112.';

const FOOTER_BG =
  'Източник: NASA FIRMS (LANCE). Данните не са предназначени за тактически решения. ' +
  'Fire Watch е информационна услуга с най-добри усилия — при спешен случай звънете на 112.';

function ownVoice(overrides: Partial<NeverSendContext> = {}): NeverSendContext {
  return { voice: 'own', ...overrides };
}

function quotedVoice(overrides: Partial<NeverSendContext> = {}): NeverSendContext {
  return {
    voice: 'quoted-official',
    quotedSource: {
      authority: 'ГДПБЗН',
      sourceUrl: 'https://pojarna.com/statements/1',
      statementAt: '2026-08-14T12:40:00.000Z',
    },
    ...overrides,
  };
}

function ids(violations: readonly NeverSendViolation[]): readonly string[] {
  return violations.map((violation) => violation.ruleId);
}

describe('NEVER_SEND_RULES', () => {
  it('exposes exactly the published rule ids, in order', () => {
    expect(NEVER_SEND_RULES.map((rule) => rule.id)).toEqual([...NEVER_SEND_RULE_IDS]);
  });

  it('covers all eight numbered hard rules of 12 §3.4', () => {
    const numbered = NEVER_SEND_RULES.flatMap((rule) =>
      rule.hardRule === null ? [] : [rule.hardRule],
    );
    expect(numbered.slice().sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it('exempts only hard rules 2, 3 and 6 (CI-10 §5.5)', () => {
    const exemptible = NEVER_SEND_RULES.filter((rule) => rule.exemption !== 'none');
    expect(exemptible.map((rule) => rule.id)).toEqual([
      'own-voice-extinguished',
      'own-voice-evacuation',
      'responder-presence',
    ]);
    expect(exemptible.map((rule) => rule.exemption)).toEqual([
      'attributed-quote',
      'authority-led-quote',
      'attributed-quote',
    ]);
  });

  it('compiles every pattern as a global unicode regex', () => {
    const patterns = NEVER_SEND_RULES.flatMap((rule) => [...rule.patterns]);
    expect(patterns.length).toBeGreaterThan(0);
    for (const pattern of patterns) {
      expect(pattern.flags).toContain('g');
      expect(pattern.flags).toContain('u');
    }
  });

  it('gives every rule a summary and at least one pattern', () => {
    for (const rule of NEVER_SEND_RULES) {
      expect(rule.summary.length).toBeGreaterThan(0);
      expect(rule.patterns.length).toBeGreaterThan(0);
    }
  });

  it('publishes footer rule ids that match the footer requirements', () => {
    expect(FOOTER_REQUIREMENTS.map((requirement) => requirement.id)).toEqual([...FOOTER_RULE_IDS]);
  });
});

describe('hard rule 1 — all clear', () => {
  it('rejects an all-clear', () => {
    expect(ids(lintAlertText('The all clear has been given for the village.', ownVoice()))).toEqual(
      ['all-clear'],
    );
  });

  it('rejects "safe to return"', () => {
    expect(ids(lintAlertText('It is safe to return to your homes.', ownVoice()))).toContain(
      'all-clear',
    );
  });

  it('rejects the Bulgarian "няма опасност"', () => {
    expect(ids(lintAlertText('Няма опасност за населението.', ownVoice()))).toEqual(['all-clear']);
  });

  it('allows "keep a safe distance" — the word safe is not banned, the promise is', () => {
    expect(lintAlertText('Keep a safe distance from the fire area.', ownVoice())).toEqual([]);
  });

  it('allows the Bulgarian "безопасна дистанция"', () => {
    expect(lintAlertText('Пазете безопасна дистанция.', ownVoice())).toEqual([]);
  });

  it('has no quoted-source exemption', () => {
    expect(ids(lintAlertText('ГДПБЗН: няма опасност за населението.', quotedVoice()))).toEqual([
      'all-clear',
    ]);
  });
});

describe('hard rule 2 — extinguished in our own voice', () => {
  it('rejects "the fire is out" and reports the span', () => {
    const violations = lintAlertText('The fire is out.', ownVoice());
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({
      ruleId: 'own-voice-extinguished',
      hardRule: 2,
      match: 'fire is out',
      index: 4,
    });
  });

  it('rejects the Bulgarian "изгасен" whatever the inflection', () => {
    expect(ids(lintAlertText('Пожарът е изгасен.', ownVoice()))).toEqual([
      'own-voice-extinguished',
    ]);
    expect(ids(lintAlertText('Говорим за изгасените огнища.', ownVoice()))).toEqual([
      'own-voice-extinguished',
    ]);
  });

  it('rejects "локализиран" in our own voice — containment is an authority-only word', () => {
    expect(ids(lintAlertText('Пожарът е локализиран.', ownVoice()))).toEqual([
      'own-voice-extinguished',
    ]);
  });

  it('allows an attributed official statement of containment', () => {
    expect(lintAlertText('ГДПБЗН: пожарът е локализиран.', quotedVoice())).toEqual([]);
  });

  it('allows the frozen sentence that exists to negate "out"', () => {
    const honest =
      'This does not mean the fire is out — satellites cannot see smoldering, ' +
      'burning under trees or through cloud.';
    expect(lintAlertText(honest, ownVoice())).toEqual([]);
  });

  it('loses the exemption on one word of paraphrase (CI-10 §5.6)', () => {
    expect(ids(lintAlertText('This does not mean that the fire is out.', ownVoice()))).toEqual([
      'own-voice-extinguished',
    ]);
  });

  it('does not fire on words that merely contain a banned substring', () => {
    expect(
      lintAlertText('The outbox layout is about the timeout, not burnout.', ownVoice()),
    ).toEqual([]);
  });
});

describe('hard rule 3 — evacuation in our own voice', () => {
  it('rejects an evacuation instruction we author', () => {
    expect(ids(lintAlertText('Evacuate the area immediately.', ownVoice()))).toContain(
      'own-voice-evacuation',
    );
  });

  it('rejects the Bulgarian imperative', () => {
    expect(ids(lintAlertText('Евакуирайте се незабавно.', ownVoice()))).toEqual([
      'own-voice-evacuation',
    ]);
  });

  it('allows an official order that leads with the authority', () => {
    expect(lintAlertText('ГДПБЗН нареди евакуация на Воден.', quotedVoice())).toEqual([]);
  });

  it('rejects the same order when our own name comes first', () => {
    const violations = lintAlertText(
      'Fire Watch: ГДПБЗН нареди евакуация на Воден.',
      quotedVoice(),
    );
    expect(ids(violations)).toEqual(['own-voice-evacuation']);
    expect(violations[0]?.reason).toContain('does not lead with');
    expect(violations[0]?.reason).toContain('ГДПБЗН');
  });

  it('allows "prepare to close your windows" — only leaving is banned', () => {
    expect(
      lintAlertText('Prepare to close your windows if smoke reaches you.', ownVoice()),
    ).toEqual([]);
  });
});

describe('hard rule 4 — "no fires" as reassurance', () => {
  it('rejects "no fires in your area"', () => {
    expect(ids(lintAlertText('No fires in your area.', ownVoice()))).toEqual([
      'no-fires-reassurance',
    ]);
  });

  it('rejects the Bulgarian "няма пожари"', () => {
    expect(ids(lintAlertText('Няма пожари във вашата зона.', ownVoice()))).toEqual([
      'no-fires-reassurance',
    ]);
  });

  it('allows the honest empty state, which says detections rather than fires', () => {
    const honest =
      'No satellite detections in this area. This is not a statement that there are no fires.';
    expect(lintAlertText(honest, ownVoice())).toEqual([]);
    // Non-vacuous: one word of drift and the same sentence is a rule-4 violation.
    expect(
      ids(lintAlertText('This is not a statement that there are no fires here.', ownVoice())),
    ).toEqual(['no-fires-reassurance']);
  });

  it('allows the Bulgarian honest empty state', () => {
    const honest = 'Няма сателитни засичания в тази зона. Това не означава, че няма пожари.';
    expect(lintAlertText(honest, ownVoice())).toEqual([]);
  });

  it('has no quoted-source exemption', () => {
    expect(ids(lintAlertText('ГДПБЗН: No fires in your area.', quotedVoice()))).toEqual([
      'no-fires-reassurance',
    ]);
  });
});

describe('hard rule 5 — directional prediction', () => {
  it('rejects a trajectory claim', () => {
    expect(ids(lintAlertText('The fire is heading for Voden.', ownVoice()))).toEqual([
      'directional-prediction',
    ]);
  });

  it('rejects the Bulgarian "се насочва към"', () => {
    expect(ids(lintAlertText('Пожарът се насочва към селото.', ownVoice()))).toEqual([
      'directional-prediction',
    ]);
  });

  it('allows wind context, which is observation rather than prediction', () => {
    expect(lintAlertText('Wind is from the north-west at 25 km/h.', ownVoice())).toEqual([]);
    expect(lintAlertText('Вятърът е северозападен, 25 км/ч.', ownVoice())).toEqual([]);
  });
});

describe('hard rule 6 — responder presence', () => {
  it('rejects a claim that crews are on scene', () => {
    expect(ids(lintAlertText('Firefighters are on scene.', ownVoice()))).toEqual([
      'responder-presence',
    ]);
  });

  it('rejects the negative claim too — it reads as abandonment', () => {
    expect(ids(lintAlertText('No crews on the scene.', ownVoice()))).toEqual([
      'responder-presence',
    ]);
  });

  it('rejects the Bulgarian "пожарникарите са на място"', () => {
    expect(ids(lintAlertText('Пожарникарите са на място.', ownVoice()))).toEqual([
      'responder-presence',
    ]);
  });

  it('allows an attributed report without requiring the authority to come first', () => {
    expect(lintAlertText('According to ГДПБЗН, crews are on site.', quotedVoice())).toEqual([]);
  });

  it('allows saying we cannot tell', () => {
    expect(lintAlertText('We cannot tell whether any crews have responded.', ownVoice())).toEqual(
      [],
    );
  });
});

describe('hard rule 7 — sending people toward a fire', () => {
  it('rejects "go and verify, then report back"', () => {
    const violations = lintAlertText('Go to the fire and report back what you see.', ownVoice());
    expect(new Set(ids(violations))).toEqual(new Set(['approach-the-fire']));
    expect(violations.length).toBeGreaterThanOrEqual(2);
  });

  it('rejects the Bulgarian equivalent', () => {
    expect(ids(lintAlertText('Отидете до пожара и ни съобщете.', ownVoice()))).toContain(
      'approach-the-fire',
    );
  });

  it('allows the mandatory no-travel line built from the same vocabulary', () => {
    const honest = 'Do not travel toward the fire area — keep roads clear for responders.';
    expect(lintAlertText(honest, ownVoice())).toEqual([]);
    // Non-vacuous: the line passes because it is frozen, not because the rule is blind.
    expect(ids(lintAlertText('Do not travel toward the fire area.', ownVoice()))).toEqual([
      'approach-the-fire',
    ]);
  });

  it('has no quoted-source exemption', () => {
    expect(ids(lintAlertText('ГДПБЗН: go to the fire area.', quotedVoice()))).toEqual([
      'approach-the-fire',
    ]);
  });
});

describe('hard rule 8 — health advice', () => {
  it('rejects prescriptive advice', () => {
    const violations = lintAlertText(
      'Wear an N95 mask and see a doctor if you feel unwell.',
      ownVoice(),
    );
    expect(new Set(ids(violations))).toEqual(new Set(['health-advice']));
  });

  it('rejects reassurance about the air, which is rule 1 in a lab coat', () => {
    expect(ids(lintAlertText('The air is safe.', ownVoice()))).toContain('health-advice');
  });

  it('rejects the Bulgarian "носете маска"', () => {
    expect(ids(lintAlertText('Носете маска, когато излизате.', ownVoice()))).toEqual([
      'health-advice',
    ]);
  });

  it('allows generic sourced guidance', () => {
    const generic =
      'Close your windows if you can smell smoke. Official guidance: https://ncpha.government.bg/smoke';
    expect(lintAlertText(generic, ownVoice())).toEqual([]);
  });
});

describe('cause attribution (12 §3.3)', () => {
  it('rejects calling a fire arson', () => {
    expect(ids(lintAlertText('Investigators say the fire was arson.', ownVoice()))).toEqual([
      'cause-attribution',
    ]);
  });

  it('rejects the Bulgarian "умишлено запален"', () => {
    expect(ids(lintAlertText('Пожарът е умишлено запален.', ownVoice()))).toEqual([
      'cause-attribution',
    ]);
  });

  it('allows the agricultural-burn tag, which is a burn and not an accusation', () => {
    expect(lintAlertText('Възможно селскостопанско палене.', ownVoice())).toEqual([]);
  });

  it('cites §3.3 rather than a numbered hard rule', () => {
    const violations = lintAlertText('Arson is suspected.', ownVoice());
    expect(violations[0]?.hardRule).toBeNull();
    expect(violations[0]?.reason).toContain('§3.3');
  });
});

describe('the quoted-source exemption (CI-10 §5.5)', () => {
  it('requires a source link', () => {
    const context = quotedVoice({
      quotedSource: {
        authority: 'ГДПБЗН',
        sourceUrl: null,
        statementAt: '2026-08-14T12:40:00.000Z',
      },
    });
    const violations = lintAlertText('ГДПБЗН: пожарът е локализиран.', context);
    expect(ids(violations)).toEqual(['own-voice-extinguished']);
    expect(violations[0]?.reason).toContain('source link');
  });

  it('requires a statement timestamp', () => {
    const context = quotedVoice({
      quotedSource: {
        authority: 'ГДПБЗН',
        sourceUrl: 'https://pojarna.com/statements/1',
        statementAt: null,
      },
    });
    expect(lintAlertText('ГДПБЗН: пожарът е локализиран.', context)[0]?.reason).toContain(
      'statement timestamp',
    );
  });

  it('names both halves when both are missing', () => {
    const context = quotedVoice({
      quotedSource: { authority: 'ГДПБЗН', sourceUrl: null, statementAt: null },
    });
    const reason = lintAlertText('ГДПБЗН: пожарът е локализиран.', context)[0]?.reason ?? '';
    expect(reason).toContain('source link');
    expect(reason).toContain('statement timestamp');
  });

  it('rejects a quote with no attributed source at all', () => {
    const context: NeverSendContext = { voice: 'quoted-official', quotedSource: null };
    expect(lintAlertText('Пожарът е локализиран.', context)[0]?.reason).toContain(
      'no attributed source',
    );
  });

  it('explains that our own voice is the problem when it is', () => {
    expect(lintAlertText('Пожарът е локализиран.', ownVoice())[0]?.reason).toContain(
      'our own voice',
    );
  });

  it('says so plainly when a rule has no exemption at any voice', () => {
    expect(lintAlertText('The all clear has been given.', quotedVoice())[0]?.reason).toContain(
      'banned in every voice',
    );
  });
});

describe('the template allowlist', () => {
  it('lints every frozen honest sentence clean in our own voice', () => {
    for (const frozen of FROZEN_HONEST_COPY) {
      expect(lintAlertText(frozen, ownVoice())).toEqual([]);
    }
  });

  it('accepts a template-scoped frozen string', () => {
    const note = 'The word extinguished appears in this frozen editorial note.';
    expect(ids(lintAlertText(note, ownVoice()))).toEqual(['own-voice-extinguished']);
    expect(lintAlertText(note, ownVoice({ allowlist: [note] }))).toEqual([]);
  });

  it('does not allowlist the surrounding text', () => {
    const note = 'The word extinguished appears in this frozen editorial note.';
    const violations = lintAlertText(`${note} The fire is out.`, ownVoice({ allowlist: [note] }));
    expect(violations).toHaveLength(1);
    expect(violations[0]?.match).toBe('fire is out');
  });
});

describe('lintAlertFooter', () => {
  it('accepts a footer carrying all three obligations', () => {
    expect(lintAlertFooter(FOOTER)).toEqual([]);
  });

  it('accepts the Bulgarian footer', () => {
    expect(lintAlertFooter(FOOTER_BG)).toEqual([]);
  });

  it('reports a missing source attribution', () => {
    const footer =
      'Near real-time data, not advised for tactical decision-making. ' +
      'Fire Watch is best-effort informational monitoring — in an emergency call 112.';
    expect(ids(lintAlertFooter(footer))).toEqual(['footer-attribution']);
  });

  it('reports a missing LANCE disclaimer', () => {
    const footer =
      'Source: NASA FIRMS (LANCE). ' +
      'Fire Watch is best-effort informational monitoring — in an emergency call 112.';
    expect(ids(lintAlertFooter(footer))).toEqual(['footer-lance-disclaimer']);
  });

  it('reports a missing scope-of-service claim', () => {
    const footer =
      'Source: NASA FIRMS (LANCE). Near real-time data, not advised for tactical decision-making. ' +
      'In an emergency call 112.';
    const violations = lintAlertFooter(footer);
    expect(ids(violations)).toEqual(['footer-scope-of-service']);
    expect(violations[0]?.reason).toContain('scope-of-service');
  });

  it('reports a missing 112 separately from the scope claim', () => {
    const footer =
      'Source: NASA FIRMS (LANCE). Near real-time data, not advised for tactical decision-making. ' +
      'Fire Watch is best-effort informational monitoring.';
    const violations = lintAlertFooter(footer);
    expect(ids(violations)).toEqual(['footer-scope-of-service']);
    expect(violations[0]?.reason).toContain('112');
  });

  it('reports every missing obligation at once', () => {
    expect(ids(lintAlertFooter('Sent by Fire Watch.'))).toEqual([
      'footer-attribution',
      'footer-lance-disclaimer',
      'footer-scope-of-service',
      'footer-scope-of-service',
    ]);
  });

  it('reports missing obligations with no span', () => {
    const violations = lintAlertFooter('Sent by Fire Watch.');
    for (const violation of violations) {
      expect(violation.match).toBeNull();
      expect(violation.index).toBeNull();
    }
  });
});

describe('lintAlert', () => {
  it('accepts an alert whose body and footer both hold', () => {
    const body =
      'No satellite detections in this area. This is not a statement that there are no fires.';
    expect(lintAlert({ body, footer: FOOTER }, ownVoice())).toEqual([]);
  });

  it('lints banned vocabulary in the footer as well as the body', () => {
    const footer = `${FOOTER} The fire is out.`;
    expect(ids(lintAlert({ body: 'New detections near Voden.', footer }, ownVoice()))).toEqual([
      'own-voice-extinguished',
    ]);
  });

  it('reports body violations and footer omissions together', () => {
    const violations = lintAlert(
      { body: 'The fire is out.', footer: 'Sent by Fire Watch.' },
      ownVoice(),
    );
    expect(new Set(ids(violations))).toEqual(
      new Set([
        'own-voice-extinguished',
        'footer-attribution',
        'footer-lance-disclaimer',
        'footer-scope-of-service',
      ]),
    );
  });
});

describe('assertSendable', () => {
  it('returns quietly for a sendable alert', () => {
    const body = 'Do not travel toward the fire area — keep roads clear for responders.';
    expect(() => {
      assertSendable({ body, footer: FOOTER }, ownVoice());
    }).not.toThrow();
  });

  it('throws NeverSendError carrying every violation', () => {
    let thrown: unknown;
    try {
      assertSendable({ body: 'The fire is out. All clear.', footer: FOOTER }, ownVoice());
    } catch (error: unknown) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(NeverSendError);
    const error = thrown as NeverSendError;
    expect(error.name).toBe('NeverSendError');
    expect(new Set(ids(error.violations))).toEqual(
      new Set(['own-voice-extinguished', 'all-clear']),
    );
    expect(error.message).toContain('all-clear');
  });
});

describe('programmer error', () => {
  it('rejects a non-string subject', () => {
    expect(() => lintAlertText(42 as unknown as string, ownVoice())).toThrow(TypeError);
    expect(() => lintAlertFooter(null as unknown as string)).toThrow(TypeError);
  });

  it('rejects an unknown voice', () => {
    const context = { voice: 'editorial' } as unknown as NeverSendContext;
    expect(() => lintAlertText('anything', context)).toThrow(RangeError);
  });

  it('rejects a quoted source that names no authority', () => {
    const context = quotedVoice({
      quotedSource: { authority: '   ', sourceUrl: 'https://x.test/1', statementAt: '2026-08-14' },
    });
    expect(() => lintAlertText('anything', context)).toThrow(TypeError);
  });

  it('publishes both voices', () => {
    expect([...ALERT_VOICES]).toEqual(['own', 'quoted-official']);
  });
});

describe('statelessness', () => {
  it('returns the same findings when the same text is linted twice', () => {
    const text = 'The fire is out. All clear. Firefighters are on scene.';
    const first = lintAlertText(text, ownVoice());
    const second = lintAlertText(text, ownVoice());
    expect(second).toEqual(first);
  });

  it('does not carry match position between calls', () => {
    lintAlertText('The fire is out, and the fire is out again.', ownVoice());
    expect(ids(lintAlertText('The fire is out.', ownVoice()))).toEqual(['own-voice-extinguished']);
  });

  it('does not carry match position between footer calls', () => {
    expect(lintAlertFooter(FOOTER)).toEqual([]);
    expect(lintAlertFooter(FOOTER)).toEqual([]);
    expect(lintAlertFooter(FOOTER)).toEqual([]);
  });
});

describe('reporting', () => {
  it('returns violations ordered by position in the text', () => {
    const violations = lintAlertText('Firefighters are on scene. The fire is out.', ownVoice());
    const indexes = violations.map((violation) => violation.index ?? -1);
    expect(indexes).toEqual([...indexes].sort((a, b) => a - b));
  });

  it('reports one finding per span even when several patterns cover it', () => {
    const violations = lintAlertText('Пожарът е локализиран.', ownVoice());
    expect(violations).toHaveLength(1);
  });

  it('carries the rule summary so a CI report needs no lookup table', () => {
    const violations = lintAlertText('The fire is out.', ownVoice());
    expect(violations[0]?.summary).toBe(
      NEVER_SEND_RULES.find((rule) => rule.id === 'own-voice-extinguished')?.summary,
    );
  });
});

describe('title', () => {
  it('lints the title, which on push is the only text most recipients read', () => {
    const violations = lintAlert(
      { title: 'The fire is out.', body: 'A hotspot was detected.', footer: FOOTER },
      ownVoice(),
    );
    expect(violations.map((violation) => violation.ruleId)).toContain('own-voice-extinguished');
  });

  it('accepts an alert with no title at all', () => {
    expect(lintAlert({ body: 'A hotspot was detected.', footer: FOOTER }, ownVoice())).toEqual([]);
  });
});
