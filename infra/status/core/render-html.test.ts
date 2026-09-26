import { describe, expect, it } from 'vitest';

import type { Notice } from './notices.js';
import { escapeHtml, formatAge, formatUtc, renderPage, type RenderOptions } from './render-html.js';
import type { StatusModel } from './status-model.js';
import { CATALOG } from './strings.js';

const model: StatusModel = {
  schema: 'fire-watch-status/1',
  generatedAt: '2026-09-25T12:00:00.000Z',
  overall: 'degraded',
  components: [
    {
      id: 'api',
      level: 'operational',
      reason: 'up',
      ageSeconds: null,
      dataGeneratedAt: null,
      since: '2026-09-25T11:00:00.000Z',
      unconfirmed: false,
    },
    {
      id: 'map',
      level: 'degraded',
      reason: 'stale',
      ageSeconds: 420,
      dataGeneratedAt: '2026-09-25T11:53:00.000Z',
      since: '2026-09-25T11:58:00.000Z',
      unconfirmed: true,
    },
    {
      id: 'map-backup',
      level: 'unknown',
      reason: 'not_configured',
      ageSeconds: null,
      dataGeneratedAt: null,
      since: '2026-09-25T12:00:00.000Z',
      unconfirmed: false,
    },
    {
      id: 'data-freshness',
      level: 'operational',
      reason: 'report_ok',
      ageSeconds: null,
      dataGeneratedAt: null,
      since: '2026-09-25T10:00:00.000Z',
      unconfirmed: false,
    },
  ],
  sources: [
    {
      row: 'lsasaf:seviri:frp-pixel',
      level: 'muted',
      ageSeconds: 3600,
      lastSuccessAt: '2026-09-25T11:00:00.000Z',
      mutedUntil: '2026-09-26T00:00:00Z',
      muteReason: 'Provider <script>alert(1)</script> maintenance',
    },
    {
      row: 'future:feed',
      level: 'on_time',
      ageSeconds: 30,
      lastSuccessAt: '2026-09-25T11:59:30.000Z',
      mutedUntil: null,
      muteReason: null,
    },
  ],
  budgetVersion: 'v1',
};

const notice: Notice = {
  id: 'map-delay',
  kind: 'incident',
  startedAt: '2026-09-25T11:50:00Z',
  resolvedAt: null,
  en: 'Map updates are delayed & we are on it.',
  bg: 'Обновяването на картата закъснява "временно".',
  postmortemUrl: null,
};

const options = (overrides: Partial<RenderOptions> = {}): RenderOptions => ({
  model,
  notices: [notice],
  locale: 'en',
  otherLocaleHref: 'index.html',
  staleAfterMinutes: 45,
  announceChannel: null,
  refreshSeconds: 300,
  ...overrides,
});

describe('helpers', () => {
  it('escapes the five HTML metacharacters', () => {
    expect(escapeHtml(`<a href="x">'&'</a>`)).toBe(
      '&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;',
    );
  });

  it('formats instants in UTC and ages in readable units', () => {
    expect(formatUtc('2026-09-25T14:05:59+03:00')).toBe('2026-09-25 11:05 UTC');
    expect(formatUtc('not a date')).toBe('not a date');
    expect(formatAge(42, CATALOG.en)).toBe('42 s');
    expect(formatAge(420, CATALOG.en)).toBe('7 min');
    expect(formatAge(3 * 3600 + 5 * 60, CATALOG.en)).toBe('3 h 5 min');
    expect(formatAge(-5, CATALOG.bg)).toBe('0 сек');
  });
});

describe('renderPage', () => {
  it('is a complete, self-contained document in the requested language', () => {
    const html = renderPage(options());
    expect(html.startsWith('<!doctype html>\n<html lang="en"')).toBe(true);
    expect(html).toContain('data-generated-at="2026-09-25T12:00:00.000Z"');
    expect(html).toContain('data-stale-after-minutes="45"');
    expect(html).toContain('<meta http-equiv="refresh" content="300">');
    expect(html).toContain('<meta name="robots" content="noindex">');
    expect(html).toContain('hreflang="bg" href="index.html"');
    // No external resource of any kind.
    expect(html).not.toMatch(/<link[^>]+stylesheet|<script[^>]+src=|<img|@import|url\(/);
    expect(html).toContain('id="page-stale"');
    expect(html).toContain('Date.now()');
    expect(html.trimEnd().endsWith('</html>')).toBe(true);
  });

  it('renders Bulgarian with the other language linked', () => {
    const html = renderPage(options({ locale: 'bg', otherLocaleHref: 'en.html' }));
    expect(html).toContain('<html lang="bg"');
    expect(html).toContain(CATALOG.bg.heading);
    expect(html).toContain('lang="en">English</a>');
    expect(html).toContain('временно');
  });

  it('escapes operator-written and founder-written text', () => {
    const html = renderPage(options());
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('Provider &lt;script&gt;alert(1)&lt;/script&gt; maintenance');
    expect(html).toContain('delayed &amp; we are on it.');
    const bg = renderPage(options({ locale: 'bg' }));
    expect(bg).toContain('&quot;временно&quot;');
  });

  it('shows component state as shape and word, not colour alone', () => {
    const html = renderPage(options());
    expect(html).toContain('▲</span> Degraded');
    expect(html).toContain(CATALOG.en.unconfirmed);
    expect(html).toContain('Map data last updated at 2026-09-25 11:53 UTC (7 min ago).');
    expect(html).toContain('Since 2026-09-25 11:58 UTC');
  });

  it('labels known sources and shows unknown ones by id', () => {
    const html = renderPage(options());
    expect(html).toContain('data-source="lsasaf:seviri:frp-pixel"');
    expect(html).toContain('Geostationary satellite detections (SEVIRI)');
    expect(html).toContain('<th scope="row">future:feed</th>');
    expect(html).toContain('expected until 2026-09-26 00:00 UTC');
  });

  it('says so when there are no sources or notices', () => {
    const html = renderPage(options({ notices: [], model: { ...model, sources: [] } }));
    expect(html).toContain(CATALOG.en.noNotices);
    expect(html).toContain(CATALOG.en.sourcesUnavailable);
  });

  it('links an https second channel and prints anything else as text', () => {
    const linked = renderPage(options({ announceChannel: 'https://social.example/@status' }));
    expect(linked).toContain(
      'updates are posted at <a href="https://social.example/@status" rel="noopener">',
    );
    const text = renderPage(options({ announceChannel: '@status <b>' }));
    expect(text).toContain('updates are posted at @status &lt;b&gt;.');
    expect(renderPage(options())).not.toContain('updates are posted at');
  });

  it('leaks no URL or host other than the ones it was given', () => {
    const html = renderPage(options());
    expect(html.match(/https?:\/\/[^\s"<]+/g) ?? []).toEqual([]);
  });

  it('is deterministic', () => {
    expect(renderPage(options())).toBe(renderPage(options()));
  });
});
