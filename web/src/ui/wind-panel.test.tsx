/**
 * TASKS F14, web half: the wind layer's loading, its Layers-panel legend and time line, and
 * the ECMWF credits — all five, and only while the layer is chosen. The loader reads the
 * committed fixture, which is the server route's real output.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { ecmwfComponents } from '@fire-watch/contracts';
import prerender from 'preact-iso/prerender';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DEFAULT_CONFIG, withDataSource } from '../core/config.js';
import bg from '../core/i18n/bg.js';
import en from '../core/i18n/en.js';
import type { Messages } from '../core/i18n/messages.js';
import type { FireEventStore } from '../core/types.js';
import { WIND_SPEED_CLASSES, parseWindOverlay } from '../core/wind.js';
import { AppContext } from './context.js';
import type { AppServices } from './context.js';
import { activeCreditConditions } from './logic/credits.js';
import { LayersPanel, windValidLine } from './layers-panel.js';
import {
  OVERLAY_URLS,
  type OverlayLoaderDeps,
  ecmwfCreditTexts,
  effisChosen,
  loadOverlay,
  overlayStatus,
  resetOverlaysForTest,
  setLayersPanelOpen,
  setOverlays,
  windChosen,
  windOverlayPayload,
} from './layers.js';

const FIXTURE_TEXT = readFileSync(
  fileURLToPath(new URL('../../public/fixtures/wind/latest.json', import.meta.url)),
  'utf8',
);
const FIXTURE = parseWindOverlay(JSON.parse(FIXTURE_TEXT));

/** 2026-09-30 12:00 UTC — the fixture's run day, 15:00 in Sofia. */
const NOW = Date.parse('2026-09-30T12:00:00.000Z');
const clock = { epochNow: () => NOW, monotonicNow: () => 0 };

function deps(answer: () => Response, requested: string[] = []): OverlayLoaderDeps {
  return {
    fetch: (url) => {
      requested.push(url);
      return Promise.resolve(answer());
    },
    createObjectURL: () => 'blob:unused',
    revokeObjectURL: () => {},
    now: () => 1_000,
  };
}

const fixtureAnswer = () => new Response(FIXTURE_TEXT, { status: 200 });

function services(messages: Messages): AppServices {
  return {
    store: {} as FireEventStore,
    clock,
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
      <LayersPanel />
    </AppContext.Provider>,
  );
  return html.replace(/<script[\s\S]*?<\/script>/g, '');
}

beforeEach(() => {
  resetOverlaysForTest();
});

afterEach(() => {
  resetOverlaysForTest();
});

describe('loading the wind layer', () => {
  it('takes the body, and its times, from the response', async () => {
    const requested: string[] = [];
    await loadOverlay('wind', deps(fixtureAnswer, requested));
    expect(requested).toEqual([OVERLAY_URLS.wind]);
    expect(overlayStatus.value.wind).toMatchObject({
      kind: 'ready',
      state: 'current',
      availableAt: '2026-09-30T07:40:00Z',
    });
    // Drawn only while chosen.
    expect(windOverlayPayload.value).toBeNull();
    setOverlays(['wind']);
    expect(windOverlayPayload.value).toEqual(FIXTURE);
  });

  it('follows the configured URL (the fixtures build)', async () => {
    const requested: string[] = [];
    await loadOverlay('wind', {
      ...deps(fixtureAnswer, requested),
      urls: { wind: '/fixtures/wind/latest.json' },
    });
    expect(requested).toEqual(['/fixtures/wind/latest.json']);
    expect(DEFAULT_CONFIG.windOverlayUrl).toBe('/fixtures/wind/latest.json');
    expect(withDataSource(DEFAULT_CONFIG, 'live').windOverlayUrl).toBe(OVERLAY_URLS.wind);
  });

  it('is unavailable, and draws nothing, for an error or a body it cannot draw', async () => {
    setOverlays(['wind']);
    for (const answer of [
      () => new Response('{}', { status: 503 }),
      () => new Response('{"schema_version":2}', { status: 200 }),
      () => new Response('not json', { status: 200 }),
    ]) {
      resetOverlaysForTest();
      setOverlays(['wind']);
      await loadOverlay('wind', deps(answer));
      expect(overlayStatus.value.wind).toEqual({ kind: 'unavailable' });
      expect(windOverlayPayload.value).toBeNull();
    }
  });
});

describe('the wind choice and its credit', () => {
  it('is not an EFFIS choice', () => {
    setOverlays(['wind']);
    expect(windChosen.value).toBe(true);
    expect(effisChosen.value).toBe(false);
  });

  it('makes the credits page owe the ECMWF components exactly while chosen', () => {
    expect(activeCreditConditions(DEFAULT_CONFIG, { windOn: false })).not.toContain(
      'derived:ecmwf',
    );
    expect(activeCreditConditions(DEFAULT_CONFIG, { windOn: true })).toContain('derived:ecmwf');
  });

  it('renders every ECMWF component', () => {
    const texts = ecmwfCreditTexts(clock, en);
    expect(texts).toHaveLength(ecmwfComponents().length);
    expect(texts.join('\n')).toContain('ECMWF');
    for (const text of texts) expect(text).not.toMatch(/\{\{|\[YEAR\]/u);
  });
});

describe('the Layers panel with wind', () => {
  it('offers wind, with no legend and no ECMWF credit while it is off', async () => {
    setLayersPanelOpen(true);
    const html = await renderPanel();
    expect(html).toContain(en.layers.wind);
    expect(html).not.toContain(en.layers.windLegendTitle);
    for (const text of ecmwfCreditTexts(clock, en)) expect(html).not.toContain(text);
  });

  it('shows the legend, the forecast hour and run, and all five credits once chosen', async () => {
    setLayersPanelOpen(true);
    await loadOverlay('wind', deps(fixtureAnswer));
    setOverlays(['wind']);
    for (const messages of [en, bg]) {
      const html = await renderPanel(messages);
      expect(html).toContain(messages.layers.windLegendTitle);
      expect(messages.layers.windClasses).toHaveLength(WIND_SPEED_CLASSES.length);
      for (const label of messages.layers.windClasses) expect(html).toContain(label);
      for (const text of ecmwfCreditTexts(clock, messages)) {
        expect(html).toContain(text.replace(/&/gu, '&amp;'));
      }
    }
    // 00:00 UTC is 03:00 in Sofia (EEST).
    expect(await renderPanel()).toContain('For 03:00 (ECMWF run 30/09, 03:00)');
  });

  it('dates the forecast hour when it is not today in Sofia', () => {
    if (FIXTURE === null) throw new Error('fixture must parse');
    expect(windValidLine(FIXTURE, en, 'en', '2026-10-01T12:00:00.000Z')).toBe(
      'For 30/09, 03:00 (ECMWF run 30/09, 03:00)',
    );
  });
});
