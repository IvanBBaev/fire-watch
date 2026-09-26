/**
 * The alert templates (TASKS H6): the founder-review register, parameter validation, and
 * CI-10 over every rendered variant — each template × variant × channel × locale × score
 * bucket, plus the truncated push — with the context the gateway will lint it under.
 */

import { CREDITS, lintAlert, SCORE_BUCKETS, type ScoreBucket } from '@fire-watch/contracts';
import { describe, expect, it } from 'vitest';

import type { AlertChannel } from '../../ports/alert-outbox-store.js';
import type { RenderRequest } from '../../ports/alert-renderer.js';

import { ALERT_COPY, ALERT_COPY_PENDING_FOUNDER_REVIEW, fillCopy } from './alert-copy.js';
import {
  ALERT_TEMPLATE_IDS,
  ALERT_TEMPLATE_PARAM_KEYS,
  ALERT_TEMPLATE_PARAM_PRIVACY,
  alertLocale,
  BODY_MAX_CHARS,
  DRAFT_ALERT_TEMPLATES,
  formatAreaBothUnits,
  formatDistance,
  isReviewedTemplate,
  lintContextFor,
  renderAlertTemplate,
} from './alert-templates.js';

const CHANNELS: readonly AlertChannel[] = ['push', 'telegram', 'email'];
const LOCALES = ['bg', 'en'] as const;
const ZONE = 'Europe/Sofia';

function eventParams(bucket: ScoreBucket = 'likely'): Record<string, unknown> {
  return {
    eventUrl: 'https://firewatch.example/e/gdv6q',
    placeName: { bg: 'Ивайловград', en: 'Ivaylovgrad' },
    distanceKm: 4.26,
    zoneLabel: 'Вила',
    observedAt: '2026-08-12T11:05:00Z',
    scoreBucket: bucket,
    burnedAreaHa: 320,
    areaSource: 'EFFIS',
    agriBurn: true,
  };
}

function escalationParams(
  overrides: Record<string, unknown>,
  bucket: ScoreBucket = 'likely',
): Record<string, unknown> {
  return {
    ...eventParams(bucket),
    rung: 'score_upgrade',
    variant: null,
    officialStatus: null,
    officialStatementAt: null,
    officialSourceLabel: null,
    officialSourceUrl: null,
    ...overrides,
  };
}

const OFFICIAL = {
  rung: 'lifecycle_worsening',
  variant: 'official_then_redetected',
  officialStatus: 'extinguished',
  officialStatementAt: '2026-08-10T09:00:00+03:00',
  officialSourceLabel: 'ГДПБЗН',
  officialSourceUrl: 'https://www.gdpbzn.bg/',
};

function digestParams(count: number): Record<string, unknown> {
  const { zoneLabel: _zone, ...entry } = eventParams();
  return {
    windowStart: '2026-08-12T06:00:00Z',
    zoneLabel: null,
    entries: Array.from({ length: count }, (_, index) => ({
      ...entry,
      eventUrl: `https://firewatch.example/e/ev${String(index)}`,
      scoreBucket: SCORE_BUCKETS[index % SCORE_BUCKETS.length],
    })),
  };
}

/** Every variant each template can render, as a parameter builder per score bucket. */
const VARIANTS: readonly {
  readonly name: string;
  readonly templateId: string;
  readonly params: (bucket: ScoreBucket) => Record<string, unknown>;
}[] = [
  { name: 'new_fire', templateId: 'new_fire.v1', params: (b) => eventParams(b) },
  {
    name: 'new_fire without area, not agricultural, default zone',
    templateId: 'new_fire.v1',
    params: (b) => ({
      ...eventParams(b),
      burnedAreaHa: null,
      areaSource: null,
      agriBurn: false,
      zoneLabel: null,
      distanceKm: 23.4,
    }),
  },
  {
    name: 'escalation score_upgrade',
    templateId: 'escalation.v1',
    params: (b) => escalationParams({}, b),
  },
  {
    name: 'escalation area_doubling',
    templateId: 'escalation.v1',
    params: (b) => escalationParams({ rung: 'area_doubling' }, b),
  },
  {
    name: 'escalation redetected',
    templateId: 'escalation.v1',
    params: (b) => escalationParams({ rung: 'lifecycle_worsening', variant: 'redetected' }, b),
  },
  {
    name: 'escalation reignition',
    templateId: 'escalation.v1',
    params: (b) => escalationParams({ rung: 'lifecycle_worsening', variant: 'reignition' }, b),
  },
  {
    name: 'escalation official_then_redetected (extinguished)',
    templateId: 'escalation.v1',
    params: (b) => escalationParams(OFFICIAL, b),
  },
  {
    name: 'escalation official_then_redetected (contained)',
    templateId: 'escalation.v1',
    params: (b) => escalationParams({ ...OFFICIAL, officialStatus: 'contained' }, b),
  },
  { name: 'digest, one entry', templateId: 'digest.v1', params: () => digestParams(1) },
  { name: 'digest, many entries', templateId: 'digest.v1', params: () => digestParams(40) },
];

function request(
  templateId: string,
  templateParams: Record<string, unknown>,
  channel: AlertChannel = 'email',
  locale = 'en',
): RenderRequest {
  return { templateId, templateParams, channel, locale, timeZone: ZONE };
}

describe('ALERT_COPY_PENDING_FOUNDER_REVIEW', () => {
  it('lists exactly the copy awaiting review', () => {
    expect([...ALERT_COPY_PENDING_FOUNDER_REVIEW]).toEqual([
      'footer.attribution',
      'footer.scope',
      'tier.confirmed',
      'tier.likely',
      'tier.unverified',
      'line.confidence',
      'line.unverifiedNote',
      'line.distance',
      'line.area',
      'unit.distanceKm',
      'zone.default',
      'zone.named',
      'event.nearPlace',
      'source.withLink',
      'newFire.title',
      'escalation.title',
      'escalation.scoreUpgrade',
      'escalation.areaDoubling',
      'escalation.redetected',
      'escalation.reignition',
      'digest.title',
      'digest.introOne',
      'digest.introMany',
      'digest.entry',
      'digest.more',
    ]);
  });

  it('holds only own-voice copy, and every own-voice entry', () => {
    for (const [key, entry] of Object.entries(ALERT_COPY)) {
      expect((ALERT_COPY_PENDING_FOUNDER_REVIEW as readonly string[]).includes(key), key).toBe(
        entry.governance === 'own-voice',
      );
    }
  });

  it('keeps every template unreviewed while any of its copy is pending', () => {
    for (const id of ALERT_TEMPLATE_IDS) expect(isReviewedTemplate(id), id).toBe(false);
  });

  it('reads licence copy from the credits registry, not a retyped string', () => {
    const text = (id: string): string | undefined => CREDITS.find((c) => c.id === id)?.text;
    for (const locale of LOCALES) {
      expect(ALERT_COPY['licence.lanceTactical'].text[locale]).toBe(
        text('lance-tactical-disclaimer'),
      );
      expect(ALERT_COPY['licence.lanceAsIs'].text[locale]).toBe(text('lance-as-is'));
    }
  });
});

describe('fillCopy', () => {
  it('fills slots', () => {
    expect(fillCopy('frozen.active', 'en', { time: '14:05' })).toBe(
      'Actively detected — last satellite detection 14:05',
    );
  });

  it('throws on a missing slot and on an unused one', () => {
    expect(() => fillCopy('frozen.active', 'en')).toThrow(/needs slot \{time\}/u);
    expect(() => fillCopy('frozen.safetyNoTravel', 'en', { time: '1' })).toThrow(/no slot/u);
  });

  it('leaves no marker unfilled in any rendered variant', () => {
    for (const variant of VARIANTS) {
      for (const locale of LOCALES) {
        const rendered = renderAlertTemplate(
          request(variant.templateId, variant.params('likely'), 'email', locale),
        );
        expect(`${rendered.title}\n${rendered.body}\n${rendered.footer}`).not.toMatch(
          /\{[a-zA-Z]+\}|undefined|NaN/u,
        );
      }
    }
  });
});

describe('parameter validation', () => {
  it('rejects unknown, missing and ill-typed params', () => {
    const render = (params: Record<string, unknown>): unknown =>
      renderAlertTemplate(request('new_fire.v1', params));
    expect(() => render({ ...eventParams(), extra: 1 })).toThrow(/unknown param extra/u);
    const { distanceKm: _d, ...missing } = eventParams();
    expect(() => render(missing)).toThrow(/missing param distanceKm/u);
    expect(() => render({ ...eventParams(), distanceKm: -1 })).toThrow(/distanceKm/u);
    expect(() => render({ ...eventParams(), scoreBucket: 'certain' })).toThrow(/scoreBucket/u);
    expect(() => render({ ...eventParams(), eventUrl: 'http://x.example/e/1' })).toThrow(/https/u);
    expect(() => render({ ...eventParams(), observedAt: '2026-08-12T11:05:00' })).toThrow(
      /offset/u,
    );
    expect(() => render({ ...eventParams(), areaSource: null })).toThrow(/together/u);
    expect(() => render({ ...eventParams(), placeName: { bg: 'Х' } })).toThrow(/missing param en/u);
  });

  it('ties escalation fields to their rung and variant', () => {
    const render = (overrides: Record<string, unknown>): unknown =>
      renderAlertTemplate(request('escalation.v1', escalationParams(overrides)));
    expect(() => render({ variant: 'redetected' })).toThrow(/only for lifecycle_worsening/u);
    expect(() => render({ rung: 'lifecycle_worsening' })).toThrow(/variant/u);
    expect(() => render({ rung: 'area_doubling', burnedAreaHa: null, areaSource: null })).toThrow(
      /area_doubling needs/u,
    );
    expect(() => render({ officialStatus: 'contained' })).toThrow(
      /only for official_then_redetected/u,
    );
    expect(() => render({ ...OFFICIAL, officialSourceUrl: null })).toThrow(/officialSourceUrl/u);
    expect(() => render({ ...OFFICIAL, officialStatementAt: null })).toThrow(
      /officialStatementAt/u,
    );
  });

  it('rejects an empty digest and unknown templates and locales', () => {
    expect(() =>
      renderAlertTemplate(request('digest.v1', { ...digestParams(1), entries: [] })),
    ).toThrow(/non-empty/u);
    expect(() => renderAlertTemplate(request('resolved.v1', eventParams()))).toThrow(
      /no alert template/u,
    );
    expect(() =>
      renderAlertTemplate(request('new_fire.v1', eventParams(), 'email', 'de-DE')),
    ).toThrow(/no alert copy for locale de-DE/u);
  });

  it('classifies every parameter for pseudonymization', () => {
    const keys = new Set(Object.values(ALERT_TEMPLATE_PARAM_KEYS).flat());
    expect(new Set(Object.keys(ALERT_TEMPLATE_PARAM_PRIVACY))).toEqual(keys);
  });
});

describe('CI-10 over rendered templates', () => {
  const cases = VARIANTS.flatMap((variant) =>
    CHANNELS.flatMap((channel) =>
      LOCALES.flatMap((locale) =>
        SCORE_BUCKETS.map((bucket) => [variant.name, channel, locale, bucket, variant] as const),
      ),
    ),
  );

  it.each(cases)('%s · %s · %s · %s renders clean', (_name, channel, locale, bucket, variant) => {
    const params = variant.params(bucket);
    const rendered = renderAlertTemplate(request(variant.templateId, params, channel, locale));
    expect(lintAlert(rendered, lintContextFor(variant.templateId, params))).toEqual([]);
  });

  it.each(LOCALES)('the truncated push renders clean in %s', (locale) => {
    const params = escalationParams({}, 'unverified');
    const full = renderAlertTemplate(request('escalation.v1', params, 'push', locale));
    const area = fillCopy('line.area', locale, {
      area: formatAreaBothUnits(320, locale),
      source: 'EFFIS',
    });
    const agri = fillCopy('frozen.agriBurnTag', locale);
    const requiredOnly = full.body
      .split('\n')
      .filter((line) => line !== area && line !== agri)
      .join('\n');
    expect(requiredOnly).not.toBe(full.body);

    const rendered = renderAlertTemplate(request('escalation.v1', params, 'push', locale), {
      bodyMaxChars: { push: requiredOnly.length },
    });
    // Optional lines go whole; the required ones, the safety line among them, stay intact.
    expect(rendered.body).toBe(requiredOnly);
    expect(rendered.body).toContain(fillCopy('frozen.safetyNoTravel', locale));
    expect(lintAlert(rendered, lintContextFor('escalation.v1', params))).toEqual([]);
  });

  it('fails official_then_redetected when linted in own voice', () => {
    const params = escalationParams(OFFICIAL);
    for (const locale of LOCALES) {
      const rendered = renderAlertTemplate(request('escalation.v1', params, 'push', locale));
      const rules = lintAlert(rendered, { voice: 'own' }).map((violation) => violation.ruleId);
      expect(rules, locale).toContain('own-voice-extinguished');
    }
  });

  it('lints every other template in own voice', () => {
    expect(lintContextFor('new_fire.v1', eventParams())).toEqual({ voice: 'own' });
    expect(lintContextFor('escalation.v1', escalationParams({}))).toEqual({ voice: 'own' });
    expect(lintContextFor('escalation.v1', { junk: true })).toEqual({ voice: 'own' });
    expect(lintContextFor('escalation.v1', escalationParams(OFFICIAL))).toEqual({
      voice: 'quoted-official',
      quotedSource: {
        authority: 'ГДПБЗН',
        sourceUrl: 'https://www.gdpbzn.bg/',
        statementAt: '2026-08-10T09:00:00+03:00',
      },
    });
  });
});

describe('rendered content', () => {
  it('carries the mandatory lines and the LANCE clauses on every footer', () => {
    for (const variant of VARIANTS) {
      for (const locale of LOCALES) {
        const rendered = renderAlertTemplate(
          request(variant.templateId, variant.params('likely'), 'push', locale),
        );
        expect(rendered.body).toContain(fillCopy('frozen.safetyNoTravel', locale));
        expect(rendered.footer).toContain(ALERT_COPY['licence.lanceTactical'].text[locale]);
        expect(rendered.footer).toContain(ALERT_COPY['licence.lanceAsIs'].text[locale]);
        expect(rendered.footer).toContain('112');
      }
    }
  });

  it('renders the §3b string in place of the active line for official_then_redetected', () => {
    const rendered = renderAlertTemplate(
      request('escalation.v1', escalationParams(OFFICIAL), 'email', 'en'),
    );
    expect(rendered.body.split('\n')[0]).toBe(
      'New satellite detections on 12/08/2026, 14:05, after the fire was declared extinguished by authorities on 10/08/2026 — ГДПБЗН (https://www.gdpbzn.bg/). Both facts are shown as they stand.',
    );
    expect(rendered.body).not.toContain('Actively detected');
  });

  it('formats area in both units, дка first for Bulgarian', () => {
    expect(formatAreaBothUnits(320, 'en')).toBe('~320 ha (3,200 дка)');
    expect(formatAreaBothUnits(320, 'bg')).toBe('~3200 дка (320 ha)');
    expect(formatAreaBothUnits(3_249, 'bg').replaceAll(' ', ' ')).toBe('~32 000 дка (3200 ha)');
    expect(formatAreaBothUnits(0.374, 'en')).toBe('~0.37 ha (3.7 дка)');
  });

  it('formats distance to the precision a reader acts on', () => {
    expect(formatDistance(4.26, 'en')).toBe('~4.3 km');
    expect(formatDistance(4.26, 'bg')).toBe('~4,3 км');
    expect(formatDistance(23.6, 'en')).toBe('~24 km');
  });

  it('resolves locales by primary subtag', () => {
    expect(alertLocale('bg-BG')).toBe('bg');
    expect(alertLocale('EN_us')).toBe('en');
  });

  it('gives the digest no deep link and keeps event links off push', () => {
    const params = digestParams(2);
    expect(renderAlertTemplate(request('digest.v1', params, 'push')).url).toBeNull();
    expect(renderAlertTemplate(request('digest.v1', params, 'push')).body).not.toContain(
      'https://',
    );
    expect(renderAlertTemplate(request('digest.v1', params, 'telegram')).body).toContain(
      'https://firewatch.example/e/ev1',
    );
  });

  it('drops digest entries whole and counts them', () => {
    const rendered = renderAlertTemplate(request('digest.v1', digestParams(40), 'push', 'en'));
    expect(rendered.body.length).toBeLessThanOrEqual(BODY_MAX_CHARS.push ?? Infinity);
    expect(rendered.body).toMatch(/\+\d+ more in the app/u);
    expect(rendered.body).toContain('40');
  });

  it('throws rather than cut a required line', () => {
    expect(() =>
      renderAlertTemplate(request('digest.v1', digestParams(1), 'push'), {
        bodyMaxChars: { push: 10 },
      }),
    ).toThrow(/body limit/u);
  });

  it('registers a draft for every template id', () => {
    expect([...DRAFT_ALERT_TEMPLATES.keys()]).toEqual([...ALERT_TEMPLATE_IDS]);
  });
});
