/**
 * TASKS F6 — the share card carries the observation timestamp, baked in, as an absolute
 * Europe/Sofia date and time (WP4; 07-product-ux §5.2.2), and renders deterministically.
 *
 * The expected stamps below are written out by hand rather than computed with the
 * formatter under test, so a regression in the time-zone handling cannot agree with
 * itself. Summer is UTC+3 (EEST), winter UTC+2 (EET).
 */

import { describe, expect, it } from 'vitest';

import { parseColor } from '../../core/color/color.js';
import bg from '../../core/i18n/bg.js';
import en from '../../core/i18n/en.js';
import type { Messages } from '../../core/i18n/messages.js';
import type { FireEvent, Locale } from '../../core/types.js';
import { isFireHue } from '../../map/style-colors.js';
import {
  SHARE_CARD_HEIGHT,
  SHARE_CARD_WIDTH,
  buildShareCard,
  escapeXml,
  layoutShareCard,
  renderShareCardSvg,
  wrapText,
  type ShareCardInput,
} from './share-card.js';

/** How the card glues a stamp together so it never wraps mid-stamp. */
function unbroken(stamp: string): string {
  return stamp.replaceAll(' ', '\u00a0');
}

/** The text of each `<text>` element in an SVG, unescaped enough for these tests. */
function svgLines(svg: string): readonly string[] {
  return [...svg.matchAll(/<text [^>]*>([^<]*)<\/text>/gu)].map((m) => m[1] ?? '');
}

const CATALOGS: Readonly<Record<Locale, Messages>> = { bg, en };

/** 11:14 UTC on 9 August 2026 is 14:14 in Sofia (EEST, UTC+3). */
const SUMMER_OBSERVED = '2026-08-09T11:14:00Z';
/** 22:30 UTC on 15 January 2026 is 00:30 on the 16th in Sofia (EET, UTC+2). */
const WINTER_OBSERVED = '2026-01-15T22:30:00Z';
/** The card is made 40 minutes after the summer observation: 14:54 Sofia. */
const MADE_AT_MS = Date.parse('2026-08-09T11:54:00Z');

function makeEvent(overrides: Partial<FireEvent> = {}): FireEvent {
  return {
    id: 'fw-2026-q7f3d',
    seq: 4,
    status: 'active',
    scoreBucket: 'likely',
    mergedInto: null,
    lon: 25.9,
    lat: 41.9,
    firstObservedAt: '2026-08-09T08:02:00Z',
    lastObservedAt: SUMMER_OBSERVED,
    detectionCount: 7,
    placeNameBg: 'Сакар',
    placeNameEn: 'Sakar',
    areaHa: 12.5,
    nextPassWindow: null,
    ...overrides,
  };
}

function inputFor(locale: Locale, overrides: Partial<ShareCardInput> = {}): ShareCardInput {
  return {
    event: makeEvent(),
    messages: CATALOGS[locale],
    locale,
    nowMs: MADE_AT_MS,
    staleSinceIso: null,
    permalinkUrl: 'https://firewatch.example/event/fw-2026-q7f3d',
    ...overrides,
  };
}

function svgFor(locale: Locale, overrides: Partial<ShareCardInput> = {}): string {
  return renderShareCardSvg(buildShareCard(inputFor(locale, overrides))).svg;
}

function textOf(locale: Locale, overrides: Partial<ShareCardInput> = {}): string {
  return buildShareCard(inputFor(locale, overrides))
    .blocks.map((block) => block.text)
    .join('\n');
}

describe('buildShareCard — the observation stamp', () => {
  it.each([
    ['bg', '09.08.2026', '14:14'],
    ['en', '09/08/2026', '14:14'],
  ] as const)('bakes the Sofia date and time into the %s card', (locale, date, time) => {
    const card = buildShareCard(inputFor(locale));

    expect(card.observedStamp).toContain(date);
    expect(card.observedStamp).toContain(time);
    const observed = card.blocks.find((block) => block.role === 'observed');
    expect(observed?.text).toBe(
      CATALOGS[locale].shareCard.observedAt(unbroken(card.observedStamp)),
    );
    // Second in reading order, straight under the title.
    expect(card.blocks.map((block) => block.role).slice(0, 2)).toEqual(['title', 'observed']);
  });

  it.each([
    ['bg', '16.01.2026', '00:30'],
    ['en', '16/01/2026', '00:30'],
  ] as const)(
    'uses winter time (UTC+2) and the Sofia date across midnight (%s)',
    (locale, date, time) => {
      const card = buildShareCard(
        inputFor(locale, { event: makeEvent({ lastObservedAt: WINTER_OBSERVED }) }),
      );

      expect(card.observedStamp).toContain(date);
      expect(card.observedStamp).toContain(time);
      expect(card.observedStamp).not.toContain('15.01');
      expect(card.observedStamp).not.toContain('15/01');
    },
  );

  it('gives the active lifecycle line the full stamp, not the bare time the page may show', () => {
    const lifecycle = buildShareCard(inputFor('en')).blocks.find((b) => b.role === 'lifecycle');

    expect(lifecycle?.text).toContain('09/08/2026');
    expect(lifecycle?.text).toContain('14:14');
  });

  it('says when the image was made, in Sofia time', () => {
    const madeAt = buildShareCard(inputFor('bg')).blocks.find((b) => b.role === 'madeAt');

    expect(madeAt?.text).toContain('09.08.2026');
    expect(madeAt?.text).toContain('14:54');
  });

  it('bakes in no relative age', () => {
    for (const locale of ['bg', 'en'] as const) {
      // The frozen disclaimer names a latency range ("15 min–3 h old"), which is a property
      // of the data, not an age of this event; every other block is checked.
      const text = buildShareCard(inputFor(locale))
        .blocks.filter((block) => block.role !== 'disclaimer')
        .map((block) => block.text)
        .join('\n');
      expect(text).not.toMatch(/\bago\b|преди|\bmin\b|мин\./u);
    }
  });
});

describe('buildShareCard — content', () => {
  it('carries the title, tier, facts, safety line, disclaimer and permalink from the catalog', () => {
    const card = buildShareCard(inputFor('en'));
    const text = card.blocks.map((block) => block.text).join('\n');

    expect(card.brand).toBe(en.appTitle);
    expect(card.tier).toBe(`${en.satelliteDetected} · ${en.tierLabel.likely}`);
    expect(text).toContain(en.eventNearPlace('Sakar'));
    expect(text).toContain(en.areaBothUnits(12.5));
    expect(text).toContain(en.detectionCount(7));
    expect(text).toContain(en.safetyNoTravel);
    expect(text).toContain(en.emergencyLine);
    expect(text).toContain(en.panelFooterDisclaimer);
    expect(card.blocks.at(-1)).toEqual({
      role: 'permalink',
      text: 'firewatch.example/event/fw-2026-q7f3d',
    });
  });

  it('uses the place name of the card locale', () => {
    expect(textOf('bg')).toContain(bg.eventNearPlace('Сакар'));
  });

  it('omits the area when there is none', () => {
    const card = buildShareCard(inputFor('en', { event: makeEvent({ areaHa: null }) }));

    expect(card.blocks.find((b) => b.role === 'facts')?.text).toBe(en.detectionCount(7));
  });

  it('adds the unverified note only for an unverified event', () => {
    const roles = (scoreBucket: FireEvent['scoreBucket']): readonly string[] =>
      buildShareCard(inputFor('en', { event: makeEvent({ scoreBucket }) })).blocks.map(
        (block) => block.role,
      );

    expect(roles('unverified')).toContain('note');
    expect(roles('likely')).not.toContain('note');
    expect(textOf('en', { event: makeEvent({ scoreBucket: 'unverified' }) })).toContain(
      en.unverifiedNote,
    );
  });

  it('carries the stale-data banner, with its absolute stamp, when data is delayed', () => {
    const staleSinceIso = '2026-08-09T10:30:00Z'; // 13:30 Sofia
    const card = buildShareCard(inputFor('en', { staleSinceIso }));
    const stale = card.blocks.find((block) => block.role === 'stale');

    expect(stale?.text).toBe(en.status.staleSources(unbroken('09/08/2026, 13:30')));
    expect(buildShareCard(inputFor('en')).blocks.some((b) => b.role === 'stale')).toBe(false);
  });
});

describe('renderShareCardSvg', () => {
  it.each(['bg', 'en'] as const)('renders the observation stamp into the %s SVG', (locale) => {
    const card = buildShareCard(inputFor(locale));
    const { svg, width, height } = renderShareCardSvg(card);

    // The whole stamp sits on one drawn line — never split between date and time.
    const stampLine = svgLines(svg).find((line) => line.includes(unbroken(card.observedStamp)));
    expect(stampLine).toBeDefined();
    expect(stampLine).toMatch(locale === 'bg' ? /09\.08\.2026.*14:14/u : /09\/08\/2026.*14:14/u);
    // And every word of the observed line is drawn, in order.
    const observed = CATALOGS[locale].shareCard.observedAt(unbroken(card.observedStamp));
    expect(svgLines(svg).join(' ')).toContain(escapeXml(observed));
    expect(svg).toMatch(/^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" /u);
    expect(svg).toContain(`xml:lang="${locale}"`);
    expect(svg.endsWith('</svg>')).toBe(true);
    expect([width, height]).toEqual([SHARE_CARD_WIDTH, SHARE_CARD_HEIGHT]);
  });

  it('is deterministic: the same input renders to the same bytes', () => {
    expect(svgFor('bg')).toBe(svgFor('bg'));
    expect(svgFor('en', { staleSinceIso: '2026-08-09T10:30:00Z' })).toBe(
      svgFor('en', { staleSinceIso: '2026-08-09T10:30:00Z' }),
    );
  });

  it('changes when, and only when, what it says changes', () => {
    const later = makeEvent({ lastObservedAt: '2026-08-09T12:20:00Z' });

    expect(svgFor('en', { event: later })).not.toBe(svgFor('en'));
    expect(svgFor('en', { event: later })).toContain('15:20');
  });

  it('escapes place names and URLs as data, not markup', () => {
    const event = makeEvent({ placeNameEn: `<b>"Tom" & Jerry's</b>` });
    const svg = svgFor('en', { event, permalinkUrl: 'https://x.example/event/a?b=1&c=2' });

    expect(svg).not.toContain('<b>');
    expect(svg).toContain('&lt;b&gt;&quot;Tom&quot; &amp; Jerry&apos;s&lt;/b&gt;');
    expect(svg).toContain('x.example/event/a?b=1&amp;c=2');
    expect(escapeXml(`<&>"'`)).toBe('&lt;&amp;&gt;&quot;&apos;');
  });

  it('references nothing external — no href, no url(), no font download', () => {
    const svg = svgFor('en', { staleSinceIso: '2026-08-09T10:30:00Z' });

    expect(svg).not.toMatch(/href|url\(|@import|@font-face|<image/u);
  });

  it('paints no colour in the red band fire owns (CI-14)', () => {
    const svg = svgFor('en', {
      staleSinceIso: '2026-08-09T10:30:00Z',
      event: makeEvent({ scoreBucket: 'unverified' }),
    });
    const colours = [...svg.matchAll(/(?:fill|stroke)="(#[0-9a-f]{6})"/gu)].map((m) => m[1] ?? '');

    expect(colours.length).toBeGreaterThan(0);
    expect(colours.filter((colour) => isFireHue(parseColor(colour)))).toEqual([]);
  });

  it('draws the stale banner box only when the card is stale', () => {
    expect(svgFor('en', { staleSinceIso: '2026-08-09T10:30:00Z' })).toContain('rx="8"');
    expect(svgFor('en')).not.toContain('rx="8"');
  });

  it('keeps every line inside the frame at the OG size', () => {
    for (const locale of ['bg', 'en'] as const) {
      const layout = layoutShareCard(
        buildShareCard(
          inputFor(locale, {
            staleSinceIso: '2026-08-09T10:30:00Z',
            event: makeEvent({ scoreBucket: 'unverified' }),
          }),
        ),
      );
      for (const line of layout.lines) expect(line.baseline).toBeLessThan(layout.height);
    }
  });

  it('grows taller rather than truncating copy that cannot fit', () => {
    const longName = Array.from({ length: 60 }, () => 'Verylongplacename').join(' ');
    const card = buildShareCard(inputFor('en', { event: makeEvent({ placeNameEn: longName }) }));
    const image = renderShareCardSvg(card);
    const layout = layoutShareCard(card);

    expect(image.height).toBeGreaterThan(SHARE_CARD_HEIGHT);
    expect(image.width).toBe(SHARE_CARD_WIDTH);
    // Every word of every block is still on the card.
    const drawn = layout.lines.map((line) => line.text).join(' ');
    for (const block of card.blocks) {
      for (const word of block.text.split(/\s+/u)) expect(drawn).toContain(word);
    }
    for (const line of layout.lines) expect(line.baseline).toBeLessThan(image.height);
  });
});

describe('wrapText', () => {
  it('wraps greedily at word boundaries', () => {
    expect(wrapText('one two three four', 9)).toEqual(['one two', 'three', 'four']);
  });

  it('breaks a word longer than a line rather than letting it overflow', () => {
    expect(wrapText('ab abcdefghij c', 4)).toEqual(['ab', 'abcd', 'efgh', 'ij c']);
  });

  it('counts code points, so Cyrillic wraps by characters, not bytes', () => {
    expect(wrapText('Сакар Сакар', 5)).toEqual(['Сакар', 'Сакар']);
  });

  it('collapses whitespace and returns nothing for empty text', () => {
    expect(wrapText('  a \n  b  ', 10)).toEqual(['a b']);
    expect(wrapText('', 10)).toEqual([]);
  });
});
