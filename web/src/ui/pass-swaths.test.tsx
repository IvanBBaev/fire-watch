/**
 * TASKS F15, web half: the swath layer's loading, its Layers-panel legend (the passes in
 * words, recent and next re-decided against the reader's clock), the "expired" line once
 * the document's window is over, and the CelesTrak credit only while the layer is chosen.
 * The loader reads the committed fixture, which is the server's real output.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import prerender from 'preact-iso/prerender';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DEFAULT_CONFIG, withDataSource } from '../core/config.js';
import bg from '../core/i18n/bg.js';
import en from '../core/i18n/en.js';
import type { Messages } from '../core/i18n/messages.js';
import { parsePassSwaths, type SwathPassSummary } from '../core/pass-swaths.js';
import type { FireEventStore } from '../core/types.js';
import { AppContext } from './context.js';
import type { AppServices } from './context.js';
import { LayersPanel } from './layers-panel.js';
import {
  OVERLAY_URLS,
  type OverlayLoaderDeps,
  effisChosen,
  loadOverlay,
  overlayStatus,
  passSwathsPayload,
  resetOverlaysForTest,
  setLayersPanelOpen,
  setOverlays,
  swathsChosen,
} from './layers.js';
import { nearestPasses } from './pass-swaths-option.js';
import { celestrakCredit } from './passes.js';

const FIXTURE_TEXT = readFileSync(
  fileURLToPath(new URL('../../public/fixtures/passes/swaths.json', import.meta.url)),
  'utf8',
);
const FIXTURE = parsePassSwaths(JSON.parse(FIXTURE_TEXT));
if (FIXTURE === null) throw new Error('the committed swath fixture must parse');

const MINUTE_MS = 60_000;
/** Five minutes after the fixture's own moment: its window is open. */
const NOW = Date.parse(FIXTURE.computed_for) + 5 * MINUTE_MS;
/** Half an hour after its window closed. */
const AFTER = Date.parse(FIXTURE.window.to) + 30 * MINUTE_MS;

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

function services(messages: Messages, nowMs: number): AppServices {
  return {
    store: {} as FireEventStore,
    clock: { epochNow: () => nowMs, monotonicNow: () => 0 },
    serverNow: () => nowMs,
    config: DEFAULT_CONFIG,
    geolocator: { locate: () => Promise.reject(new Error('not asked')) },
    locale: messages === bg ? 'bg' : 'en',
    messages,
    setLocale: () => {},
  };
}

async function renderPanel(messages: Messages = en, nowMs = NOW): Promise<string> {
  const { html } = await prerender(
    <AppContext.Provider value={services(messages, nowMs)}>
      <LayersPanel />
    </AppContext.Provider>,
  );
  return html.replace(/<script[\s\S]*?<\/script>/g, '');
}

const credit = (messages: Messages): string =>
  celestrakCredit({ epochNow: () => NOW }, messages)?.text ?? '';

beforeEach(() => {
  resetOverlaysForTest();
});

afterEach(() => {
  resetOverlaysForTest();
});

describe('loading the swath layer', () => {
  it('takes the document from the response, dated by the moment it was computed for', async () => {
    const requested: string[] = [];
    await loadOverlay('swaths', deps(fixtureAnswer, requested));
    expect(requested).toEqual([OVERLAY_URLS.swaths]);
    expect(overlayStatus.value.swaths).toMatchObject({
      kind: 'ready',
      availableAt: FIXTURE.computed_for,
      validAt: FIXTURE.computed_for,
    });
    // Drawn only while chosen.
    expect(passSwathsPayload.value).toBeNull();
    setOverlays(['swaths']);
    expect(passSwathsPayload.value).toEqual(FIXTURE);
  });

  it('follows the configured URL: the committed fixture, or the live route', async () => {
    const requested: string[] = [];
    await loadOverlay('swaths', {
      ...deps(fixtureAnswer, requested),
      urls: { swaths: '/fixtures/passes/swaths.json' },
    });
    expect(requested).toEqual(['/fixtures/passes/swaths.json']);
    expect(DEFAULT_CONFIG.passSwathsUrl).toBe('/fixtures/passes/swaths.json');
    expect(withDataSource(DEFAULT_CONFIG, 'live').passSwathsUrl).toBe(OVERLAY_URLS.swaths);
  });

  it('is unavailable, and draws nothing, for an error or a body it cannot draw', async () => {
    for (const answer of [
      () => new Response('{}', { status: 503 }),
      () => new Response('{"type":"FeatureCollection","schema_version":2}', { status: 200 }),
      () => new Response('not json', { status: 200 }),
    ]) {
      resetOverlaysForTest();
      setOverlays(['swaths']);
      await loadOverlay('swaths', deps(answer));
      expect(overlayStatus.value.swaths).toEqual({ kind: 'unavailable' });
      expect(passSwathsPayload.value).toBeNull();
    }
  });

  it('is not an EFFIS choice', () => {
    setOverlays(['swaths']);
    expect(swathsChosen.value).toBe(true);
    expect(effisChosen.value).toBe(false);
  });
});

describe('nearestPasses', () => {
  const pass = (mid: string, kind: SwathPassSummary['kind']): SwathPassSummary => ({
    platform: 'noaa20',
    mid,
    kind,
  });
  it('lists the soonest next passes first and the latest recent passes first, capped', () => {
    const passes = [
      pass('2026-09-30T08:00:00Z', 'recent'),
      pass('2026-09-30T09:00:00Z', 'recent'),
      pass('2026-09-30T10:00:00Z', 'recent'),
      pass('2026-09-30T11:00:00Z', 'recent'),
      ...[20, 15, 23, 14, 16, 22, 18].map((h) => pass(`2026-09-30T${String(h)}:00:00Z`, 'next')),
    ];
    expect(nearestPasses(passes, 'recent').map((p) => p.mid.slice(11, 13))).toEqual([
      '11',
      '10',
      '09',
    ]);
    expect(nearestPasses(passes, 'next').map((p) => p.mid.slice(11, 13))).toEqual([
      '14',
      '15',
      '16',
      '18',
      '20',
    ]);
  });
});

describe('the Layers panel with swaths', () => {
  it('offers the layer, with no legend and no CelesTrak credit while it is off', async () => {
    setLayersPanelOpen(true);
    const html = await renderPanel();
    expect(html).toContain(en.layers.swaths);
    expect(html).not.toContain(en.layers.swathsNext);
    // The pass times section below always credits CelesTrak; the layer's own line is absent.
    expect(html).not.toContain(`<p class="layers-credit">${credit(en)}`);
  });

  it('lists next and recent passes, says it is a prediction, and credits CelesTrak', async () => {
    setLayersPanelOpen(true);
    await loadOverlay('swaths', deps(fixtureAnswer));
    setOverlays(['swaths']);
    for (const messages of [en, bg]) {
      const html = await renderPanel(messages);
      expect(html).toContain(messages.layers.swathsNext);
      expect(html).toContain(messages.layers.swathsRecent);
      expect(html).not.toContain(messages.passes.expired);
      expect(html).toContain(`<p class="layers-credit">${credit(messages)}`);
    }
    const html = await renderPanel();
    expect(html).toContain('Predicted from orbital elements, computed for ');
    // 13:15 UTC is 16:15 in Sofia: the next pass is S3B's 19:32 UTC → 22:32.
    expect(html).toContain(en.layers.swathsPassAt('Sentinel-3B · SLSTR', '22:32'));
    // The latest recent one is NOAA-20's 12:38:30 UTC → 15:38.
    expect(html).toContain(en.layers.swathsPassAt('NOAA-20 · VIIRS', '15:38'));
  });

  it('says the prediction has expired, listing nothing ahead, once its window is over', async () => {
    setLayersPanelOpen(true);
    await loadOverlay('swaths', deps(fixtureAnswer));
    setOverlays(['swaths']);
    const html = await renderPanel(en, AFTER);
    expect(html).toContain(en.passes.expired);
    const next = html.slice(
      html.indexOf(en.layers.swathsNext),
      html.indexOf(en.layers.swathsRecent),
    );
    expect(next).toContain(en.passes.none);
    expect(next).not.toContain('<li');
  });
});
