/**
 * TASKS F18, web half: the lightning layer's loading, its Layers-panel legend and honest
 * "as of" line, and the EUMETSAT credit — only while the layer is chosen. The loader reads
 * the committed fixture, the server route's shape.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import prerender from 'preact-iso/prerender';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DEFAULT_CONFIG, withDataSource } from '../core/config.js';
import bg from '../core/i18n/bg.js';
import en from '../core/i18n/en.js';
import type { Messages } from '../core/i18n/messages.js';
import { parseLightningOverlay } from '../core/lightning.js';
import type { FireEventStore } from '../core/types.js';
import { AppContext } from './context.js';
import type { AppServices } from './context.js';
import { LayersPanel } from './layers-panel.js';
import {
  OVERLAY_URLS,
  type OverlayLoaderDeps,
  effisChosen,
  lightningChosen,
  lightningOverlayPayload,
  loadOverlay,
  overlayStatus,
  resetOverlaysForTest,
  setLayersPanelOpen,
  setOverlays,
} from './layers.js';
import { eumetsatCreditText } from './lightning.js';
import { planRevalidation } from './overlay-refresh.js';

const FIXTURE_TEXT = readFileSync(
  fileURLToPath(new URL('../../public/fixtures/lightning/recent.json', import.meta.url)),
  'utf8',
);
const FIXTURE = parseLightningOverlay(JSON.parse(FIXTURE_TEXT));

/** Five minutes after the fixture's newest product: 15:35 in Sofia (EEST). */
const NOW = Date.parse('2026-09-30T12:35:00.000Z');
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

function services(messages: Messages, serverNow = NOW): AppServices {
  return {
    store: {} as FireEventStore,
    clock,
    serverNow: () => serverNow,
    config: DEFAULT_CONFIG,
    geolocator: { locate: () => Promise.reject(new Error('not asked')) },
    locale: messages === bg ? 'bg' : 'en',
    messages,
    setLocale: () => {},
  };
}

async function renderPanel(messages: Messages = en, serverNow = NOW): Promise<string> {
  const { html } = await prerender(
    <AppContext.Provider value={services(messages, serverNow)}>
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

describe('loading the lightning layer', () => {
  it('takes the body, and its "as of", from the response', async () => {
    const requested: string[] = [];
    await loadOverlay('lightning', deps(fixtureAnswer, requested));
    expect(requested).toEqual([OVERLAY_URLS.lightning]);
    expect(overlayStatus.value.lightning).toMatchObject({
      kind: 'ready',
      state: 'current',
      availableAt: '2026-09-30T12:34:12Z',
      validAt: '2026-09-30T12:30:00Z',
    });
    // Drawn only while chosen.
    expect(lightningOverlayPayload.value).toBeNull();
    setOverlays(['lightning']);
    expect(lightningOverlayPayload.value).toEqual(FIXTURE);
  });

  it('follows the configured URL (the fixtures build) and the API route live', async () => {
    const requested: string[] = [];
    await loadOverlay('lightning', {
      ...deps(fixtureAnswer, requested),
      urls: { lightning: '/fixtures/lightning/recent.json' },
    });
    expect(requested).toEqual(['/fixtures/lightning/recent.json']);
    expect(DEFAULT_CONFIG.lightningOverlayUrl).toBe('/fixtures/lightning/recent.json');
    expect(withDataSource(DEFAULT_CONFIG, 'live').lightningOverlayUrl).toBe(OVERLAY_URLS.lightning);
  });

  it('is unavailable, and draws nothing, for an error or a body it cannot draw', async () => {
    for (const answer of [
      () => new Response('{}', { status: 503 }),
      () => new Response('{"schema_version":2}', { status: 200 }),
      () => new Response('not json', { status: 200 }),
    ]) {
      resetOverlaysForTest();
      setOverlays(['lightning']);
      await loadOverlay('lightning', deps(answer));
      expect(overlayStatus.value.lightning).toEqual({ kind: 'unavailable' });
      expect(lightningOverlayPayload.value).toBeNull();
    }
  });

  it('asks for a fresh copy every few minutes, not once a forecast hour', async () => {
    await loadOverlay('lightning', deps(fixtureAnswer));
    const status = overlayStatus.value.lightning;
    // Fetched at monotonic 1 000 ms, `covered_through` already past: the 5-minute cadence.
    expect(planRevalidation(status, NOW, 1_000)).toEqual({ kind: 'wait', ms: 5 * 60_000 });
    expect(planRevalidation(status, NOW, 1_000 + 5 * 60_000)).toEqual({ kind: 'due' });
  });
});

describe('the lightning choice and its credit', () => {
  it('is not an EFFIS choice', () => {
    setOverlays(['lightning']);
    expect(lightningChosen.value).toBe(true);
    expect(effisChosen.value).toBe(false);
  });

  it('renders the EUMETSAT credit from the registry, with its year', () => {
    const text = eumetsatCreditText(clock, en);
    expect(text).toBe('Contains modified EUMETSAT Meteosat data 2026');
  });
});

describe('the Layers panel with lightning', () => {
  it('offers lightning, with no legend and no EUMETSAT credit while it is off', async () => {
    setLayersPanelOpen(true);
    const html = await renderPanel();
    expect(html).toContain(en.layers.lightning);
    expect(html).toContain(en.layers.lightningNote);
    expect(html).not.toContain(en.layers.lightningLegendTitle);
    expect(html).not.toContain(eumetsatCreditText(clock, en));
  });

  it('shows the legend, the "as of" line and the credit once chosen', async () => {
    setLayersPanelOpen(true);
    await loadOverlay('lightning', deps(fixtureAnswer));
    setOverlays(['lightning']);
    for (const messages of [en, bg]) {
      const html = await renderPanel(messages);
      expect(html).toContain(messages.layers.lightningLegendTitle);
      for (const label of messages.layers.lightningClasses) expect(html).toContain(label);
      expect(html).not.toContain(messages.layers.lightningNone);
      expect(html).toContain(eumetsatCreditText(clock, messages));
    }
    // 12:30 UTC is 15:30 in Sofia; the same day, so the time alone.
    expect(await renderPanel()).toContain(en.layers.lightningAsOf('15:30'));
  });

  it('says so when the copy holds no flash young enough to draw, and dates an old one', async () => {
    setLayersPanelOpen(true);
    await loadOverlay('lightning', deps(fixtureAnswer));
    setOverlays(['lightning']);
    const nextDay = Date.parse('2026-10-01T09:00:00.000Z');
    const html = await renderPanel(en, nextDay);
    expect(html).toContain(en.layers.lightningNone);
    expect(html).toContain(en.layers.lightningAsOf('30/09, 15:30'));
  });
});
