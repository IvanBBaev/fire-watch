/**
 * TASKS G4, web half: the Layers panel's state and markup. The loader runs against a fake
 * `fetch` answering like the proxy route (`server/src/adapters/http/effis-overlay-route.ts`)
 * — the headers named here are that route's contract.
 */

import prerender from 'preact-iso/prerender';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_CONFIG } from '../core/config.js';
import bg from '../core/i18n/bg.js';
import en from '../core/i18n/en.js';
import type { Messages } from '../core/i18n/messages.js';
import type { FireEventStore } from '../core/types.js';
import { AppContext } from './context.js';
import type { AppServices } from './context.js';
import { activeCreditConditions } from './logic/credits.js';
import { LayersPanel, LayersToggle, LAYERS_PANEL_ID } from './layers-panel.js';
import {
  FWI_CLASSES,
  LAYERS_STORAGE_KEY,
  OVERLAY_REFETCH_AFTER_MS,
  OVERLAY_URLS,
  type OverlayLoaderDeps,
  chosenOverlays,
  effisChosen,
  effisCreditText,
  effisOverlayPayload,
  expectedFwiDate,
  formatLayersParam,
  fwiDay,
  fwiOverlayUrl,
  gwisChosen,
  gwisCreditText,
  formatOverlayParam,
  loadOverlay,
  overlayStatus,
  parseOverlayParam,
  parseStaticSourcesParam,
  resetOverlaysForTest,
  setFwiDay,
  setLayersPanelOpen,
  setOverlays,
  startOverlaySync,
  toggleOverlay,
} from './layers.js';

const AVAILABLE_AT = '2026-09-28T06:30:00.000Z';
/** 2026-09-28 12:00 UTC — 15:00 in Sofia. */
const NOW = Date.parse('2026-09-28T12:00:00.000Z');

const FEATURES = { type: 'FeatureCollection', features: [] };

function proxyResponse(
  body: BodyInit | null,
  {
    status = 200,
    state = 'current',
    availableAt = AVAILABLE_AT,
    validFor,
  }: { status?: number; state?: string; availableAt?: string | null; validFor?: string } = {},
): Response {
  const headers = new Headers();
  if (state !== '') headers.set('x-fire-watch-overlay-state', state);
  if (availableAt !== null) headers.set('x-fire-watch-overlay-available-at', availableAt);
  if (validFor !== undefined) headers.set('x-fire-watch-overlay-valid-for', validFor);
  return new Response(body, { status, headers });
}

interface FakeDeps extends OverlayLoaderDeps {
  readonly requested: string[];
  readonly revoked: string[];
  clockMs: number;
}

function fakeDeps(answer: (url: string) => Response | Promise<Response>): FakeDeps {
  let objectUrls = 0;
  const deps: FakeDeps = {
    requested: [],
    revoked: [],
    clockMs: 1_000,
    fetch: (url) => {
      deps.requested.push(url);
      return Promise.resolve(answer(url));
    },
    createObjectURL: () => `blob:fwi-${String((objectUrls += 1))}`,
    revokeObjectURL: (url) => {
      deps.revoked.push(url);
    },
    now: () => deps.clockMs,
  };
  return deps;
}

const answerBoth = (url: string): Response =>
  url === OVERLAY_URLS.fwi
    ? proxyResponse(new Blob([new Uint8Array([137, 80, 78, 71])]), { validFor: '2026-09-28' })
    : proxyResponse(JSON.stringify(FEATURES));

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

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

async function renderPanel(messages: Messages = en): Promise<string> {
  const { html } = await prerender(
    <AppContext.Provider value={services(messages)}>
      <LayersToggle />
      <LayersPanel />
    </AppContext.Provider>,
  );
  return html.replace(/<script[\s\S]*?<\/script>/g, '');
}

beforeEach(() => {
  resetOverlaysForTest();
});

afterEach(() => {
  vi.unstubAllGlobals();
  resetOverlaysForTest();
});

describe('overlay URL seam', () => {
  it('parses canonically and tolerates unknown or repeated tokens', () => {
    expect(parseOverlayParam(null)).toBeNull();
    expect(parseOverlayParam('')).toEqual([]);
    expect(parseOverlayParam('ba,fwi')).toEqual(['fwi', 'ba']);
    expect(parseOverlayParam('ba, ba,gibs')).toEqual(['ba']);
  });

  it('formats in canonical order', () => {
    expect(formatOverlayParam(['ba', 'fwi'])).toBe('fwi,ba');
    expect(formatOverlayParam([])).toBe('');
  });
  it('carries the static hot-source mask as its own trailing token (F16)', () => {
    expect(parseOverlayParam('fwi,static')).toEqual(['fwi']);
    expect(parseStaticSourcesParam(null)).toBeNull();
    expect(parseStaticSourcesParam('fwi')).toBe(false);
    expect(parseStaticSourcesParam('static, ba')).toBe(true);
    expect(formatLayersParam(['ba', 'fwi'], true)).toBe('fwi,ba,static');
    expect(formatLayersParam([], true)).toBe('static');
    expect(formatLayersParam(['ba'], false)).toBe('ba');
  });
});

describe('the overlay choice', () => {
  it('is remembered in storage', () => {
    const stored = new Map<string, string>();
    vi.stubGlobal('window', {
      localStorage: {
        getItem: (key: string) => stored.get(key) ?? null,
        setItem: (key: string, value: string) => stored.set(key, value),
      },
    });
    toggleOverlay('ba');
    toggleOverlay('fwi');
    expect(chosenOverlays.value).toEqual(['fwi', 'ba']);
    expect(stored.get(LAYERS_STORAGE_KEY)).toBe('fwi,ba');
    expect(effisChosen.value).toBe(true);
    toggleOverlay('fwi');
    toggleOverlay('ba');
    expect(stored.get(LAYERS_STORAGE_KEY)).toBe('');
    expect(effisChosen.value).toBe(false);
  });

  it('makes the credits page owe the EFFIS credit exactly while an overlay is chosen', () => {
    expect(activeCreditConditions(DEFAULT_CONFIG, { effisOn: false })).not.toContain('layer:effis');
    expect(activeCreditConditions(DEFAULT_CONFIG, { effisOn: true })).toContain('layer:effis');
  });
});

describe('loadOverlay', () => {
  it('turns a current FWI copy into an object URL with its dates', async () => {
    const deps = fakeDeps(answerBoth);
    setOverlays(['fwi']);
    await loadOverlay('fwi', deps);
    expect(overlayStatus.value.fwi).toEqual({
      kind: 'ready',
      state: 'current',
      availableAt: AVAILABLE_AT,
      validFor: '2026-09-28',
      fetchedAtMs: 1_000,
    });
    expect(effisOverlayPayload.value).toEqual({ fwiImageUrl: 'blob:fwi-1', burntAreas: null });
  });

  it('revokes the previous object URL when a new copy replaces it', async () => {
    const deps = fakeDeps(answerBoth);
    await loadOverlay('fwi', deps);
    await loadOverlay('fwi', deps);
    expect(deps.revoked).toEqual(['blob:fwi-1']);
  });

  it('keeps burnt areas only while chosen', async () => {
    const deps = fakeDeps(answerBoth);
    await loadOverlay('ba', deps);
    expect(effisOverlayPayload.value.burntAreas).toBeNull();
    setOverlays(['ba']);
    expect(effisOverlayPayload.value.burntAreas).toEqual(FEATURES);
    expect(overlayStatus.value.ba).toMatchObject({ kind: 'ready', validFor: null });
  });

  it('passes a suspect copy through, flagged', async () => {
    const deps = fakeDeps(() => proxyResponse(JSON.stringify(FEATURES), { state: 'suspect' }));
    await loadOverlay('ba', deps);
    expect(overlayStatus.value.ba).toMatchObject({ kind: 'ready', state: 'suspect' });
  });

  it.each([
    ['a 503 (no copy yet)', () => proxyResponse('{}', { status: 503 })],
    ['a body that is not a FeatureCollection', () => proxyResponse('{"type":"Feature"}')],
    ['a body that is not JSON', () => proxyResponse('<html>')],
    ['no state header', () => proxyResponse(JSON.stringify(FEATURES), { state: '' })],
    ['an unknown state', () => proxyResponse(JSON.stringify(FEATURES), { state: 'rejected' })],
    ['no available-at date', () => proxyResponse(JSON.stringify(FEATURES), { availableAt: null })],
    ['a malformed date', () => proxyResponse(JSON.stringify(FEATURES), { availableAt: 'soon' })],
    [
      'a network failure',
      () => {
        throw new TypeError('offline');
      },
    ],
  ])('ends as unavailable on %s', async (_name, answer) => {
    const deps = fakeDeps(answer);
    await loadOverlay('ba', deps);
    expect(overlayStatus.value.ba).toEqual({ kind: 'unavailable' });
    expect(effisOverlayPayload.value.burntAreas).toBeNull();
  });

  it('drops a valid-for header that is not a date', async () => {
    const deps = fakeDeps(() =>
      proxyResponse(new Blob([new Uint8Array([1])]), { validFor: 'tomorrow' }),
    );
    await loadOverlay('fwi', deps);
    expect(overlayStatus.value.fwi).toMatchObject({ kind: 'ready', validFor: null });
  });
});

describe('startOverlaySync', () => {
  it('asks the proxy only for what is chosen, and only again once the copy is old', async () => {
    const deps = fakeDeps(answerBoth);
    const stop = startOverlaySync(deps);
    await flush();
    expect(deps.requested).toEqual([]);

    setOverlays(['fwi']);
    await flush();
    expect(deps.requested).toEqual([OVERLAY_URLS.fwi]);

    // Off and on again soon after: the copy in hand is still the proxy's newest.
    setOverlays([]);
    setOverlays(['fwi']);
    await flush();
    expect(deps.requested).toEqual([OVERLAY_URLS.fwi]);

    setOverlays([]);
    deps.clockMs += OVERLAY_REFETCH_AFTER_MS;
    setOverlays(['fwi', 'ba']);
    await flush();
    expect(deps.requested).toEqual([OVERLAY_URLS.fwi, OVERLAY_URLS.fwi, OVERLAY_URLS.ba]);
    stop();

    setOverlays([]);
    setOverlays(['fwi', 'ba']);
    await flush();
    expect(deps.requested).toHaveLength(3);
  });

  it('never asks anything but the proxy paths, never with a query', async () => {
    const deps = fakeDeps(answerBoth);
    const stop = startOverlaySync(deps);
    setOverlays(['fwi', 'ba']);
    await flush();
    stop();
    for (const url of deps.requested) expect(url).toMatch(/^\/overlays\/effis\/[a-z]+\.[a-z]+$/u);
  });
});

describe('LayersPanel', () => {
  it('is a closed disclosure by default, its panel present but hidden', async () => {
    const html = await renderPanel();
    expect(html).toContain(`aria-controls="${LAYERS_PANEL_ID}"`);
    expect(html).toContain('aria-expanded="false"');
    expect(html).toMatch(new RegExp(`<section[^>]*id="${LAYERS_PANEL_ID}"[^>]*hidden`));
    expect(html).toContain('>Layers</button>');
  });

  it('opens to the overlays, with nothing fetched and no credit while none is chosen', async () => {
    setLayersPanelOpen(true);
    const html = await renderPanel();
    expect(html).toContain('aria-expanded="true"');
    expect(html).not.toMatch(/<section[^>]*hidden/);
    expect(html).toContain('Fire danger (weather index)');
    expect(html).toContain('Burnt areas (last 7 days)');
    expect(html).not.toContain('European Forest Fire Information System');
    expect(html).not.toContain('Danger level');
  });

  it('shows the FWI legend, its own date and the EFFIS credit once chosen', async () => {
    setLayersPanelOpen(true);
    await loadOverlay('fwi', fakeDeps(answerBoth));
    setOverlays(['fwi']);
    const html = await renderPanel();
    expect(html).toContain('Danger level');
    for (const label of en.layers.fwiClasses) expect(html).toContain(label);
    expect(en.layers.fwiClasses).toHaveLength(FWI_CLASSES.length);
    expect(bg.layers.fwiClasses).toHaveLength(FWI_CLASSES.length);
    expect(html).toContain('For 28/09/2026');
    expect(html).not.toContain("Not today's index.");
    expect(html).toContain(effisCreditText({ epochNow: () => NOW }, en));
    expect(html).toContain('2026, European Forest Fire Information System (EFFIS)');
  });

  it("says so when the index is not today's", async () => {
    setLayersPanelOpen(true);
    await loadOverlay(
      'fwi',
      fakeDeps(() => proxyResponse(new Blob([new Uint8Array([1])]), { validFor: '2026-09-26' })),
    );
    setOverlays(['fwi']);
    expect(await renderPanel()).toContain("Not today's index.");
    expect(await renderPanel(bg)).toContain('Не е днешният индекс.');
  });

  it('dates the burnt areas by the copy, and flags a suspect one', async () => {
    setLayersPanelOpen(true);
    await loadOverlay(
      'ba',
      fakeDeps(() => proxyResponse(JSON.stringify(FEATURES), { state: 'suspect' })),
    );
    setOverlays(['ba']);
    const html = await renderPanel();
    expect(html).toContain('Copy dated 28/09, 09:30');
    expect(html).toContain(en.layers.suspect);
  });

  it('says an overlay is unavailable rather than showing nothing', async () => {
    setLayersPanelOpen(true);
    await loadOverlay(
      'ba',
      fakeDeps(() => proxyResponse('{}', { status: 503 })),
    );
    setOverlays(['ba']);
    expect(await renderPanel()).toContain('Not available right now.');
  });
});

describe('the FWI forecast day (V2-B1)', () => {
  const png = (validFor: string): Response =>
    proxyResponse(new Blob([new Uint8Array([137, 80, 78, 71])]), { validFor });

  it('names one allow-listed proxy file per day, never a date or a query', () => {
    expect(fwiOverlayUrl(0)).toBe(OVERLAY_URLS.fwi);
    expect(fwiOverlayUrl(1)).toBe('/overlays/effis/fwi-d1.png');
    expect(fwiOverlayUrl(9)).toBe('/overlays/effis/fwi-d9.png');
  });

  it('counts the expected date from the UTC day', () => {
    expect(expectedFwiDate('2026-09-28T23:30:00.000Z', 0)).toBe('2026-09-28');
    expect(expectedFwiDate('2026-09-28T23:30:00.000Z', 4)).toBe('2026-10-02');
    expect(expectedFwiDate('nonsense', 1)).toBeNull();
  });

  it('starts at today and owes the GWIS credit only for a day ahead', () => {
    expect(fwiDay.value).toBe(0);
    setOverlays(['fwi']);
    expect(gwisChosen.value).toBe(false);
    setFwiDay(3);
    expect(gwisChosen.value).toBe(true);
    setOverlays(['ba']);
    expect(gwisChosen.value).toBe(false);
    expect(activeCreditConditions(DEFAULT_CONFIG, { gwisOn: true })).toContain('layer:gwis');
    expect(activeCreditConditions(DEFAULT_CONFIG, { effisOn: true })).not.toContain('layer:gwis');
  });

  it('reloads on a new day, dropping the old raster from the map at once', async () => {
    const deps = fakeDeps((url) => png(url === OVERLAY_URLS.fwi ? '2026-09-28' : '2026-10-01'));
    const stop = startOverlaySync(deps);
    setOverlays(['fwi']);
    await flush();
    expect(effisOverlayPayload.value.fwiImageUrl).toBe('blob:fwi-1');

    setFwiDay(3);
    expect(effisOverlayPayload.value.fwiImageUrl).toBeNull();
    await flush();
    stop();
    expect(deps.requested).toEqual([OVERLAY_URLS.fwi, '/overlays/effis/fwi-d3.png']);
    expect(deps.revoked).toEqual(['blob:fwi-1']);
    expect(effisOverlayPayload.value.fwiImageUrl).toBe('blob:fwi-2');
    expect(overlayStatus.value.fwi).toMatchObject({ kind: 'ready', validFor: '2026-10-01' });
  });

  it('never lets a slower answer for the day the reader left overwrite the new one', async () => {
    let releaseToday: (response: Response) => void = () => {};
    const deps = fakeDeps((url) =>
      url === OVERLAY_URLS.fwi
        ? new Promise<Response>((resolve) => {
            releaseToday = resolve;
          })
        : png('2026-09-30'),
    );
    const stop = startOverlaySync(deps);
    setOverlays(['fwi']);
    await flush();
    setFwiDay(2);
    await flush();
    releaseToday(png('2026-09-28'));
    await flush();
    stop();
    expect(overlayStatus.value.fwi).toMatchObject({ kind: 'ready', validFor: '2026-09-30' });
    expect(effisOverlayPayload.value.fwiImageUrl).toBe('blob:fwi-1');
  });

  it('dates a day ahead by the copy, says it is relayed, and credits GWIS', async () => {
    setLayersPanelOpen(true);
    setOverlays(['fwi']);
    setFwiDay(2);
    await loadOverlay(
      'fwi',
      fakeDeps(() => png('2026-09-30')),
    );
    const html = await renderPanel();
    expect(html).toContain('Forecast day');
    expect(html).toContain('+2 days');
    expect(html).toContain('EFFIS/GWIS forecast for 30/09/2026, relayed as published');
    expect(html).not.toContain(en.layers.fwiForecastBehind);
    expect(html).not.toContain("Not today's index.");
    expect(html).toContain(gwisCreditText({ epochNow: () => NOW }, en));
    expect(html).toContain('Global Wildfire Information System (GWIS)');
    expect(await renderPanel(bg)).toContain('Прогноза на EFFIS/GWIS за 30.09.2026');
  });

  it('flags a forecast copy the proxy has not yet moved to the picked date', async () => {
    setLayersPanelOpen(true);
    setOverlays(['fwi']);
    setFwiDay(2);
    await loadOverlay(
      'fwi',
      fakeDeps(() => png('2026-09-29')),
    );
    expect(await renderPanel()).toContain(en.layers.fwiForecastBehind);
  });
});
