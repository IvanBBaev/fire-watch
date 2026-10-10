/**
 * CI-7 — the wind context layer end to end (TASKS F14), on T1 alone.
 *
 * Same rules as `polling-only.e2e.ts`: the *built* app against the harness origin, the
 * stream never asked for, every wait a polled condition with a deadline, and the same
 * empty page-error allowlist. Switching the wind layer on in the Layers panel fetches the
 * committed fixture step (the fixtures build points the layer there), labels it with the
 * hour it is for and the model run, prints all five ECMWF credit components and records
 * `ov=wind`; switching it off takes the credits away again. A page error from drawing the
 * arrows (MapLibre's `addImage` / symbol layer) fails the quiet-page check.
 *
 * A second scenario swaps the blocked third-party basemap for a local stand-in
 * (`harness/map-inspect.ts`) so the style loads and the arrows reach the real map: the
 * layer sits below the fire layers and is gone when switched off. The map corner carries
 * no ECMWF credit by design — the source has no `attribution`, because the five ECMWF
 * components are owed together in the panel and on the credits page (`wind-layer.ts`).
 */

import { fileURLToPath } from 'node:url';

import { ecmwfComponents } from '@fire-watch/contracts';
import type { Browser, Page } from 'puppeteer-core';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { DEFAULT_CONFIG } from '../src/core/config.js';
import { LOCALE_STORAGE_KEY } from '../src/core/i18n/locale.js';
import EN from '../src/core/i18n/en.js';
import { WIND_LAYER_ID, WIND_SOURCE_ID } from '../src/map/wind-layer.js';
import { ONBOARDING_DONE_VALUE, ONBOARDING_STORAGE_KEY } from '../src/ui/logic/onboarding.js';
import { launchBrowser } from './harness/browser.js';
import { loadFixtureSnapshot } from './harness/fixture.js';
import type { WireSnapshot } from './harness/fixture.js';
import { startOrigin } from './harness/origin.js';
import {
  belowFireDefect,
  cornerText,
  enableMapInspection,
  noneOf,
  readMap,
  startLoadableBasemap,
  untilStyleLoaded,
} from './harness/map-inspect.js';
import { openInstrumentedPage, until } from './harness/page.js';
import type { InstrumentedPage } from './harness/page.js';

const DIST_DIR = fileURLToPath(new URL('../dist/', import.meta.url));

const STORAGE: Readonly<Record<string, string>> = {
  [ONBOARDING_STORAGE_KEY]: ONBOARDING_DONE_VALUE,
  [LOCALE_STORAGE_KEY]: 'en',
};

const ROW_SELECTOR = '.home-list a.event-row';
const PANEL = '#fw-layers-panel';

/** See `polling-only.e2e.ts`: the blocked third-party basemap, and nothing else. */
const EXPECTED_CONSOLE_ERRORS: readonly RegExp[] = [
  /Failed to load resource: net::ERR_BLOCKED_BY_CLIENT/,
  /Failed to fetch/,
];

let browser: Browser;
let fixture: WireSnapshot;
const cleanups: (() => Promise<void>)[] = [];

beforeAll(async () => {
  fixture = await loadFixtureSnapshot();
  browser = await launchBrowser();
});

afterAll(async () => {
  await browser.close();
});

afterEach(async () => {
  while (cleanups.length > 0) {
    const cleanup = cleanups.pop();
    if (cleanup !== undefined) await cleanup();
  }
});

/** Toggle the wind checkbox, found by its label, with a real click on the input. */
async function clickWind(page: Page): Promise<void> {
  const index = await page.$$eval(
    `${PANEL} label.layers-option`,
    (options, label) => options.findIndex((option) => (option.textContent ?? '').trim() === label),
    EN.layers.wind,
  );
  if (index < 0) throw new Error('e2e: no wind checkbox in the layers panel');
  const input = (await page.$$(`${PANEL} label.layers-option input`))[index];
  if (input === undefined) throw new Error('e2e: the wind label has no input');
  await input.click();
}

const credits = (page: Page): Promise<string[]> =>
  page.$$eval(`${PANEL} .layers-credit`, (nodes) => nodes.map((node) => node.textContent ?? ''));

async function expectQuietPage(page: InstrumentedPage): Promise<void> {
  expect(
    page.consoleErrors.filter((text) => !EXPECTED_CONSOLE_ERRORS.some((re) => re.test(text))),
  ).toEqual([]);
  expect(page.pageErrors).toEqual([]);
  expect(await page.eventSourceCount()).toBe(0);
}

describe('CI-7 wind context layer (F14)', () => {
  it('draws the fixture step, labels its hour and run, and credits ECMWF only while on', async () => {
    const origin = await startOrigin({
      distDir: DIST_DIR,
      fixture,
      advertiseStaticCopy: false,
      staleByMs: 0,
    });
    cleanups.push(() => origin.close());
    origin.setScenario('fresh');
    const page = await openInstrumentedPage(browser, origin.baseUrl, STORAGE, {});
    cleanups.push(() => page.close());
    await page.page.goto(`${origin.baseUrl}/`, { waitUntil: 'load' });
    await page.page.waitForSelector(ROW_SELECTOR, { timeout: 15_000 });

    const toggle = `button.map-control[aria-controls="${PANEL.slice(1)}"]`;
    await page.page.waitForSelector(toggle, { timeout: 15_000 });
    await page.page.click(toggle);
    await page.page.waitForSelector(`${PANEL}:not([hidden])`, { timeout: 5_000 });
    // Other layers' own credits may sit in the panel; none of them is ECMWF's.
    const before = await credits(page.page);
    expect(before.filter((text) => text.includes('ECMWF'))).toEqual([]);

    await clickWind(page.page);

    const windUrl = DEFAULT_CONFIG.windOverlayUrl ?? '';
    await until(() => origin.requests.some((request) => request.path === windUrl), {
      timeoutMs: 5_000,
      what: 'the wind fixture request',
    });
    await until(
      async () =>
        (
          await page.page.$$eval(`${PANEL} .layers-status`, (nodes) =>
            nodes.map((node) => node.textContent ?? ''),
          )
        ).some((line) => line.includes('(ECMWF run ')),
      { timeoutMs: 5_000, what: 'the forecast hour and run in the panel' },
    );
    expect(await page.page.$(`${PANEL} .layers-legend`)).not.toBeNull();
    const shown = (await credits(page.page)).filter((text) => !before.includes(text));
    expect(shown).toHaveLength(ecmwfComponents().length);
    expect(shown.join('\n')).toContain('European Centre for Medium-Range Weather Forecasts');
    expect(await page.page.evaluate(() => window.location.hash)).toContain('ov=wind');

    await clickWind(page.page);
    await until(async () => (await credits(page.page)).length === before.length, {
      timeoutMs: 5_000,
      what: 'the ECMWF credits gone with the layer',
    });
    expect(await page.page.evaluate(() => window.location.hash)).not.toContain('ov=');

    await expectQuietPage(page);
  });
  it('draws on the real map below the fire layers, and leaves the corner to the panel', async () => {
    const origin = await startOrigin({
      distDir: DIST_DIR,
      fixture,
      advertiseStaticCopy: false,
      staleByMs: 0,
    });
    cleanups.push(() => origin.close());
    origin.setScenario('fresh');
    const loadable = await startLoadableBasemap();
    cleanups.push(() => loadable.basemap.close());
    const page = await openInstrumentedPage(browser, origin.baseUrl, STORAGE, loadable.pageOptions);
    cleanups.push(() => page.close());
    await enableMapInspection(page.page);
    await page.page.goto(`${origin.baseUrl}/`, { waitUntil: 'load' });
    await page.page.waitForSelector(ROW_SELECTOR, { timeout: 15_000 });
    const loaded = await untilStyleLoaded(page.page, 20_000);
    expect(loaded.sources).not.toContain(WIND_SOURCE_ID);

    const toggle = `button.map-control[aria-controls="${PANEL.slice(1)}"]`;
    await page.page.waitForSelector(toggle, { timeout: 15_000 });
    await page.page.click(toggle);
    await page.page.waitForSelector(`${PANEL}:not([hidden])`, { timeout: 5_000 });
    await clickWind(page.page);
    const on = await until(
      async () => {
        const read = await readMap(page.page);
        return read !== null && belowFireDefect(read, [WIND_LAYER_ID]) === null ? read : null;
      },
      { timeoutMs: 10_000, what: 'the wind layer in the style, below the fire layers' },
    );
    expect(on.sources).toContain(WIND_SOURCE_ID);
    // ECMWF is credited in the panel while the arrows are drawn, never in the corner.
    expect((await credits(page.page)).join('\n')).toContain(
      'European Centre for Medium-Range Weather Forecasts',
    );
    expect(await cornerText(page.page)).not.toMatch(/ECMWF|European Centre/u);

    await clickWind(page.page);
    await until(
      async () => {
        const read = await readMap(page.page);
        return read !== null && read.styleLoaded && noneOf(read, [WIND_LAYER_ID]);
      },
      { timeoutMs: 10_000, what: 'the wind layer gone from the style' },
    );

    // The stand-in basemap means nothing third-party was asked for: an empty allowlist.
    expect(page.blocked).toEqual([]);
    expect(page.consoleErrors).toEqual([]);
    expect(page.pageErrors).toEqual([]);
  });
});
