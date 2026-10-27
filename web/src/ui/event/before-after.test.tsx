/**
 * The V2-E2 before/after comparison, rendered through the real component and the real
 * catalogs: the dates it names, the slider's accessible name and value, the registry
 * credit, and what it must never say (that either image is clear of cloud).
 */

import { CREDITS, renderCredit } from '@fire-watch/contracts';
import prerender from 'preact-iso/prerender';
import { describe, expect, it } from 'vitest';

import { DEFAULT_CONFIG } from '../../core/config.js';
import { formatDateSofia } from '../../core/i18n/format.js';
import bg from '../../core/i18n/bg.js';
import en from '../../core/i18n/en.js';
import type { Messages } from '../../core/i18n/messages.js';
import type { FireEventStore, Locale } from '../../core/types.js';
import { AppContext } from '../context.js';
import type { AppServices } from '../context.js';
import { creditRenderContext } from '../logic/credits.js';
import { BeforeAfter } from './before-after.js';
import type { BeforeAfterProps } from './before-after.js';

const NOW_MS = Date.parse('2026-08-20T12:00:00Z');
const clock = { epochNow: () => NOW_MS, monotonicNow: () => 0 };

const CLOSED: BeforeAfterProps['event'] = {
  id: 'fw-2026-k9s2r',
  lon: 25.6,
  lat: 42.4,
  firstObservedAt: '2026-08-03T11:20:00Z',
  lastObservedAt: '2026-08-06T10:50:00Z',
};

const CATALOGS = { en, bg } as const satisfies Record<Locale, Messages>;

function services(locale: Locale): AppServices {
  return {
    store: {} as FireEventStore,
    clock,
    serverNow: () => NOW_MS,
    config: DEFAULT_CONFIG,
    geolocator: { locate: () => Promise.reject(new Error('not asked')) },
    locale,
    messages: CATALOGS[locale],
    setLocale: () => {},
  };
}

async function render(
  event: BeforeAfterProps['event'],
  locale: Locale = 'en',
  nowMs: number = NOW_MS,
): Promise<string> {
  const { html } = await prerender(
    <AppContext.Provider value={services(locale)}>
      <BeforeAfter event={event} nowMs={nowMs} onClose={() => {}} />
    </AppContext.Provider>,
  );
  return html.replace(/<script[\s\S]*?<\/script>/g, '');
}

const tileUrls = (html: string): string[] =>
  [...html.matchAll(/src="([^"]*)"/g)].map((match) => match[1] ?? '');

/** A UTC day worded as the reader's date. */
const day = (utcDay: string, locale: Locale): string =>
  formatDateSofia(`${utcDay}T12:00:00Z`, locale);

const GIBS_CREDIT = CREDITS.find((credit) => credit.id === 'gibs-short');

describe('BeforeAfter', () => {
  it.each(['en', 'bg'] as const)('names both days and what the imagery is (%s)', async (locale) => {
    const t = CATALOGS[locale].beforeAfter;
    const html = await render(CLOSED, locale);
    const before = day('2026-08-02', locale);
    const after = day('2026-08-07', locale);
    expect(html).toContain(t.title);
    expect(html).toContain(t.beforeLabel(before));
    expect(html).toContain(t.afterLabel(after));
    expect(html).toContain(t.note);
    expect(html).toContain(`aria-label="${t.imageLabel(before, after)}"`);
    expect(html).toContain('role="img"');
  });

  it.each(['en', 'bg'] as const)(
    'the divider is a labelled range input the arrow keys move (%s)',
    async (locale) => {
      const t = CATALOGS[locale].beforeAfter;
      const html = await render(CLOSED, locale);
      expect(html).toMatch(/<input[^>]*type="range"/);
      expect(html).toContain(`aria-label="${t.sliderLabel}"`);
      expect(html).toContain(`aria-valuetext="${t.sliderValue(50)}"`);
      expect(html).toContain('value="50"');
      expect(html).toContain(`aria-label="${t.beforeEarlier}"`);
      expect(html).toContain(`aria-label="${t.afterLater}"`);
      expect(html).toContain(`>${t.close}</button>`);
    },
  );

  it.each(['en', 'bg'] as const)(
    'carries the NASA GIBS credit from the registry (%s)',
    async (locale) => {
      expect(GIBS_CREDIT).toBeDefined();
      if (GIBS_CREDIT === undefined) return;
      const html = await render(CLOSED, locale);
      expect(html).toContain(
        renderCredit(GIBS_CREDIT, creditRenderContext(clock, CATALOGS[locale])),
      );
      expect(html).toContain('NASA GIBS / EOSDIS');
      expect(html).toContain(`href="${GIBS_CREDIT.href ?? ''}"`);
      expect(html).toContain('rel="noopener noreferrer"');
    },
  );

  it('draws GIBS true-colour tiles of both days, sending no referrer', async () => {
    const urls = tileUrls(await render(CLOSED));
    expect(urls.length).toBeGreaterThan(0);
    expect(
      urls.every((url) =>
        url.startsWith(
          'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/VIIRS_SNPP_CorrectedReflectance_TrueColor/default/',
        ),
      ),
    ).toBe(true);
    expect(urls.some((url) => url.includes('/2026-08-02/'))).toBe(true);
    expect(urls.some((url) => url.includes('/2026-08-07/'))).toBe(true);
    const html = await render(CLOSED);
    expect(html).toContain('referrerpolicy="no-referrer"');
  });

  it.each(['en', 'bg'] as const)(
    'an active event: "after" is the newest day, said not to be after the fire (%s)',
    async (locale) => {
      const t = CATALOGS[locale].beforeAfter;
      const html = await render(
        {
          ...CLOSED,
          firstObservedAt: '2026-08-17T11:00:00Z',
          lastObservedAt: '2026-08-20T11:00:00Z',
        },
        locale,
      );
      const latest = day('2026-08-19', locale);
      expect(html).toContain(t.afterLatestLabel(latest));
      expect(html).not.toContain(t.afterLabel(latest));
    },
  );

  it.each(['en', 'bg'] as const)(
    'says so when no day before the first detection is available yet (%s)',
    async (locale) => {
      const t = CATALOGS[locale].beforeAfter;
      const html = await render(
        {
          ...CLOSED,
          firstObservedAt: '2026-08-20T10:00:00Z',
          lastObservedAt: '2026-08-20T10:00:00Z',
        },
        locale,
      );
      expect(html).toContain(t.unavailable);
      expect(tileUrls(html)).toEqual([]);
      expect(html).not.toContain('type="range"');
      // The credit still names the source the panel would draw from.
      expect(html).toContain('NASA GIBS / EOSDIS');
    },
  );

  it('never claims either image is clear', () => {
    for (const locale of ['en', 'bg'] as const) {
      const text = JSON.stringify(
        Object.values(CATALOGS[locale].beforeAfter).map((value) =>
          typeof value === 'function' ? (value as (...a: string[]) => string)('D1', 'D2') : value,
        ),
      ).toLowerCase();
      expect(text).not.toMatch(/cloud-free|cloudless|clear sky|clear image|без облаци|безоблач/);
    }
  });
});
