/**
 * TASKS F6 — the Open Graph / Twitter meta of an event permalink: title from the catalog,
 * and a description that carries the observation stamp as an absolute Europe/Sofia date
 * and time (a link preview is read long after it was fetched, 07 §5.2.2).
 */

import { describe, expect, it } from 'vitest';

import bg from '../../core/i18n/bg.js';
import en from '../../core/i18n/en.js';
import type { FireEvent } from '../../core/types.js';
import { shareMetaFor, type MetaTag } from './share-meta.js';

const EVENT: FireEvent = {
  id: 'fw-2026-q7f3d',
  seq: 4,
  status: 'no_longer_detected',
  scoreBucket: 'confirmed',
  mergedInto: null,
  lon: 25.9,
  lat: 41.9,
  firstObservedAt: '2026-08-09T08:02:00Z',
  // 11:14 UTC is 14:14 in Sofia (EEST, UTC+3).
  lastObservedAt: '2026-08-09T11:14:00Z',
  detectionCount: 7,
  placeNameBg: 'Сакар',
  placeNameEn: 'Sakar',
  areaHa: null,
  nextPassWindow: null,
};

const URL_ = 'https://firewatch.example/event/fw-2026-q7f3d';

function content(tags: readonly MetaTag[], key: string): string | undefined {
  return tags.find((tag) => tag.key === key)?.content;
}

describe('shareMetaFor', () => {
  it('describes the event in English with the Sofia observation stamp', () => {
    const tags = shareMetaFor({ event: EVENT, messages: en, locale: 'en', permalinkUrl: URL_ });

    expect(content(tags, 'og:title')).toBe(en.eventNearPlace('Sakar'));
    expect(content(tags, 'og:site_name')).toBe(en.appTitle);
    expect(content(tags, 'og:locale')).toBe('en_GB');
    expect(content(tags, 'og:url')).toBe(URL_);
    expect(content(tags, 'og:type')).toBe('website');
    const description = content(tags, 'og:description') ?? '';
    expect(description).toContain(en.tierLabel.confirmed);
    expect(description).toContain(en.statusShort.no_longer_detected);
    expect(description).toContain(en.shareCard.observedAt('09/08/2026, 14:14'));
  });

  it('describes the event in Bulgarian with the Sofia observation stamp', () => {
    const tags = shareMetaFor({ event: EVENT, messages: bg, locale: 'bg', permalinkUrl: URL_ });

    expect(content(tags, 'og:title')).toBe(bg.eventNearPlace('Сакар'));
    expect(content(tags, 'og:locale')).toBe('bg_BG');
    expect(content(tags, 'og:description')).toContain('09.08.2026');
    expect(content(tags, 'og:description')).toContain('14:14');
  });

  it('mirrors title and description into Twitter tags, as a summary card with no image', () => {
    const tags = shareMetaFor({ event: EVENT, messages: en, locale: 'en', permalinkUrl: URL_ });

    expect(content(tags, 'twitter:card')).toBe('summary');
    expect(content(tags, 'twitter:title')).toBe(content(tags, 'og:title'));
    expect(content(tags, 'twitter:description')).toBe(content(tags, 'og:description'));
    // No image URL exists yet (the raster endpoint is an open decision) — none is invented.
    expect(tags.some((tag) => tag.key.endsWith(':image'))).toBe(false);
  });

  it('uses the right attribute per vocabulary and names each tag once', () => {
    const tags = shareMetaFor({ event: EVENT, messages: en, locale: 'en', permalinkUrl: URL_ });

    for (const tag of tags) {
      expect(tag.attribute).toBe(tag.key.startsWith('og:') ? 'property' : 'name');
    }
    expect(new Set(tags.map((tag) => tag.key)).size).toBe(tags.length);
  });

  it('is pure: the same event gives the same tags', () => {
    const input = { event: EVENT, messages: en, locale: 'en', permalinkUrl: URL_ } as const;

    expect(shareMetaFor(input)).toEqual(shareMetaFor(input));
  });
});
