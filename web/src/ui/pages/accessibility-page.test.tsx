/**
 * The accessibility statement (TASKS L16; GATES.md §3 L-16; review 19 §5.10.1).
 *
 * Server-rendered with preact-iso's `prerender` inside the real {@link AppContext}, in both
 * locales, and read back as visible text, like `privacy-page.test.tsx`. What is held:
 * - the draft notice comes first, then the sections in the order review 19 §5.10.1 lists
 *   (target, scope, alternative, known gaps, testing, legal position, contact);
 * - every catalog line renders;
 * - the statement names its target, the three scope classes, the alternative to the map,
 *   the legal basis it claims and the emergency number;
 * - unreviewed copy is never presented as final: while any `accessibility.*` path is in
 *   `PENDING_FOUNDER_REVIEW`, the draft notice is on the page, and the notice is itself
 *   pending so it cannot be cleared before the text it qualifies;
 * - the About page links to it.
 */

import { describe, expect, it } from 'vitest';
import type { ComponentType } from 'preact';
import prerender from 'preact-iso/prerender';

import { DEFAULT_CONFIG } from '../../core/config.js';
import bg from '../../core/i18n/bg.js';
import { PENDING_FOUNDER_REVIEW } from '../../core/i18n/catalog-governance.js';
import en from '../../core/i18n/en.js';
import type { Messages } from '../../core/i18n/messages.js';
import type { Clock } from '../../core/ports.js';
import type { FireEventStore, Locale } from '../../core/types.js';
import { AppContext } from '../context.js';
import type { AppServices } from '../context.js';
import { ROUTES } from '../logic/routes.js';
import { AboutPage } from './about.js';
import { AccessibilityPage } from './accessibility.js';

const NOW = Date.UTC(2026, 9, 22, 12);
const CATALOGS = { bg, en } as const satisfies Record<Locale, Messages>;
const LOCALES = Object.keys(CATALOGS) as Locale[];
const clock: Clock = { epochNow: () => NOW, monotonicNow: () => 0 };

const store: FireEventStore = {
  state: () => {
    throw new Error('these pages must not read the store');
  },
  subscribe: () => () => {},
  dispatch: () => {},
  setFeedStatus: () => {},
  acknowledgeSnapshotNeed: () => {},
};

function services(locale: Locale): AppServices {
  return {
    store,
    clock,
    serverNow: () => NOW,
    config: DEFAULT_CONFIG,
    geolocator: { locate: () => Promise.reject(new Error('not asked')) },
    locale,
    messages: CATALOGS[locale],
    setLocale: () => {},
  };
}

const ENTITIES: Readonly<Record<string, string>> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&#x27;': "'",
  '&nbsp;': ' ',
};

function decode(value: string): string {
  return value.replace(/&(?:amp|lt|gt|quot|#39|#x27|nbsp);/g, (entity) => ENTITIES[entity] ?? '');
}

async function render(Page: ComponentType, locale: Locale): Promise<string> {
  const { html } = await prerender(
    <AppContext.Provider value={services(locale)}>
      <Page />
    </AppContext.Provider>,
  );
  return html;
}

const squash = (value: string): string => value.replace(/\s+/g, ' ').trim();

function textOf(html: string): string {
  return squash(decode(html.replace(/<[^>]*>/g, ' ')));
}

function hrefsOf(html: string): string[] {
  return [...html.matchAll(/\shref="([^"]*)"/g)].map((match) => decode(match[1] ?? ''));
}

/** Section anchors in the order review 19 §5.10.1 lists the statement's contents. */
const SECTION_IDS = [
  'accessibility-target',
  'accessibility-scope',
  'accessibility-alternative',
  'accessibility-known-gaps',
  'accessibility-testing',
  'accessibility-legal',
  'accessibility-contact',
] as const;

it('serves the statement on a panel route', () => {
  expect(ROUTES.find((route) => route.id === 'accessibility')).toMatchObject({
    path: '/accessibility',
    surface: 'panel',
  });
});

describe.each(LOCALES)('accessibility statement (%s)', (locale) => {
  const { accessibility } = CATALOGS[locale];

  it('puts the draft notice first, then the sections in order', async () => {
    const html = await render(AccessibilityPage, locale);
    const positions = [
      html.indexOf('accessibility-draft-notice'),
      ...SECTION_IDS.map((id) => html.indexOf(`id="${id}"`)),
    ];
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    expect(html).toMatch(/class="accessibility-draft-notice" role="note"/);
  });

  it('renders every catalog line', async () => {
    const text = textOf(await render(AccessibilityPage, locale));
    const sections = [
      accessibility.target,
      accessibility.scope,
      accessibility.alternative,
      accessibility.knownGaps,
      accessibility.testing,
      accessibility.legal,
      accessibility.contact,
    ];
    const expected = [
      accessibility.title,
      accessibility.draftNotice,
      accessibility.dated,
      ...sections.flatMap((section) => [section.title, ...section.paragraphs]),
    ];
    for (const line of expected) expect(text).toContain(squash(line));
  });

  it('states the target, the three scope classes, the legal basis and the date', () => {
    expect(accessibility.target.paragraphs.join(' ')).toMatch(/\(WCAG\) 2\.2/);
    expect(accessibility.target.paragraphs.join(' ')).toContain('EN 301 549');
    // Review 19 §5.2: in scope, exempt-with-alternative, out of scope — one paragraph each.
    expect(accessibility.scope.paragraphs).toHaveLength(3);
    expect(accessibility.legal.paragraphs.join(' ')).toContain('2019/882');
    expect(accessibility.dated).toMatch(/2026/);
    expect(accessibility.contact.paragraphs.join(' ')).toContain('112');
  });

  it('keeps the draft notice on the page while its copy is pending review', async () => {
    const pending = (PENDING_FOUNDER_REVIEW as readonly string[]).filter((path) =>
      path.startsWith('accessibility.'),
    );
    expect(pending).toContain('accessibility.draftNotice');
    const text = textOf(await render(AccessibilityPage, locale));
    expect(text).toContain(squash(accessibility.draftNotice));
  });

  it('is linked from the About page', async () => {
    const html = await render(AboutPage, locale);
    expect(hrefsOf(html)).toContain('/accessibility');
    expect(textOf(html)).toContain(squash(accessibility.linkLabel));
  });
});
