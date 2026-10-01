/**
 * TASKS F17, web half: the per-pass cloud chip, the caveat and the ECMWF credit in the
 * satellite-pass section, and the credits page's `cloudOn` condition. Renders the fixture
 * document (real ECMWF `tcc` bytes through the server path) at its own `computed_for`.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { creditsFor, ecmwfComponents } from '@fire-watch/contracts';
import prerender from 'preact-iso/prerender';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DEFAULT_CONFIG } from '../core/config.js';
import bg from '../core/i18n/bg.js';
import en from '../core/i18n/en.js';
import type { Messages } from '../core/i18n/messages.js';
import { parsePassesDocument, type PassesDoc } from '../core/passes.js';
import type { FireEventStore } from '../core/types.js';
import { AppContext, type AppServices } from './context.js';
import { chosenOverlays, ecmwfCreditTexts, setLayersPanelOpen } from './layers.js';
import { activeCreditConditions } from './logic/credits.js';
import { passesCloudOn } from './pass-cloud.js';
import { passesStatus, resetPassesForTest } from './passes.js';
import { SatellitePasses } from './satellite-passes.js';

const DOC = parsePassesDocument(
  JSON.parse(
    readFileSync(
      fileURLToPath(new URL('../../public/fixtures/passes/sample.json', import.meta.url)),
      'utf8',
    ),
  ),
) as PassesDoc;
const NOW = Date.parse(DOC.computed_for);

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

async function render(doc: PassesDoc, messages: Messages = en): Promise<string> {
  setLayersPanelOpen(true);
  passesStatus.value = { kind: 'ready', cell: doc.cell, doc, fetchedAtMs: 0 };
  const { html } = await prerender(
    <AppContext.Provider value={services(messages)}>
      <SatellitePasses />
    </AppContext.Provider>,
  );
  return html.replace(/<script[\s\S]*?<\/script>/g, '');
}

const row = (html: string, id: string) =>
  new RegExp(`data-platform="${id}"[\\s\\S]*?</li>`, 'u').exec(html)?.[0] ?? '';

/** The fixture with every pass's forecast set to `pct` (`null` clears them). */
function withCloud(pct: number | null, cloud: PassesDoc['cloud'] = DOC.cloud): PassesDoc {
  return {
    ...DOC,
    cloud,
    platforms: DOC.platforms.map((p) => ({
      ...p,
      passes: p.passes.map((x) => ({ ...x, cloud_forecast_pct: pct })),
    })),
  };
}

beforeEach(() => {
  resetPassesForTest();
  chosenOverlays.value = [];
});

afterEach(() => {
  resetPassesForTest();
  setLayersPanelOpen(false);
  chosenOverlays.value = [];
});

describe('the pass section with a cloud forecast', () => {
  it('puts the forecast next to the look that has one, and nothing on one without', async () => {
    const html = await render(DOC);
    // NOAA-20's last look (10:57:55Z) falls between the 06 and 12 h steps: 79 %.
    expect(row(html, 'noaa20')).toContain(en.passes.cloudForecast(en.passes.cloudCloudy, 79));
    expect(row(html, 'noaa20')).toContain('data-cloud-level="cloudy"');
    // Suomi NPP's (12:18:49Z) is past the last recorded step: no forecast, not a guess.
    expect(row(html, 'snpp')).not.toContain('pass-cloud"');
  });

  it.each([
    [10, 'clear', en.passes.cloudClear],
    [50, 'partly', en.passes.cloudPartly],
    [90, 'cloudy', en.passes.cloudCloudy],
  ] as const)('reads %i %% as %s', async (pct, level, word) => {
    const html = await render(withCloud(pct));
    expect(html).toContain(`data-cloud-level="${level}"`);
    expect(html).toContain(en.passes.cloudForecast(word, pct));
  });

  it('says once that it is a forecast and that a fire under cloud may be missed', async () => {
    const html = await render(DOC);
    expect(html.split(en.passes.cloudCaveat)).toHaveLength(2);
  });

  it('prints all five ECMWF components with it, once', async () => {
    const html = await render(DOC);
    const texts = ecmwfCreditTexts({ epochNow: () => NOW }, en);
    expect(texts).toHaveLength(ecmwfComponents().length);
    for (const text of texts) expect(html.split(text)).toHaveLength(2);
  });

  it('leaves the ECMWF lines to the panel while the wind layer already prints them', async () => {
    chosenOverlays.value = ['wind'];
    const html = await render(DOC);
    for (const text of ecmwfCreditTexts({ epochNow: () => NOW }, en)) {
      expect(html).not.toContain(text);
    }
    // The caveat still stands: it is about the pass, not the credit.
    expect(html).toContain(en.passes.cloudCaveat);
  });

  it('renders in Bulgarian', async () => {
    const html = await render(DOC, bg);
    expect(html).toContain(bg.passes.cloudForecast(bg.passes.cloudCloudy, 79));
    expect(html).toContain(bg.passes.cloudCaveat);
  });
});

describe('the pass section without a cloud forecast', () => {
  it.each([
    ['no cloud block (an older server)', withCloud(null, null)],
    ['a block that answered no pass', withCloud(null, { ...DOC.cloud!, runs: [] })],
  ])('shows no chip, no caveat and no ECMWF credit for %s', async (_label, doc) => {
    const html = await render(doc);
    expect(html).not.toContain('pass-cloud"');
    expect(html).not.toContain(en.passes.cloudCaveat);
    for (const text of ecmwfCreditTexts({ epochNow: () => NOW }, en)) {
      expect(html).not.toContain(text);
    }
  });
});

describe('passesCloudOn and the credits page', () => {
  it('is on only while the section is open and holds forecast cloud', () => {
    expect(passesCloudOn.value).toBe(false);
    passesStatus.value = { kind: 'ready', cell: DOC.cell, doc: DOC, fetchedAtMs: 0 };
    setLayersPanelOpen(false);
    expect(passesCloudOn.value).toBe(false);
    setLayersPanelOpen(true);
    expect(passesCloudOn.value).toBe(true);
    passesStatus.value = {
      kind: 'ready',
      cell: DOC.cell,
      doc: withCloud(null, null),
      fetchedAtMs: 0,
    };
    expect(passesCloudOn.value).toBe(false);
  });

  it('owes the ECMWF credits on /credits while cloud is shown, without wind', () => {
    const conditions = activeCreditConditions(DEFAULT_CONFIG, { cloudOn: true });
    expect(conditions).toContain('derived:ecmwf');
    const ids = creditsFor('credits-page', conditions).map((c) => c.id);
    for (const credit of ecmwfComponents()) expect(ids).toContain(credit.id);
    expect(activeCreditConditions(DEFAULT_CONFIG, {})).not.toContain('derived:ecmwf');
    // Wind and cloud together owe the same five once.
    expect(
      activeCreditConditions(DEFAULT_CONFIG, { cloudOn: true, windOn: true }).filter(
        (c) => c === 'derived:ecmwf',
      ),
    ).toHaveLength(1);
  });
});
