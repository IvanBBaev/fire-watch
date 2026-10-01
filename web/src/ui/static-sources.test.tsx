/**
 * TASKS F16, web half: the mask's lazy load, the event-detail caveat and the Layers-panel
 * row. The caveat must never hide anything — it only adds a sentence — and the row must
 * print the OSM credit, with its link, while the layer is on (CI-13).
 */

import {
  STATIC_SOURCE_CAVEAT,
  STATIC_SOURCE_FORMAT,
  STATIC_SOURCE_KINDS,
  parseStaticSourceMask,
} from '@fire-watch/contracts';
import prerender from 'preact-iso/prerender';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_CONFIG } from '../core/config.js';
import bg from '../core/i18n/bg.js';
import en from '../core/i18n/en.js';
import type { Messages } from '../core/i18n/messages.js';
import type { FireEventStore } from '../core/types.js';
import { AppContext } from './context.js';
import type { AppServices } from './context.js';
import { StaticSourceNote } from './event/static-source-note.js';
import { StaticSourcesOption } from './static-sources-option.js';
import {
  STATIC_SOURCES_STORAGE_KEY,
  applyStaticSourcesFromLink,
  caveatFor,
  loadStaticSources,
  resetStaticSourcesForTest,
  setStaticSourcesChosen,
  staticSourceCaveat,
  staticSourceDetectionCaveat,
  staticSourceMask,
  staticSourcesDraw,
  staticSourcesState,
} from './static-sources.js';

/** A solar park at lon 25.00–25.01 × lat 42.00–42.01 and a flare node at 26.0, 43.0. */
const BODY = {
  format: STATIC_SOURCE_FORMAT,
  version: 'test',
  licence: 'ODbL-1.0',
  attribution: '© OpenStreetMap contributors',
  scale: 10_000,
  kinds: [...STATIC_SOURCE_KINDS],
  sources: [
    [0, 250_000, 420_000, 100, 0, 0, 100, -100, 0],
    [3, 260_000, 430_000],
  ],
};
const MASK = parseStaticSourceMask(BODY);

const NOW = Date.parse('2026-09-30T12:00:00.000Z');

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
  resetStaticSourcesForTest();
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
  resetStaticSourcesForTest();
});

describe('loadStaticSources', () => {
  it('loads once and parses the asset', async () => {
    let calls = 0;
    const fetchImpl = ((...args: Parameters<typeof fetch>) => {
      calls += 1;
      return okFetch(BODY)(...args);
    }) as typeof fetch;
    const first = loadStaticSources(fetchImpl);
    expect(loadStaticSources(fetchImpl)).toBe(first);
    expect(staticSourcesState.value).toBe('loading');
    await first;
    expect(calls).toBe(1);
    expect(staticSourcesState.value).toBe('ready');
    expect(staticSourceMask.value.sources).toHaveLength(2);
  });

  it('fails without a mask, and a later call retries', async () => {
    await loadStaticSources(() => Promise.resolve(new Response('nope', { status: 404 })));
    expect(staticSourcesState.value).toBe('failed');
    expect(staticSourceMask.value.sources).toHaveLength(0);
    await loadStaticSources(okFetch({ format: 'something-else' }));
    expect(staticSourcesState.value).toBe('failed');
    await loadStaticSources(okFetch(BODY));
    expect(staticSourcesState.value).toBe('ready');
  });
});

describe('staticSourceCaveat', () => {
  it('names the nearest kind within the caveat radius and nothing beyond it', () => {
    expect(STATIC_SOURCE_CAVEAT.radiusM).toBe(1000);
    expect(staticSourceCaveat(MASK, { lon: 25.005, lat: 42.005 })).toBe('solar');
    expect(staticSourceCaveat(MASK, { lon: 25.005, lat: 41.995 })).toBe('solar'); // ~560 m
    expect(staticSourceCaveat(MASK, { lon: 26.008, lat: 43 })).toBe('industrial'); // ~650 m
    expect(staticSourceCaveat(MASK, { lon: 26.02, lat: 43 })).toBeNull(); // ~1.6 km
  });

  it('is silent while the mask is not loaded', () => {
    expect(staticSourceCaveat(staticSourceMask.value, { lon: 25.005, lat: 42.005 })).toBeNull();
  });

  it('reads every non-solar kind as industrial', () => {
    expect(STATIC_SOURCE_KINDS.map(caveatFor)).toEqual([
      'solar',
      'industrial',
      'industrial',
      'industrial',
    ]);
  });
});

describe('staticSourceDetectionCaveat', () => {
  const onPark = { lon: 25.005, lat: 42.005 };
  const nearFlare = { lon: 26.008, lat: 43 };
  const clear = { lon: 23.32, lat: 42.7 };

  it('counts the detections near a source, per detection', () => {
    expect(staticSourceDetectionCaveat(MASK, [onPark, clear, onPark])).toEqual({
      caveat: 'solar',
      near: 2,
      total: 3,
    });
  });

  it('reads a mixed set as industrial, and a clear set as nothing', () => {
    expect(staticSourceDetectionCaveat(MASK, [onPark, nearFlare])).toEqual({
      caveat: 'industrial',
      near: 2,
      total: 2,
    });
    expect(staticSourceDetectionCaveat(MASK, [clear, clear])).toBeNull();
    expect(staticSourceDetectionCaveat(MASK, [])).toBeNull();
  });

  it('is silent while the mask is not loaded', () => {
    expect(staticSourceDetectionCaveat(staticSourceMask.value, [onPark])).toBeNull();
  });
});

describe('StaticSourceNote', () => {
  it('adds the solar or industrial sentence, in both locales', async () => {
    staticSourceMask.value = MASK;
    expect(await render(<StaticSourceNote event={{ lon: 25.005, lat: 42.005 }} />)).toContain(
      en.eventDetail.staticSourceSolar,
    );
    expect(await render(<StaticSourceNote event={{ lon: 26.001, lat: 43 }} />, bg)).toContain(
      bg.eventDetail.staticSourceIndustrial,
    );
  });

  it('renders nothing away from every source', async () => {
    staticSourceMask.value = MASK;
    expect(await render(<StaticSourceNote event={{ lon: 23.32, lat: 42.7 }} />)).toBe('');
  });

  it('judges per detection once positions are known, whatever the centre says', async () => {
    staticSourceMask.value = MASK;
    // The centre is clear of the park, but one of the two pixels lies on it.
    const centre = { lon: 23.32, lat: 42.7 };
    const positions = [
      { lon: 25.005, lat: 42.005 },
      { lon: 23.32, lat: 42.7 },
    ];
    expect(await render(<StaticSourceNote event={centre} positions={positions} />)).toContain(
      en.eventDetail.staticSourceDetectionsSolar(1, 2),
    );
    expect(await render(<StaticSourceNote event={centre} positions={positions} />, bg)).toContain(
      bg.eventDetail.staticSourceDetectionsSolar(1, 2),
    );
    // The centre is on the park, but no pixel is: no caveat.
    expect(
      await render(<StaticSourceNote event={{ lon: 25.005, lat: 42.005 }} positions={[centre]} />),
    ).toBe('');
  });

  it('falls back to the centre when there are no positions', async () => {
    staticSourceMask.value = MASK;
    expect(
      await render(<StaticSourceNote event={{ lon: 25.005, lat: 42.005 }} positions={[]} />),
    ).toContain(en.eventDetail.staticSourceSolar);
  });
});

describe('the per-detection sentences', () => {
  it('agree in number in both locales', () => {
    expect(en.eventDetail.staticSourceDetectionsSolar(1, 1)).toBe(
      'Its only detection is near a known solar park — this hotspot may not be a fire.',
    );
    expect(en.eventDetail.staticSourceDetectionsIndustrial(1, 3)).toBe(
      '1 of 3 detections is near a known industrial heat source — it may not be a fire.',
    );
    expect(en.eventDetail.staticSourceDetectionsSolar(2, 3)).toBe(
      '2 of 3 detections are near a known solar park — they may not be a fire.',
    );
    expect(bg.eventDetail.staticSourceDetectionsSolar(4, 4)).toBe(
      'Всички 4 засичания са в близост до известен соларен парк — може да не е пожар.',
    );
    expect(bg.eventDetail.staticSourceDetectionsIndustrial(1, 3)).toBe(
      '1 от 3 засичания е в близост до известен промишлен източник на топлина — то може да не е пожар.',
    );
  });
});

describe('StaticSourcesOption', () => {
  it('shows the toggle and note, and no credit while off', async () => {
    const html = await render(<StaticSourcesOption />);
    expect(html).toContain(en.layers.staticSources);
    expect(html).toContain(en.layers.staticSourcesNote);
    expect(html).not.toContain('openstreetmap.org/copyright');
    expect(staticSourcesDraw.value).toBeNull();
  });

  it('prints the OSM credit with its link while on, and persists the choice', async () => {
    setStaticSourcesChosen(true);
    expect(stored.get(STATIC_SOURCES_STORAGE_KEY)).toBe('on');
    const html = await render(<StaticSourcesOption />, bg);
    expect(html).toContain('href="https://www.openstreetmap.org/copyright"');
    expect(html).toContain('© OpenStreetMap contributors');
    setStaticSourcesChosen(false);
    expect(stored.get(STATIC_SOURCES_STORAGE_KEY)).toBe('off');
  });

  it('draws only a chosen, loaded mask', async () => {
    await loadStaticSources();
    expect(staticSourcesDraw.value).toBeNull();
    setStaticSourcesChosen(true);
    expect(staticSourcesDraw.value).toBe(staticSourceMask.value);
    expect(staticSourcesDraw.value?.sources).toHaveLength(2);
  });

  it('takes a choice from a link without writing storage', async () => {
    applyStaticSourcesFromLink(true);
    expect(staticSourcesState.value).toBe('loading');
    expect(stored.has(STATIC_SOURCES_STORAGE_KEY)).toBe(false);
    await loadStaticSources();
    expect(staticSourcesDraw.value?.sources).toHaveLength(2);
    applyStaticSourcesFromLink(false);
    expect(staticSourcesDraw.value).toBeNull();
    expect(stored.has(STATIC_SOURCES_STORAGE_KEY)).toBe(false);
  });

  it('starts the load when switched on', async () => {
    setStaticSourcesChosen(true);
    expect(staticSourcesState.value).toBe('loading');
    await loadStaticSources();
    expect(staticSourcesDraw.value?.sources).toHaveLength(2);
  });
});
