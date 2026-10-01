/**
 * CI-7 — the map-roadmap features end to end (TASKS F10–F13), on T1 alone.
 *
 * Same rules as `polling-only.e2e.ts`: the *built* app against the harness origin, the
 * stream never asked for, every wait a polled condition with a deadline, and the same
 * empty page-error allowlist. What each scenario proves is what a reader would see:
 *
 *   1. new signals — an arrival while the tab is hidden puts a badge in the title; back
 *      on the tab, the counter sits in the side panel (not the header) on a map route,
 *      "Show newest" opens the event, and "Mark all seen" clears a second arrival;
 *   2. filters — a period preset and an oblast narrow the list to exactly the rows the
 *      app's own rules predict, survive a reload through the fragment, and survive a
 *      trip to an event page and back (the fragment repair of F12);
 *   3. layers — switching the fire-danger layer on asks the EFFIS proxy for its copy,
 *      shows the day it is for, adds the EFFIS credit and records `ov=` in the fragment;
 *      switching it off takes the credit away again;
 *   4. place search — choosing a settlement moves the camera onto it, as the `map=`
 *      member the map writes after every move shows.
 *
 * Nothing here depends on layers beyond the two EFFIS overlays, or on snapshot fields
 * beyond the ones the fixture already carries.
 */

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import type { Browser, Page } from 'puppeteer-core';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { DEFAULT_CONFIG } from '../src/core/config.js';
import { createOblastIndex, isRegionsAsset } from '../src/core/filter/oblasts.js';
import type { OblastIndex } from '../src/core/filter/oblasts.js';
import { LOCALE_STORAGE_KEY } from '../src/core/i18n/locale.js';
import EN from '../src/core/i18n/en.js';
import { ageWindowHours } from '../src/core/time/age-filter.js';
import { parseMapHash } from '../src/map/hash.js';
import { OVERLAY_URLS } from '../src/ui/layers.js';
import { eventPath } from '../src/ui/logic/event-resolution.js';
import { ONBOARDING_DONE_VALUE, ONBOARDING_STORAGE_KEY } from '../src/ui/logic/onboarding.js';
import { launchBrowser } from './harness/browser.js';
import { startEffisOverlayStub } from './harness/effis-overlay-stub.js';
import { startStandInBasemap } from './harness/stand-in-basemap.js';
import { loadFixtureSnapshot, observedWithin } from './harness/fixture.js';
import type { WireFeature, WireSnapshot } from './harness/fixture.js';
import { HARNESS_POLL_INTERVAL_MS, startOrigin } from './harness/origin.js';
import type { HarnessOrigin } from './harness/origin.js';
import { openInstrumentedPage, until } from './harness/page.js';
import type { InstrumentedPage, InstrumentedPageOptions } from './harness/page.js';

const DIST_DIR = fileURLToPath(new URL('../dist/', import.meta.url));
const OBLASTS_ASSET = new URL('../src/assets/geodata/oblasts.json', import.meta.url);
const SETTLEMENTS_ASSET = new URL('../src/assets/geodata/settlements.json', import.meta.url);

const STORAGE: Readonly<Record<string, string>> = {
  [ONBOARDING_STORAGE_KEY]: ONBOARDING_DONE_VALUE,
  [LOCALE_STORAGE_KEY]: 'en',
};

const ROW_SELECTOR = '.home-list a.event-row';
const EVENT_PAGE_SELECTOR = 'article.page.event-page';
const SIDE_PANEL_COUNTER = '.side-panel .new-signals';

/** The client jitters every delay by ±20 %; two intervals at the worst side. */
const NEXT_POLL_MS = Math.ceil(2 * HARNESS_POLL_INTERVAL_MS * 1.2);

/** Small tiles: this basemap exists to let the map load, not to weigh anything. */
const TINY_BASEMAP = { tileBytes: 1024, tileSize: 256, maxzoom: 14 } as const;

/** See `polling-only.e2e.ts`: the blocked third-party basemap, and nothing else. */
const EXPECTED_CONSOLE_ERRORS: readonly RegExp[] = [
  /Failed to load resource: net::ERR_BLOCKED_BY_CLIENT/,
  /Failed to fetch/,
];

let browser: Browser;
let fixture: WireSnapshot;
let oblasts: OblastIndex;
const cleanups: (() => Promise<void>)[] = [];

interface Booted {
  readonly origin: HarnessOrigin;
  readonly page: InstrumentedPage;
}

interface BootOptions {
  readonly path?: string;
  readonly page?: (origin: HarnessOrigin) => InstrumentedPageOptions;
  /** Fixture events the origin does not serve until a scenario adds them back. */
  readonly withhold?: readonly string[];
}

async function boot(options: BootOptions = {}): Promise<Booted> {
  const origin = await startOrigin({
    distDir: DIST_DIR,
    fixture,
    advertiseStaticCopy: false,
    staleByMs: 0,
  });
  cleanups.push(() => origin.close());
  origin.setScenario('fresh');
  for (const id of options.withhold ?? []) origin.snapshot.remove(id);
  const page = await openInstrumentedPage(
    browser,
    origin.baseUrl,
    STORAGE,
    options.page?.(origin) ?? {},
  );
  cleanups.push(() => page.close());
  await page.page.goto(origin.baseUrl + (options.path ?? '/'), { waitUntil: 'load' });
  await page.page.waitForSelector(ROW_SELECTOR, { timeout: 15_000 });
  return { origin, page };
}

async function expectQuietPage(page: InstrumentedPage): Promise<void> {
  expect(
    page.consoleErrors.filter((text) => !EXPECTED_CONSOLE_ERRORS.some((re) => re.test(text))),
  ).toEqual([]);
  expect(page.pageErrors).toEqual([]);
  expect(await page.eventSourceCount()).toBe(0);
}

const rowHrefs = async (page: Page): Promise<string[]> =>
  (
    await page.$$eval(ROW_SELECTOR, (rows) => rows.map((row) => row.getAttribute('href') ?? ''))
  ).sort();

async function waitForRows(page: Page, expected: readonly string[], what: string): Promise<void> {
  await until(
    async () => {
      const hrefs = await rowHrefs(page);
      return hrefs.length === expected.length && hrefs.every((href, i) => href === expected[i]);
    },
    { timeoutMs: NEXT_POLL_MS, what },
  );
}

const text = (page: Page, selector: string): Promise<string | null> =>
  page.evaluate((target: string) => {
    const node = document.querySelector(target);
    return node === null ? null : (node.textContent ?? '').trim();
  }, selector);

const hash = (page: Page): Promise<string> => page.evaluate(() => window.location.hash);

function fixtureFeature(id: string): WireFeature {
  const feature = fixture.features.find((candidate) => candidate.id === id);
  if (feature === undefined) throw new Error(`e2e: fixture has no feature ${id}`);
  return feature;
}

/**
 * An arrival observed at the instant it is served: the origin re-anchors every stamp so
 * that `generated_at` is its clock, so stamping both observations with the fixture's
 * `generated_at` makes them "now" — later than the floor the page set when it booted.
 * `id` defaults to a fixture event's own (one withheld at boot), whose detections file
 * the build ships — an event page for an unknown id would log its 404.
 */
function freshArrival(from: string, id = from): WireFeature {
  const base = fixtureFeature(from);
  return {
    ...base,
    id,
    properties: {
      ...base.properties,
      id,
      status: 'active',
      merged_into: null,
      first_observed_at: fixture.generated_at,
      last_observed_at: fixture.generated_at,
      place_name_bg: 'Тестово',
      place_name_en: 'Testovo',
    },
  };
}

/** Fake the tab being switched away from (or back to): the adapter reads the document. */
async function setHidden(page: Page, hidden: boolean): Promise<void> {
  await page.evaluate((isHidden: boolean) => {
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => (isHidden ? 'hidden' : 'visible'),
    });
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => isHidden });
    document.dispatchEvent(new Event('visibilitychange'));
  }, hidden);
}

/**
 * Toggle the fire-danger checkbox, found by its label so that layers other work adds to
 * the panel do not move it. A real click on the input, as a reader's would be.
 */
async function clickFwi(page: Page): Promise<void> {
  const index = await page.$$eval(
    '#fw-layers-panel label.layers-option',
    (options, label) => options.findIndex((option) => (option.textContent ?? '').trim() === label),
    EN.layers.fwi,
  );
  if (index < 0) throw new Error('e2e: no fire-danger checkbox in the layers panel');
  const inputs = await page.$$('#fw-layers-panel label.layers-option input');
  const input = inputs[index];
  if (input === undefined) throw new Error('e2e: the fire-danger label has no input');
  await input.click();
}

/** Rows the list should show for a window and an oblast, by the app's own region index. */
function expectedRows(origin: HarnessOrigin, windowHours: number, oblast: number | null): string[] {
  const now = Date.now();
  const served = origin.servedSnapshot(now);
  const inWindow = new Set(observedWithin(served, now, windowHours * 3_600_000));
  return served.features
    .filter((feature) => inWindow.has(feature.id))
    .filter((feature) => {
      if (oblast === null) return true;
      const [lon, lat] = feature.geometry.coordinates;
      return oblasts.regionAt(lon, lat) === oblast;
    })
    .map((feature) => eventPath(feature.id))
    .sort();
}

beforeAll(async () => {
  fixture = await loadFixtureSnapshot();
  const asset: unknown = JSON.parse(await readFile(OBLASTS_ASSET, 'utf8'));
  if (!isRegionsAsset(asset)) throw new Error('e2e: malformed oblasts asset');
  oblasts = createOblastIndex(asset);
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

describe('CI-7 map roadmap (F10–F13)', () => {
  it('counts new signals in the side panel, badges the hidden tab, shows and clears', async () => {
    // The first arrival is opened, so it is a real fixture event, withheld until then.
    const opened = 'fw-2026-b2n5c';
    const { origin, page } = await boot({ withhold: [opened] });
    const baseTitle = await page.page.title();
    // A first visit is quiet: everything already on the map counts as seen.
    expect(await text(page.page, `${SIDE_PANEL_COUNTER} .new-signals-count`)).toBe('');
    // On a map route the counter lives in the side panel, not the header (CI-7 header rule).
    expect(await page.page.$('header .new-signals')).toBeNull();

    // Away from the tab, an arrival reaches the title by polling alone.
    await setHidden(page.page, true);
    origin.snapshot.add(freshArrival(opened));
    await until(async () => (await page.page.title()) === `(1) ${baseTitle}`, {
      timeoutMs: NEXT_POLL_MS,
      what: 'the title badge for one new signal',
    });

    // Back on the tab: the plain title, and the counter in the side panel.
    await setHidden(page.page, false);
    await until(async () => (await page.page.title()) === baseTitle, {
      timeoutMs: 5_000,
      what: 'the plain title once visible',
    });
    expect(await text(page.page, `${SIDE_PANEL_COUNTER} .new-signals-count`)).toBe(
      EN.newSignals.count(1),
    );

    // "Show newest" opens the event, and seeing it clears the counter.
    await page.page.click(`${SIDE_PANEL_COUNTER} .new-signals-show`);
    await page.page.waitForSelector(EVENT_PAGE_SELECTOR, { timeout: 5_000 });
    expect(await page.page.evaluate(() => window.location.pathname)).toBe(eventPath(opened));
    await until(
      async () => (await text(page.page, `${SIDE_PANEL_COUNTER} .new-signals-count`)) === '',
      { timeoutMs: 5_000, what: 'the counter cleared by Show newest' },
    );

    // A second arrival, cleared without opening it.
    origin.snapshot.add(freshArrival('fw-2026-x4k6m', 'fw-2026-e2e1b'));
    await until(
      async () =>
        (await text(page.page, `${SIDE_PANEL_COUNTER} .new-signals-count`)) ===
        EN.newSignals.count(1),
      { timeoutMs: NEXT_POLL_MS, what: 'the counter for the second arrival' },
    );
    await page.page.click(`${SIDE_PANEL_COUNTER} .new-signals-clear`);
    await until(
      async () => (await text(page.page, `${SIDE_PANEL_COUNTER} .new-signals-count`)) === '',
      { timeoutMs: 5_000, what: 'the counter cleared by Mark all seen' },
    );
    expect(await page.page.$(`${SIDE_PANEL_COUNTER} .new-signals-show`)).toBeNull();

    await expectQuietPage(page);
  });

  it('narrows the list by period and oblast, through a reload and an event page', async () => {
    const { origin, page } = await boot();
    const sixHours = ageWindowHours('6h');
    const allDay = ageWindowHours('24h');
    if (sixHours === null || allDay === null) throw new Error('e2e: bounded windows expected');

    const [lon, lat] = fixtureFeature('fw-2026-q7f3d').geometry.coordinates;
    const oblast = oblasts.regionAt(lon, lat);
    if (oblast === null) throw new Error('e2e: q7f3d must lie in an oblast');

    // Each step must actually cut, or the assertion proves nothing.
    const daily = expectedRows(origin, allDay, null);
    const sixHourly = expectedRows(origin, sixHours, null);
    const regional = expectedRows(origin, sixHours, oblast);
    expect(sixHourly.length).toBeLessThan(daily.length);
    expect(regional.length).toBeGreaterThan(0);
    expect(regional.length).toBeLessThan(sixHourly.length);

    await waitForRows(page.page, daily, 'the default 24 h rows');
    await page.page.select('#filter-window', '6h');
    await waitForRows(page.page, sixHourly, 'the 6 h rows');
    // The oblast options exist once the region index has loaded.
    await page.page.waitForSelector(`#filter-region option[value="${String(oblast)}"]`, {
      timeout: 5_000,
    });
    await page.page.select('#filter-region', String(oblast));
    await waitForRows(page.page, regional, 'the 6 h rows in one oblast');
    await until(
      async () => {
        const current = await hash(page.page);
        return current.includes('t=6h') && current.includes(`r=${String(oblast)}`);
      },
      { timeoutMs: 5_000, what: 'the filters in the fragment' },
    );

    // A reload reads them back from the fragment.
    await page.page.reload({ waitUntil: 'load' });
    await page.page.waitForSelector(ROW_SELECTOR, { timeout: 15_000 });
    await waitForRows(page.page, expectedRows(origin, sixHours, oblast), 'the rows after reload');
    expect(await page.page.$eval('#filter-window', (el) => (el as HTMLSelectElement).value)).toBe(
      '6h',
    );
    expect(await page.page.$eval('#filter-region', (el) => (el as HTMLSelectElement).value)).toBe(
      String(oblast),
    );

    // Out to an event page and back: the fragment keeps the filters both ways (F12).
    const [first] = await rowHrefs(page.page);
    if (first === undefined) throw new Error('e2e: no filtered row to open');
    await page.page.click(`${ROW_SELECTOR}[href="${first}"]`);
    await page.page.waitForSelector(EVENT_PAGE_SELECTOR, { timeout: 5_000 });
    await until(
      async () => {
        const current = await hash(page.page);
        return current.includes('t=6h') && current.includes(`r=${String(oblast)}`);
      },
      { timeoutMs: 5_000, what: 'the filters kept in the event page fragment' },
    );
    await page.page.goBack();
    await page.page.waitForSelector(ROW_SELECTOR, { timeout: 5_000 });
    await waitForRows(page.page, expectedRows(origin, sixHours, oblast), 'the rows after Back');

    await expectQuietPage(page);
  });

  it('asks the EFFIS proxy for fire danger, credits EFFIS and records the choice', async () => {
    const stub = await startEffisOverlayStub();
    cleanups.push(() => stub.close());
    const { page } = await boot({
      page: (origin) => ({
        extraOrigins: [stub.baseUrl],
        rewrite: stub.rewriteFor(origin.baseUrl),
      }),
    });

    const toggle = 'button.map-control[aria-controls="fw-layers-panel"]';
    await page.page.waitForSelector(toggle, { timeout: 15_000 });
    await page.page.click(toggle);
    await page.page.waitForSelector('#fw-layers-panel:not([hidden])', { timeout: 5_000 });
    expect(await page.page.$('#fw-layers-panel .layers-credit')).toBeNull();

    await clickFwi(page.page);

    await until(() => stub.requests.includes(OVERLAY_URLS.fwi), {
      timeoutMs: 5_000,
      what: 'the FWI request at the proxy',
    });
    await until(
      async () =>
        ((await text(page.page, '#fw-layers-panel .layers-status')) ?? '').startsWith('For '),
      { timeoutMs: 5_000, what: 'the valid-for day in the panel' },
    );
    const credit = await text(page.page, '#fw-layers-panel .layers-credit');
    expect(credit).toContain('European Forest Fire Information System (EFFIS)');
    expect(await hash(page.page)).toContain('ov=fwi');

    await clickFwi(page.page);
    await until(async () => (await page.page.$('#fw-layers-panel .layers-credit')) === null, {
      timeoutMs: 5_000,
      what: 'the EFFIS credit gone with the layer',
    });
    expect(await hash(page.page)).not.toContain('ov=');

    await expectQuietPage(page);
  });

  it('moves the camera onto a settlement chosen in place search', async () => {
    const gazetteer = JSON.parse(await readFile(SETTLEMENTS_ASSET, 'utf8')) as {
      readonly scale: number;
      readonly places: readonly (readonly [string, number, number, number, number])[];
    };
    const plovdiv = gazetteer.places.find((place) => place[0] === 'Пловдив');
    if (plovdiv === undefined) throw new Error('e2e: the gazetteer has no Plovdiv');
    const target = { lat: plovdiv[1] / gazetteer.scale, lon: plovdiv[2] / gazetteer.scale };

    // The camera only moves once the map has a style: without a basemap MapLibre never
    // finishes loading and a fly-to has nothing to animate. The local stand-in supplies
    // one, as it does for the map-ready gate.
    const basemap = await startStandInBasemap(TINY_BASEMAP);
    cleanups.push(() => basemap.close());
    const { page } = await boot({
      page: () => ({
        extraOrigins: [basemap.baseUrl],
        rewrite: Object.fromEntries(
          Object.values(DEFAULT_CONFIG.basemapStyleUrl).map((url) => [url, basemap.styleUrl]),
        ),
      }),
    });
    await page.page.click('#place-search-input');
    await page.page.type('#place-search-input', 'Plovdiv');
    await until(
      async () =>
        ((await text(page.page, '.place-search-results .place-search-option')) ?? '').startsWith(
          'Plovdiv',
        ),
      { timeoutMs: 5_000, what: 'Plovdiv as the first suggestion' },
    );
    await page.page.keyboard.press('Enter');

    await until(
      async () => {
        const camera = parseMapHash(await hash(page.page));
        return (
          camera !== null &&
          Math.abs(camera.lat - target.lat) < 0.01 &&
          Math.abs(camera.lon - target.lon) < 0.01 &&
          camera.zoom >= 11.5
        );
      },
      { timeoutMs: 10_000, what: 'the camera over Plovdiv' },
    );

    await expectQuietPage(page);
  });
});
