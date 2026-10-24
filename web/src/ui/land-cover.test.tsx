/**
 * V2-F4, web half: the land-cover grid's lazy load and the event-detail sentence. The
 * sentence is context only — it renders nothing until the grid has loaded, nor where the
 * grid has no data (open sea, outside the served box).
 */

import prerender from 'preact-iso/prerender';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_CONFIG } from '../core/config.js';
import {
  LAND_COVER_FORMAT,
  LAND_COVER_GROUPS,
  landCoverSentence as sentence,
  landCoverText,
  parseLandCover,
} from '../core/geo/land-cover.js';
import bg from '../core/i18n/bg.js';
import en from '../core/i18n/en.js';
import type { Messages } from '../core/i18n/messages.js';
import type { FireEventStore } from '../core/types.js';
import { AppContext } from './context.js';
import type { AppServices } from './context.js';
import { LandCoverNote } from './event/land-cover-note.js';
import { landCoverSentence, loadLandCover, resetLandCoverForTest } from './land-cover.js';

/** Two 0.02° cells from (24, 42.02): forest-and-grassland, then cropland. */
const BODY = {
  format: LAND_COVER_FORMAT,
  version: 'landcover_test',
  source: 'test',
  licence: 'CC BY 4.0',
  attribution: 'test',
  product_sha256: 'abc',
  grid: { west: 24, north: 42.02, cell_deg: 0.02, cols: 2, rows: 1, scale: 10 },
  groups: [...LAND_COVER_GROUPS],
  palette: [
    [6, 0, 4, 0, 0, 0, 0, 0],
    [0, 0, 0, 10, 0, 0, 0, 0],
  ],
  rows: [[0, 1, 1, 1]],
  counts: { cells: 2, empty: 0, palette: 2 },
};
const GRID = parseLandCover(BODY);
const FOREST_CELL = { lon: 24.01, lat: 42.01 };
const CROP_CELL = { lon: 24.03, lat: 42.01 };

/** As the load leaves it: the sentence bound to the grid. */
function loaded(): void {
  landCoverSentence.value = (points, t) => sentence(GRID, points, t);
}

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

beforeEach(() => {
  resetLandCoverForTest();
  vi.stubGlobal('fetch', okFetch(BODY));
});
afterEach(() => {
  vi.unstubAllGlobals();
  resetLandCoverForTest();
});

describe('loadLandCover', () => {
  it('loads once and parses the asset', async () => {
    let calls = 0;
    const fetchImpl = ((...args: Parameters<typeof fetch>) => {
      calls += 1;
      return okFetch(BODY)(...args);
    }) as typeof fetch;
    const first = loadLandCover(fetchImpl);
    expect(loadLandCover(fetchImpl)).toBe(first);
    expect(landCoverSentence.value).toBeNull();
    await first;
    expect(calls).toBe(1);
    expect(landCoverSentence.value?.([FOREST_CELL], en.eventDetail)).toBe(
      'Land cover (ESA WorldCover 2021): forest 60%, grassland 40%.',
    );
  });

  it('fails without a grid, and a later call retries', async () => {
    await loadLandCover(() => Promise.resolve(new Response('nope', { status: 404 })));
    expect(landCoverSentence.value).toBeNull();
    await loadLandCover(okFetch({ format: 'something-else' }));
    expect(landCoverSentence.value).toBeNull();
    await loadLandCover(okFetch(BODY));
    expect(landCoverSentence.value).not.toBeNull();
  });
});

describe('LandCoverNote', () => {
  it('renders nothing before the grid loads', async () => {
    expect(await render(<LandCoverNote event={FOREST_CELL} />)).toBe('');
  });

  it('describes the centre cell in both locales', async () => {
    loaded();
    expect(await render(<LandCoverNote event={FOREST_CELL} />)).toContain(
      'Land cover (ESA WorldCover 2021): forest 60%, grassland 40%.',
    );
    expect(await render(<LandCoverNote event={FOREST_CELL} />, bg)).toContain(
      'Земно покритие (ESA WorldCover 2021): гора 60 %, тревни площи 40 %.',
    );
  });

  it('averages the detections’ cells once positions are known', async () => {
    loaded();
    const html = await render(
      <LandCoverNote event={FOREST_CELL} positions={[FOREST_CELL, CROP_CELL, CROP_CELL]} />,
    );
    expect(html).toContain('cropland 50%, forest 30%, grassland 20%');
  });

  it('renders nothing where the grid has no data', async () => {
    loaded();
    expect(await render(<LandCoverNote event={{ lon: 30, lat: 43 }} />)).toBe('');
  });
});

describe('landCoverText', () => {
  it('joins the parts in order with the locale’s percent', () => {
    const parts = [
      { group: 'wetland', percent: 50 },
      { group: 'water', percent: 50 },
    ] as const;
    expect(landCoverText(parts, en.eventDetail)).toBe(
      'Land cover (ESA WorldCover 2021): wetland 50%, water 50%.',
    );
    expect(landCoverText(parts, bg.eventDetail)).toBe(
      'Земно покритие (ESA WorldCover 2021): влажни зони 50 %, вода 50 %.',
    );
  });
});
