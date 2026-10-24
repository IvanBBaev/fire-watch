/**
 * V2-A4, web half: the estimated-outline layer's loading, its Layers-panel legend and honest
 * "as of" line, the FIRMS credit while it is chosen, and the event panel's area sentence.
 * The loader reads the committed fixture, the server route's shape.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import prerender from 'preact-iso/prerender';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DEFAULT_CONFIG, withDataSource } from '../core/config.js';
import { parseFireOutlineOverlay, type FireOutlineProperties } from '../core/fire-outlines.js';
import bg from '../core/i18n/bg.js';
import en from '../core/i18n/en.js';
import type { Messages } from '../core/i18n/messages.js';
import type { FireEventStore } from '../core/types.js';
import { AppContext } from './context.js';
import type { AppServices } from './context.js';
import { fireOutlineText } from './event/fire-outline-note.js';
import { FIRE_OUTLINE_CREDIT_ID, firmsCreditText } from './fire-outlines.js';
import { LayersPanel } from './layers-panel.js';
import {
  OUTLINES_RETRY_MS,
  OVERLAY_URLS,
  type OverlayLoaderDeps,
  effisChosen,
  fireOutlinesBody,
  fireOutlinesPayload,
  lightningChosen,
  loadOverlay,
  outlinesChosen,
  overlayStatus,
  resetOverlaysForTest,
  setLayersPanelOpen,
  setOverlays,
} from './layers.js';
import { planRevalidation } from './overlay-refresh.js';

const FIXTURE_TEXT = readFileSync(
  fileURLToPath(new URL('../../public/fixtures/outlines/active.json', import.meta.url)),
  'utf8',
);
const FIXTURE = parseFireOutlineOverlay(JSON.parse(FIXTURE_TEXT));

/** The morning of the fixture's pass: 09:58Z is 12:58 in Sofia (EEST). */
const NOW = Date.parse('2026-08-09T10:05:00.000Z');
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

describe('loading the estimated outlines', () => {
  it('takes the body, and its "as of", from the pass that drew it', async () => {
    expect(FIXTURE).not.toBeNull();
    const requested: string[] = [];
    await loadOverlay('outlines', deps(fixtureAnswer, requested));
    expect(requested).toEqual([OVERLAY_URLS.outlines]);
    expect(overlayStatus.value.outlines).toMatchObject({
      kind: 'ready',
      state: 'current',
      availableAt: '2026-08-09T09:58:00Z',
      validAt: '2026-08-09T09:58:00Z',
    });
    // The event panel can read it either way; the map draws it only while chosen.
    expect(fireOutlinesBody.value).toEqual(FIXTURE);
    expect(fireOutlinesPayload.value).toBeNull();
    setOverlays(['outlines']);
    expect(fireOutlinesPayload.value).toEqual(FIXTURE);
  });

  it('follows the configured URL (the fixtures build) and the API route live', async () => {
    const requested: string[] = [];
    await loadOverlay('outlines', {
      ...deps(fixtureAnswer, requested),
      urls: { outlines: '/fixtures/outlines/active.json' },
    });
    expect(requested).toEqual(['/fixtures/outlines/active.json']);
    expect(DEFAULT_CONFIG.fireOutlineOverlayUrl).toBe('/fixtures/outlines/active.json');
    expect(withDataSource(DEFAULT_CONFIG, 'live').fireOutlineOverlayUrl).toBe(
      OVERLAY_URLS.outlines,
    );
  });

  it('is unavailable, and draws nothing, for a stale pass or a body it cannot draw', async () => {
    for (const answer of [
      () => new Response('{}', { status: 503 }),
      () => new Response('{"schema_version":2}', { status: 200 }),
      () => new Response('not json', { status: 200 }),
    ]) {
      resetOverlaysForTest();
      setOverlays(['outlines']);
      await loadOverlay('outlines', deps(answer));
      expect(overlayStatus.value.outlines).toEqual({ kind: 'unavailable' });
      expect(fireOutlinesPayload.value).toBeNull();
      expect(fireOutlinesBody.value).toBeNull();
    }
  });

  it('asks for a fresh copy on the worker cadence', async () => {
    await loadOverlay('outlines', deps(fixtureAnswer));
    const status = overlayStatus.value.outlines;
    expect(planRevalidation(status, NOW, 1_000)).toEqual({ kind: 'wait', ms: OUTLINES_RETRY_MS });
    expect(planRevalidation(status, NOW, 1_000 + OUTLINES_RETRY_MS)).toEqual({ kind: 'due' });
  });
});

describe('the outlines choice and its credit', () => {
  it('is its own choice', () => {
    setOverlays(['outlines']);
    expect(outlinesChosen.value).toBe(true);
    expect(lightningChosen.value).toBe(false);
    expect(effisChosen.value).toBe(false);
  });

  it('renders the FIRMS acknowledgement from the registry', () => {
    expect(FIRE_OUTLINE_CREDIT_ID).toBe('firms-acknowledgement');
    expect(firmsCreditText(clock, en)).toMatch(/^We acknowledge the use of data/u);
    expect(firmsCreditText(clock, en)).toContain('FIRMS');
  });
});

describe('the Layers panel with estimated outlines', () => {
  it('offers the outlines with their caveat, and no legend or credit while off', async () => {
    setLayersPanelOpen(true);
    const html = await renderPanel();
    expect(html).toContain(en.layers.outlines);
    expect(html).toContain(en.layers.outlinesNote);
    expect(html).not.toContain('layers-swatch-outline');
    expect(html).not.toContain(firmsCreditText(clock, en));
  });

  it('shows the legend, the "as of" line and the FIRMS credit once chosen', async () => {
    setLayersPanelOpen(true);
    await loadOverlay('outlines', deps(fixtureAnswer));
    setOverlays(['outlines']);
    for (const messages of [en, bg]) {
      const html = await renderPanel(messages);
      expect(html).toContain('layers-swatch-outline');
      expect(html).toContain(messages.layers.outlinesLegend);
      expect(html).not.toContain(messages.layers.outlinesNone);
      expect(html).not.toContain(messages.layers.outlinesTruncated);
      expect(html).toContain(firmsCreditText(clock, messages));
    }
    // 09:58 UTC is 12:58 in Sofia; the same day, so the time alone.
    expect(await renderPanel()).toContain(en.layers.outlinesAsOf('12:58'));
    expect(await renderPanel(bg)).toContain(bg.layers.outlinesAsOf('12:58'));
  });

  it('says so when a current copy holds no outline, and when the set was capped', async () => {
    setLayersPanelOpen(true);
    const empty = JSON.stringify({ ...JSON.parse(FIXTURE_TEXT), features: [], truncated: true });
    await loadOverlay(
      'outlines',
      deps(() => new Response(empty, { status: 200 })),
    );
    setOverlays(['outlines']);
    const html = await renderPanel();
    expect(html).toContain(en.layers.outlinesNone);
    expect(html).toContain(en.layers.outlinesTruncated);
  });
});

describe('the event panel area sentence', () => {
  const outline: FireOutlineProperties = FIXTURE!.features[0]!.properties;

  it('gives the area, its upper bound, the edge and the pixel count, with no lower bound at 0', () => {
    for (const messages of [en, bg]) {
      const text = fireOutlineText(outline, messages);
      expect(text).toBe(
        messages.eventDetail.fireOutlineArea(
          messages.areaBothUnits(110.8),
          null,
          messages.areaBothUnits(331.3),
          0.3,
          4,
        ),
      );
    }
  });

  it('gives the full band when the lower bound is above zero', () => {
    const banded = { ...outline, area_low_ha: 40 };
    expect(fireOutlineText(banded, en)).toContain(en.areaBothUnits(40));
    expect(fireOutlineText(banded, en)).toContain(en.areaBothUnits(331.3));
  });

  it('never calls the outline a perimeter except to say it is not an official one', () => {
    for (const messages of [en, bg]) {
      const texts = [
        fireOutlineText(outline, messages),
        fireOutlineText({ ...outline, area_low_ha: 40, footprints: 1 }, messages),
        messages.eventDetail.fireOutlineCaveat,
        messages.layers.outlinesNote,
      ];
      for (const text of texts) {
        if (/perimeter/iu.test(text)) expect(text).toMatch(/not an official/iu);
        expect(text).not.toMatch(/forecast(?:s|ed)? (?:to|that)|will spread/iu);
      }
    }
    expect(en.eventDetail.fireOutlineCaveat).toContain('not an official fire perimeter');
  });
});
