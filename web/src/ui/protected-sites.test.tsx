/**
 * V2-F1, web half: the Natura 2000 sites' lazy load, the event-detail sentence and the
 * Layers-panel row. The sentence is context only — it renders nothing until the sites
 * have loaded and nothing beyond 5 km — and the row must print the EEA credit, with its
 * link, while the layer is on (CI-13).
 */

import prerender from 'preact-iso/prerender';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_CONFIG } from '../core/config.js';
import * as geo from '../core/geo/protected-sites.js';
import { PROTECTED_SITES_FORMAT, parseProtectedSites } from '../core/geo/protected-sites.js';
import bg from '../core/i18n/bg.js';
import en from '../core/i18n/en.js';
import type { Messages } from '../core/i18n/messages.js';
import type { FireEventStore } from '../core/types.js';
import { AppContext } from './context.js';
import type { AppServices } from './context.js';
import { ProtectedSiteNote, protectedSiteText } from './event/protected-site-note.js';
import { ProtectedSitesOption } from './protected-sites-option.js';
import {
  PROTECTED_SITES_STORAGE_KEY,
  applyProtectedSitesFromLink,
  loadProtectedSites,
  protectedSites,
  protectedSitesDraw,
  protectedSitesGeo,
  protectedSitesState,
  resetProtectedSitesForTest,
  setProtectedSitesChosen,
} from './protected-sites.js';

/** One SCI covering lon 24.0–24.5 × lat 42.0–42.5. */
const BODY = {
  format: PROTECTED_SITES_FORMAT,
  version: 'natura2000_test',
  licence: 'CC-BY-4.0',
  attribution: 'test',
  scale: 1000,
  types: ['spa', 'sci', 'spa_sci'],
  sites: [['BG0000001', 'Alpha', 1, [[[24000, 42000, 500, 0, 0, 500, -500, 0]]]]],
};
const SITES = parseProtectedSites(BODY);

const NOW = Date.parse('2026-10-24T12:00:00.000Z');

function services(messages: Messages): AppServices {
  return {
    store: {} as FireEventStore,
    clock: { epochNow: () => NOW, monotonicNow: () => 0 },
    serverNow: () => NOW,
    config: DEFAULT_CONFIG,
    geolocator: { locate: () => Promise.reject(new Error('not asked')) },
    locale: messages === bg ? 'bg' : 'en',
    messages,
    setLocale: () => {},
  };
}

async function render(node: preact.ComponentChild, messages: Messages = en): Promise<string> {
  const { html } = await prerender(
    <AppContext.Provider value={services(messages)}>{node}</AppContext.Provider>,
  );
  return html.replace(/<script[\s\S]*?<\/script>/g, '');
}

const okFetch = (body: unknown) =>
  (() => Promise.resolve(new Response(JSON.stringify(body), { status: 200 }))) as typeof fetch;

/** The node project has no DOM; the choice is persisted through `ui/storage.ts`. */
const stored = new Map<string, string>();

beforeEach(() => {
  resetProtectedSitesForTest();
  stored.clear();
  vi.stubGlobal('fetch', okFetch(BODY));
  vi.stubGlobal('window', {
    localStorage: {
      getItem: (key: string) => stored.get(key) ?? null,
      setItem: (key: string, value: string) => stored.set(key, value),
    },
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  resetProtectedSitesForTest();
});

describe('loadProtectedSites', () => {
  it('loads once and parses the asset', async () => {
    let calls = 0;
    const fetchImpl = ((...args: Parameters<typeof fetch>) => {
      calls += 1;
      return okFetch(BODY)(...args);
    }) as typeof fetch;
    const first = loadProtectedSites(fetchImpl);
    expect(loadProtectedSites(fetchImpl)).toBe(first);
    expect(protectedSitesState.value).toBe('loading');
    await first;
    expect(calls).toBe(1);
    expect(protectedSitesState.value).toBe('ready');
    expect(protectedSites.value.sites).toHaveLength(1);
    expect(protectedSitesGeo.value).not.toBeNull();
  });

  it('fails without sites, and a later call retries', async () => {
    await loadProtectedSites(() => Promise.resolve(new Response('nope', { status: 404 })));
    expect(protectedSitesState.value).toBe('failed');
    expect(protectedSites.value.sites).toHaveLength(0);
    await loadProtectedSites(okFetch({ format: 'something-else' }));
    expect(protectedSitesState.value).toBe('failed');
    await loadProtectedSites(okFetch(BODY));
    expect(protectedSitesState.value).toBe('ready');
  });
});

describe('ProtectedSiteNote', () => {
  it('says inside, in both locales', async () => {
    protectedSites.value = SITES;
    protectedSitesGeo.value = geo;
    const event = { lon: 24.2, lat: 42.2 };
    expect(await render(<ProtectedSiteNote event={event} />)).toContain(
      en.eventDetail.protectedSiteInside('Alpha', 'BG0000001'),
    );
    expect(await render(<ProtectedSiteNote event={event} />, bg)).toContain(
      bg.eventDetail.protectedSiteInside('Alpha', 'BG0000001'),
    );
  });

  it('counts per detection once positions are known, whatever the centre says', async () => {
    protectedSites.value = SITES;
    protectedSitesGeo.value = geo;
    const html = await render(
      <ProtectedSiteNote
        event={{ lon: 23.32, lat: 42.7 }}
        positions={[
          { lon: 24.2, lat: 42.2 },
          { lon: 23.32, lat: 42.7 },
          { lon: 23.33, lat: 42.7 },
        ]}
      />,
    );
    expect(html).toContain(en.eventDetail.protectedSiteInsideSome(1, 3, 'Alpha', 'BG0000001'));
  });

  it('says near within 5 km and nothing beyond it, or before the sites load', async () => {
    // 0.03° of longitude east of the site's edge at 42.2° N: ~2.5 km.
    const near = { lon: 24.53, lat: 42.2 };
    expect(await render(<ProtectedSiteNote event={near} />)).toBe('');
    protectedSites.value = SITES;
    protectedSitesGeo.value = geo;
    expect(await render(<ProtectedSiteNote event={near} />)).toContain(
      en.eventDetail.protectedSiteNear(2.5, 'Alpha', 'BG0000001'),
    );
    expect(await render(<ProtectedSiteNote event={{ lon: 24.7, lat: 42.2 }} />)).toBe('');
  });
});

describe('protectedSiteText', () => {
  const site = SITES.sites[0];
  if (site === undefined) throw new Error('fixture');

  it('rounds the distance to one decimal and never says 0 km', () => {
    expect(protectedSiteText({ relation: 'near', site, distanceM: 2549 }, en.eventDetail)).toBe(
      'About 2.5 km from the Natura 2000 protected site Alpha (BG0000001).',
    );
    expect(protectedSiteText({ relation: 'near', site, distanceM: 20 }, en.eventDetail)).toBe(
      'About 0.1 km from the Natura 2000 protected site Alpha (BG0000001).',
    );
    expect(protectedSiteText({ relation: 'near', site, distanceM: 2549 }, bg.eventDetail)).toBe(
      'На около 2,5 км от защитената зона от Натура 2000 Alpha (BG0000001).',
    );
  });

  it('agrees in number in both locales', () => {
    const one = { relation: 'inside', site, inside: 1, total: 3 } as const;
    const two = { relation: 'inside', site, inside: 2, total: 3 } as const;
    expect(protectedSiteText(one, en.eventDetail)).toBe(
      '1 of 3 detections is inside the Natura 2000 protected site Alpha (BG0000001).',
    );
    expect(protectedSiteText(two, en.eventDetail)).toBe(
      '2 of 3 detections are inside the Natura 2000 protected site Alpha (BG0000001).',
    );
    expect(protectedSiteText(one, bg.eventDetail)).toBe(
      '1 от 3 засичания е в защитената зона от Натура 2000 Alpha (BG0000001).',
    );
    expect(
      protectedSiteText({ relation: 'inside', site, inside: 3, total: 3 }, bg.eventDetail),
    ).toBe('В защитената зона от Натура 2000 Alpha (BG0000001).');
  });
});

describe('ProtectedSitesOption', () => {
  it('shows the toggle and note, and no credit while off', async () => {
    const html = await render(<ProtectedSitesOption />);
    expect(html).toContain(en.layers.protectedSites);
    expect(html).toContain(en.layers.protectedSitesNote);
    expect(html).not.toContain('European Environment Agency (EEA)');
    expect(protectedSitesDraw.value).toBeNull();
  });

  it('prints the EEA credit with its link while on, and persists the choice', async () => {
    setProtectedSitesChosen(true);
    expect(stored.get(PROTECTED_SITES_STORAGE_KEY)).toBe('on');
    const html = await render(<ProtectedSitesOption />, bg);
    expect(html).toContain('href="https://www.eea.europa.eu/data-and-maps/data/natura-12"');
    expect(html).toContain('European Environment Agency (EEA), CC BY 4.0');
    setProtectedSitesChosen(false);
    expect(stored.get(PROTECTED_SITES_STORAGE_KEY)).toBe('off');
  });

  it('draws only chosen, loaded sites', async () => {
    await loadProtectedSites();
    expect(protectedSitesDraw.value).toBeNull();
    setProtectedSitesChosen(true);
    expect(protectedSitesDraw.value?.features.map((f) => f.properties.code)).toEqual(['BG0000001']);
  });

  it('takes a choice from a link without writing storage', async () => {
    applyProtectedSitesFromLink(true);
    expect(protectedSitesState.value).toBe('loading');
    expect(stored.has(PROTECTED_SITES_STORAGE_KEY)).toBe(false);
    await loadProtectedSites();
    expect(protectedSitesDraw.value?.features).toHaveLength(1);
    applyProtectedSitesFromLink(false);
    expect(protectedSitesDraw.value).toBeNull();
    expect(stored.has(PROTECTED_SITES_STORAGE_KEY)).toBe(false);
  });
});
