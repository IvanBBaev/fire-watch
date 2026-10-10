/**
 * CI-7 — the static hot-source mask end to end (TASKS F16), on T1 alone.
 *
 * Same rules as `polling-only.e2e.ts`: the *built* app against the harness origin, the
 * stream never asked for, every wait a polled condition with a deadline, and the same
 * empty page-error allowlist.
 *
 * - The Layers panel's "Known heat sources" row records `ov=static` in the fragment and
 *   takes it away again; a link carrying `ov=static` opens with the row checked and never
 *   writes the reader's own `fw:static-sources`.
 * - The caveat is decided per detection. `fw-2026-q7f3d`'s centre lies ~1.1 km from the
 *   nearest mapped solar park — outside the 1 km caveat radius — while one of its six
 *   fixture detections lies on one, so the event page must say "1 of 6 detections is near
 *   a known solar park" where a centre-only caveat would have said nothing.
 * - On the real map (a local stand-in basemap, `harness/map-inspect.ts`, so the style
 *   loads), the mask's layers sit below the fire layers and are gone when switched off.
 *   The map corner carries the OSM credit throughout: the corner line always does,
 *   so the mask's source needs no `attribution` of its own.
 */

import { fileURLToPath } from 'node:url';

import type { Browser, Page } from 'puppeteer-core';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { LOCALE_STORAGE_KEY } from '../src/core/i18n/locale.js';
import EN from '../src/core/i18n/en.js';
import {
  STATIC_SOURCES_FILL_LAYER_ID,
  STATIC_SOURCES_LINE_LAYER_ID,
  STATIC_SOURCES_POINT_LAYER_ID,
  STATIC_SOURCES_SOURCE_ID,
} from '../src/map/static-sources-layer.js';
import { ONBOARDING_DONE_VALUE, ONBOARDING_STORAGE_KEY } from '../src/ui/logic/onboarding.js';
import { STATIC_SOURCES_STORAGE_KEY } from '../src/ui/static-sources.js';
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
const TOGGLE = `button.map-control[aria-controls="${PANEL.slice(1)}"]`;
/** Centre ~1.1 km from a solar park; one of its six detections on one (see the header). */
const EVENT_ID = 'fw-2026-q7f3d';

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

async function openPage(path: string, realMap = false): Promise<InstrumentedPage> {
  const origin = await startOrigin({
    distDir: DIST_DIR,
    fixture,
    advertiseStaticCopy: false,
    staleByMs: 0,
  });
  cleanups.push(() => origin.close());
  origin.setScenario('fresh');
  // With `realMap`, a local stand-in basemap lets the style load, and the map is readable.
  const loadable = realMap ? await startLoadableBasemap() : null;
  if (loadable !== null) cleanups.push(() => loadable.basemap.close());
  const page = await openInstrumentedPage(browser, origin.baseUrl, STORAGE, {
    ...loadable?.pageOptions,
  });
  cleanups.push(() => page.close());
  if (loadable !== null) await enableMapInspection(page.page);
  await page.page.goto(`${origin.baseUrl}${path}`, { waitUntil: 'load' });
  return page;
}

/** The "Known heat sources" checkbox, found by its label. */
async function staticSourcesInput(page: Page) {
  const index = await page.$$eval(
    `${PANEL} label.layers-option`,
    (options, label) => options.findIndex((option) => (option.textContent ?? '').trim() === label),
    EN.layers.staticSources,
  );
  if (index < 0) throw new Error('e2e: no static-sources checkbox in the layers panel');
  const input = (await page.$$(`${PANEL} label.layers-option input`))[index];
  if (input === undefined) throw new Error('e2e: the static-sources label has no input');
  return input;
}

async function openPanel(page: Page): Promise<void> {
  await page.waitForSelector(TOGGLE, { timeout: 15_000 });
  await page.click(TOGGLE);
  await page.waitForSelector(`${PANEL}:not([hidden])`, { timeout: 5_000 });
}

const hashOf = (page: Page): Promise<string> => page.evaluate(() => window.location.hash);

const storedChoice = (page: Page): Promise<string | null> =>
  page.evaluate((key) => window.localStorage.getItem(key), STATIC_SOURCES_STORAGE_KEY);

async function expectQuietPage(page: InstrumentedPage): Promise<void> {
  expect(
    page.consoleErrors.filter((text) => !EXPECTED_CONSOLE_ERRORS.some((re) => re.test(text))),
  ).toEqual([]);
  expect(page.pageErrors).toEqual([]);
  expect(await page.eventSourceCount()).toBe(0);
}

describe('CI-7 static hot-source mask (F16)', () => {
  it('records the layer as ov=static while on, and only while on', async () => {
    const page = await openPage('/');
    await page.page.waitForSelector(ROW_SELECTOR, { timeout: 15_000 });
    await openPanel(page.page);

    await (await staticSourcesInput(page.page)).click();
    await until(async () => (await hashOf(page.page)).includes('ov=static'), {
      timeoutMs: 5_000,
      what: 'ov=static in the fragment',
    });
    await until(
      async () =>
        (
          await page.page.$$eval(`${PANEL} .layers-credit`, (nodes) =>
            nodes.map((node) => node.textContent ?? ''),
          )
        ).some((text) => text.includes('OpenStreetMap')),
      { timeoutMs: 5_000, what: 'the OSM credit beside the loaded layer' },
    );
    expect(await storedChoice(page.page)).toBe('on');

    await (await staticSourcesInput(page.page)).click();
    await until(async () => !(await hashOf(page.page)).includes('static'), {
      timeoutMs: 5_000,
      what: 'the static token gone from the fragment',
    });

    await expectQuietPage(page);
  });

  it('draws on the real map below the fire layers, with OpenStreetMap in the corner', async () => {
    const maskLayers = [
      STATIC_SOURCES_FILL_LAYER_ID,
      STATIC_SOURCES_LINE_LAYER_ID,
      STATIC_SOURCES_POINT_LAYER_ID,
    ];
    const page = await openPage('/', true);
    await page.page.waitForSelector(ROW_SELECTOR, { timeout: 15_000 });
    const loaded = await untilStyleLoaded(page.page, 20_000);
    expect(loaded.sources).not.toContain(STATIC_SOURCES_SOURCE_ID);
    await until(async () => (await cornerText(page.page)).includes('OpenStreetMap'), {
      timeoutMs: 10_000,
      what: 'the OpenStreetMap credit in the map corner',
    });

    await openPanel(page.page);
    await (await staticSourcesInput(page.page)).click();
    const on = await until(
      async () => {
        const read = await readMap(page.page);
        return read !== null && belowFireDefect(read, maskLayers) === null ? read : null;
      },
      { timeoutMs: 10_000, what: 'the mask layers in the style, below the fire layers' },
    );
    expect(on.sources).toContain(STATIC_SOURCES_SOURCE_ID);
    // The registry's exact OSM text; its ODbL link lives on the credits page, because
    // the corner line is plain text (contracts `MAP_CORNER_LINE`).
    expect(await cornerText(page.page)).toContain('© OpenStreetMap contributors');

    await (await staticSourcesInput(page.page)).click();
    await until(
      async () => {
        const read = await readMap(page.page);
        return read !== null && read.styleLoaded && noneOf(read, maskLayers);
      },
      { timeoutMs: 10_000, what: 'the mask layers gone from the style' },
    );
    expect(await cornerText(page.page)).toContain('OpenStreetMap');

    // The stand-in basemap means nothing third-party was asked for: an empty allowlist.
    expect(page.blocked).toEqual([]);
    expect(page.consoleErrors).toEqual([]);
    expect(page.pageErrors).toEqual([]);
  });

  it('opens a link carrying ov=static with the layer on, leaving storage alone', async () => {
    const page = await openPage('/#map=7.0/42.7000/25.4000&ov=static');
    await page.page.waitForSelector(ROW_SELECTOR, { timeout: 15_000 });
    await openPanel(page.page);

    const input = await staticSourcesInput(page.page);
    expect(await input.evaluate((node) => node.checked)).toBe(true);
    expect(await hashOf(page.page)).toContain('ov=static');
    expect(await storedChoice(page.page)).toBeNull();

    await expectQuietPage(page);
  });

  it('caveats the event per detection, where its centre alone would not be', async () => {
    const page = await openPage(`/event/${EVENT_ID}`);
    const expected = EN.eventDetail.staticSourceDetectionsSolar(1, 6);
    await until(
      async () =>
        (
          await page.page.$$eval('.static-source-note', (nodes) =>
            nodes.map((node) => node.textContent ?? ''),
          )
        ).includes(expected),
      { timeoutMs: 15_000, what: 'the per-detection static-source caveat' },
    );
    expect(await page.page.$$('.static-source-note')).toHaveLength(1);

    await expectQuietPage(page);
  });
});
