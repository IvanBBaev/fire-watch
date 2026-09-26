/**
 * The privacy page and the layered disclaimers (TASKS I5).
 *
 * The page is server-rendered with preact-iso's `prerender` inside the real
 * {@link AppContext}, in both locales, and read back as visible text. What is held:
 * - layer order: draft notice, short summary, full notice, then the #disclaimer layer;
 * - the recipients and sources the notice must disclose are named;
 * - NASA LANCE's disclaimer appears verbatim from the credits registry, not retyped;
 * - the "not an official warning / call 112" layer is present;
 * - unreviewed copy is never presented as final: while any `privacy.*` or `disclaimer.*`
 *   path is in `PENDING_FOUNDER_REVIEW`, the draft notice is on the page — and the draft
 *   notice itself is pending, so it cannot be cleared before the text it qualifies;
 * - the short layers elsewhere (About, Settings) link to the page.
 */

import { describe, expect, it } from 'vitest';
import type { ComponentType } from 'preact';
import prerender from 'preact-iso/prerender';

import { CREDITS, renderCredit } from '@fire-watch/contracts';

import { DEFAULT_CONFIG } from '../../core/config.js';
import bg from '../../core/i18n/bg.js';
import { PENDING_FOUNDER_REVIEW } from '../../core/i18n/catalog-governance.js';
import en from '../../core/i18n/en.js';
import type { Messages } from '../../core/i18n/messages.js';
import type { Clock } from '../../core/ports.js';
import type { FireEventStore, Locale } from '../../core/types.js';
import { AppContext } from '../context.js';
import type { AppServices } from '../context.js';
import { creditRenderContext } from '../logic/credits.js';
import { AboutPage } from './about.js';
import { LANCE_DISCLAIMER_CREDIT_IDS, PrivacyPage } from './privacy.js';
import { SettingsPage } from './settings.js';

const NOW = Date.UTC(2026, 8, 23, 12);
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

/** Visible text, whitespace collapsed so a phrase is found regardless of markup. */
function textOf(html: string): string {
  return squash(decode(html.replace(/<[^>]*>/g, ' ')));
}

function hrefsOf(html: string): string[] {
  return [...html.matchAll(/\shref="([^"]*)"/g)].map((match) => decode(match[1] ?? ''));
}

describe.each(LOCALES)('privacy page (%s)', (locale) => {
  const messages = CATALOGS[locale];

  it('puts the draft notice first, then summary, full notice and the disclaimer layer', async () => {
    const html = await render(PrivacyPage, locale);
    const positions = [
      html.indexOf('privacy-draft-notice'),
      html.indexOf('id="privacy-summary"'),
      html.indexOf('id="privacy-full"'),
      html.indexOf('id="disclaimer"'),
    ];
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });

  it('renders every catalog paragraph', async () => {
    const text = textOf(await render(PrivacyPage, locale));
    const { privacy, disclaimer } = messages;
    const sections = [
      privacy.controller,
      privacy.data,
      privacy.legalBases,
      privacy.recipients,
      privacy.sources,
      privacy.transfers,
      privacy.retention,
      privacy.rights,
    ];
    const expected = [
      privacy.title,
      privacy.draftNotice,
      privacy.summaryTitle,
      ...privacy.summary,
      privacy.fullNoticeTitle,
      ...sections.flatMap((section) => [section.title, ...section.paragraphs]),
      disclaimer.title,
      ...disclaimer.paragraphs,
      disclaimer.lanceIntro,
    ];
    for (const line of expected) {
      expect(text).toContain(squash(line));
    }
  });

  it('discloses the recipients and names the data sources', () => {
    const recipients = messages.privacy.recipients.paragraphs.join(' ');
    for (const name of ['Cloudflare', 'R2', 'Esri', 'AWS', 'OpenFreeMap', 'Telegram']) {
      expect(recipients).toContain(name);
    }
    const sources = messages.privacy.sources.paragraphs.join(' ');
    for (const name of ['NASA', 'LANCE', 'EUMETSAT', 'Copernicus']) {
      expect(sources).toContain(name);
    }
  });

  it('says it is not an official warning and points to 112', async () => {
    const text = textOf(await render(PrivacyPage, locale));
    expect(text).toContain('112');
    expect(text).toContain('BG-ALERT');
    expect(messages.disclaimer.alertsNote).toContain('112');
  });

  it("carries NASA LANCE's disclaimer verbatim from the credits registry", async () => {
    const text = textOf(await render(PrivacyPage, locale));
    const context = creditRenderContext(clock, messages);
    for (const id of LANCE_DISCLAIMER_CREDIT_IDS) {
      const credit = CREDITS.find((candidate) => candidate.id === id);
      expect(credit, id).toBeDefined();
      if (credit === undefined) continue;
      expect(text).toContain(squash(renderCredit(credit, context)));
    }
  });

  it('keeps the draft notice on the page while its copy is pending review', async () => {
    const pending = (PENDING_FOUNDER_REVIEW as readonly string[]).filter(
      (path) => path.startsWith('privacy.') || path.startsWith('disclaimer.'),
    );
    // The notice is itself pending: it cannot be cleared before the text it qualifies.
    expect(pending).toContain('privacy.draftNotice');
    const text = textOf(await render(PrivacyPage, locale));
    expect(text).toContain(squash(messages.privacy.draftNotice));
  });

  it.each([
    ['About', AboutPage],
    ['Settings', SettingsPage],
  ] as const)('links the short layer on %s to the page', async (_name, Page) => {
    const html = await render(Page, locale);
    expect(hrefsOf(html).some((href) => href.startsWith('/privacy'))).toBe(true);
    expect(textOf(html)).toContain(squash(messages.disclaimer.linkLabel));
  });
});
