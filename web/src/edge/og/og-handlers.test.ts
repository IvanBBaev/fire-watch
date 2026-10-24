/**
 * TASKS V2-D4 — the og routes: the shell carries the event's escaped meta and the PNG
 * route's URL; the PNG route answers 200/304/404/503 with a strong ETag, never rasterises
 * twice for the same card, and stays within its cache bound. The rasteriser is faked here
 * (it is exercised for real in `resvg-rasterizer.test.ts`).
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import bg from '../../core/i18n/bg.js';
import en from '../../core/i18n/en.js';
import { BoundedCache } from './bounded-cache.js';
import { OG_BEGIN, OG_END } from './inject-meta.js';
import {
  handleEventImage,
  handleEventShell,
  etagMatches,
  type OgDependencies,
} from './og-handlers.js';

const SNAPSHOT = JSON.parse(
  readFileSync(
    fileURLToPath(new URL('../../../public/fixtures/snapshot.json', import.meta.url)),
    'utf8',
  ),
) as { generated_at: string; features: { properties: Record<string, unknown> }[] };

const SHELL = readFileSync(fileURLToPath(new URL('../../../index.html', import.meta.url)), 'utf8');

const ORIGIN = 'https://firewatch.example';
const LIVE_ID = 'fw-2026-q7f3d';
const MERGED_ID = 'fw-2026-z7c3f';
/** One minute after the fixture snapshot — fresh, so no delay line. */
const NOW = Date.parse(SNAPSHOT.generated_at) + 60_000;

function deps(overrides: Partial<OgDependencies> = {}): OgDependencies & { rasterized: string[] } {
  const rasterized: string[] = [];
  return {
    loadShell: () =>
      Promise.resolve(new Response(SHELL, { headers: { 'content-type': 'text/html' } })),
    loadSnapshot: () => Promise.resolve(structuredClone(SNAPSHOT)),
    rasterize: (svg) => {
      rasterized.push(svg);
      return Promise.resolve(new TextEncoder().encode(`PNG:${svg.length}`));
    },
    now: () => NOW,
    cache: new BoundedCache<Uint8Array>({ maxEntries: 8, maxBytes: 1 << 20 }),
    rendererRevision: 'test',
    ...overrides,
    rasterized,
  };
}

function get(path: string, headers: Record<string, string> = {}, method = 'GET'): Request {
  return new Request(ORIGIN + path, { method, headers });
}

function metaContent(html: string, key: string): string | undefined {
  const match = new RegExp(`<meta (?:property|name)="${key}" content="([^"]*)"`, 'u').exec(html);
  return match?.[1];
}

describe('GET /event/:id (shell)', () => {
  it('injects the event meta and the PNG route URL in the reader locale', async () => {
    const response = await handleEventShell(
      get(`/event/${LIVE_ID}`, { 'accept-language': 'en-GB,en;q=0.9' }),
      LIVE_ID,
      deps(),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/html');
    expect(response.headers.get('vary')).toBe('Accept-Language');
    const html = await response.text();
    expect(html).toContain('<html lang="en"');
    expect(metaContent(html, 'og:title')).toBe(en.eventNearPlace('Harmanli'));
    expect(metaContent(html, 'og:url')).toBe(`${ORIGIN}/event/${LIVE_ID}`);
    expect(metaContent(html, 'og:image')).toBe(`${ORIGIN}/og/event/${LIVE_ID}.png?lang=en`);
    expect(metaContent(html, 'og:image:width')).toBe('1200');
    expect(metaContent(html, 'twitter:card')).toBe('summary_large_image');
    // The static defaults are replaced, not duplicated, and the rest of the shell survives.
    expect(html.match(/property="og:title"/gu)).toHaveLength(1);
    expect(html).toContain(OG_BEGIN);
    expect(html).toContain(OG_END);
    expect(html).toContain('<div id="app"></div>');
  });

  it('defaults to Bulgarian and previews a merged id as its survivor', async () => {
    const response = await handleEventShell(get(`/event/${MERGED_ID}`), MERGED_ID, deps());
    const html = await response.text();
    expect(response.status).toBe(200);
    expect(html).toContain('<html lang="bg"');
    expect(metaContent(html, 'og:title')).toBe(bg.eventNearPlace('Харманли'));
    expect(metaContent(html, 'og:url')).toBe(`${ORIGIN}/event/${LIVE_ID}`);
    expect(metaContent(html, 'og:image:alt')).toBe(bg.ogImage.alt('Харманли'));
  });

  it('escapes snapshot text so a place name cannot break out of an attribute', async () => {
    const hostile = structuredClone(SNAPSHOT);
    const first = hostile.features[0];
    if (first === undefined) throw new Error('fixture');
    first.properties['place_name_bg'] = '"><script>alert(1)</script>';
    const response = await handleEventShell(
      get(`/event/${LIVE_ID}`),
      LIVE_ID,
      deps({
        loadSnapshot: () => Promise.resolve(hostile),
      }),
    );
    const html = await response.text();
    expect(html).not.toContain('<script>alert');
    expect(html).toContain('&quot;&gt;&lt;script&gt;');
  });

  it('serves the unmodified shell with 404 for an id the snapshot does not hold', async () => {
    for (const id of ['fw-2026-nope', '../etc', '"><x>']) {
      const response = await handleEventShell(get('/event/x'), id, deps());
      expect(response.status).toBe(404);
      expect(await response.text()).toBe(SHELL);
    }
  });

  it('keeps the permalink working when the snapshot cannot be read', async () => {
    const response = await handleEventShell(
      get(`/event/${LIVE_ID}`),
      LIVE_ID,
      deps({
        loadSnapshot: () => Promise.reject(new Error('down')),
      }),
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(SHELL);
    const garbage = await handleEventShell(
      get(`/event/${LIVE_ID}`),
      LIVE_ID,
      deps({
        loadSnapshot: () => Promise.resolve({ type: 'nope' }),
      }),
    );
    expect(await garbage.text()).toBe(SHELL);
  });
});

describe('GET /og/event/:id.png', () => {
  it('serves a PNG with a strong ETag and caching headers', async () => {
    const d = deps();
    const response = await handleEventImage(
      get(`/og/event/${LIVE_ID}.png?lang=en`),
      `${LIVE_ID}.png`,
      d,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/png');
    expect(response.headers.get('etag')).toMatch(/^"og-[0-9a-f]{32}"$/u);
    expect(response.headers.get('cache-control')).toBe('public, max-age=300');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('set-cookie')).toBeNull();
    const body = new Uint8Array(await response.arrayBuffer());
    expect(response.headers.get('content-length')).toBe(String(body.byteLength));
    expect(d.rasterized).toHaveLength(1);
    expect(d.rasterized[0]).toContain(en.eventNearPlace('Harmanli'));
  });

  it('draws the same card the shell describes, from the same snapshot and instant', async () => {
    const d = deps();
    await handleEventImage(get(`/og/event/${LIVE_ID}.png?lang=bg`), `${LIVE_ID}.png`, d);
    const svg = d.rasterized[0] ?? '';
    expect(svg).toContain(bg.eventNearPlace('Харманли'));
    expect(svg).toContain(`firewatch.example/event/${LIVE_ID}`);
    expect(svg).not.toContain('Сателитните данни са забавени');
  });

  it('is deterministic: the same inputs give the same ETag and bytes', async () => {
    const one = await handleEventImage(
      get(`/og/event/${LIVE_ID}.png?lang=bg`),
      `${LIVE_ID}.png`,
      deps(),
    );
    const two = await handleEventImage(
      get(`/og/event/${LIVE_ID}.png?lang=bg`),
      `${LIVE_ID}.png`,
      deps(),
    );
    expect(one.headers.get('etag')).toBe(two.headers.get('etag'));
    expect(await one.text()).toBe(await two.text());
    const otherLocale = await handleEventImage(
      get(`/og/event/${LIVE_ID}.png?lang=en`),
      `${LIVE_ID}.png`,
      deps(),
    );
    expect(otherLocale.headers.get('etag')).not.toBe(one.headers.get('etag'));
    const otherRevision = await handleEventImage(
      get(`/og/event/${LIVE_ID}.png?lang=bg`),
      `${LIVE_ID}.png`,
      deps({ rendererRevision: 'next' }),
    );
    expect(otherRevision.headers.get('etag')).not.toBe(one.headers.get('etag'));
  });

  it('answers If-None-Match with 304 and no rasterising, and reuses the cache', async () => {
    const d = deps();
    const first = await handleEventImage(
      get(`/og/event/${LIVE_ID}.png?lang=bg`),
      `${LIVE_ID}.png`,
      d,
    );
    const etag = first.headers.get('etag') ?? '';
    const revalidated = await handleEventImage(
      get(`/og/event/${LIVE_ID}.png?lang=bg`, { 'if-none-match': `W/"x", ${etag}` }),
      `${LIVE_ID}.png`,
      d,
    );
    expect(revalidated.status).toBe(304);
    expect(revalidated.headers.get('etag')).toBe(etag);
    expect(await revalidated.text()).toBe('');
    const again = await handleEventImage(
      get(`/og/event/${LIVE_ID}.png?lang=bg`),
      `${LIVE_ID}.png`,
      d,
    );
    expect(again.status).toBe(200);
    expect(d.rasterized).toHaveLength(1);
  });

  it('carries the delay line when the snapshot has stopped updating', async () => {
    const d = deps({ now: () => NOW + 60 * 60_000 });
    const response = await handleEventImage(
      get(`/og/event/${LIVE_ID}.png?lang=en`),
      `${LIVE_ID}.png`,
      d,
    );
    expect(response.status).toBe(200);
    expect(d.rasterized[0]).toContain('Satellite data delayed');
  });

  it('is 404 for an unknown id or a non-PNG path, and 503 when the snapshot is unreadable', async () => {
    const d = deps();
    expect(
      (await handleEventImage(get('/og/event/fw-2026-nope.png'), 'fw-2026-nope.png', d)).status,
    ).toBe(404);
    expect((await handleEventImage(get(`/og/event/${LIVE_ID}`), LIVE_ID, d)).status).toBe(404);
    expect((await handleEventImage(get('/og/event/x.png'), '..%2F.png', d)).status).toBe(404);
    const down = await handleEventImage(
      get(`/og/event/${LIVE_ID}.png`),
      `${LIVE_ID}.png`,
      deps({ loadSnapshot: () => Promise.reject(new Error('down')) }),
    );
    expect(down.status).toBe(503);
    expect(down.headers.get('cache-control')).toBe('no-store');
    expect(d.rasterized).toHaveLength(0);
  });

  it('answers HEAD without a body and refuses other methods', async () => {
    const head = await handleEventImage(
      get(`/og/event/${LIVE_ID}.png`, {}, 'HEAD'),
      `${LIVE_ID}.png`,
      deps(),
    );
    expect(head.status).toBe(200);
    expect(head.headers.get('content-length')).not.toBeNull();
    const post = await handleEventImage(
      get(`/og/event/${LIVE_ID}.png`, {}, 'POST'),
      `${LIVE_ID}.png`,
      deps(),
    );
    expect(post.status).toBe(405);
    expect(post.headers.get('allow')).toBe('GET, HEAD');
  });
});

describe('etagMatches', () => {
  it('follows RFC 9110 weak comparison for If-None-Match', () => {
    expect(etagMatches(null, '"a"')).toBe(false);
    expect(etagMatches('*', '"a"')).toBe(true);
    expect(etagMatches('"b", W/"a"', '"a"')).toBe(true);
    expect(etagMatches('"b"', '"a"')).toBe(false);
  });
});
