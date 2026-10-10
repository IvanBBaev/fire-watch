/**
 * CI-7, CI-13 and CI-18 — the lightning context layer end to end (TASKS F18), on T1 alone.
 *
 * Same rules as `polling-only.e2e.ts`: the *built* app against the harness origin, the
 * stream never asked for, every wait a polled condition with a deadline, and the same
 * empty page-error allowlist. Switching the lightning layer on in the Layers panel fetches
 * the committed fixture (the fixtures build points the layer there), shows the age legend
 * and the "as of" line from `covered_through`, credits EUMETSAT in the panel, and records
 * `ov=lightning`; switching it off takes the credit away.
 *
 * The map corner is not asserted here: the harness blocks the third-party basemap, so the
 * style never finishes loading and no runtime source (flashes, swaths) is ever added. The
 * corner half of CI-13 is `src/ui/attribution-presence.test.tsx`, over a stub map.
 *
 * ## Not time-bombed: the scenario runs at the fixture's moment
 *
 * Flash age is decided against the reader's (server-corrected) clock, so on the real clock
 * the fixture would draw flashes for six hours and then, correctly, nothing. As in
 * `pass-swaths.e2e.ts`, scenario time — the page's clocks *and* the origin's — is pinned
 * to an instant relative to the fixture's `covered_through`.
 */

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import type { Browser, Page } from 'puppeteer-core';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { DEFAULT_CONFIG } from '../src/core/config.js';
import BG from '../src/core/i18n/bg.js';
import EN from '../src/core/i18n/en.js';
import { LOCALE_STORAGE_KEY } from '../src/core/i18n/locale.js';
import type { Locale } from '../src/core/types.js';
import { LIGHTNING_LAYER_ID, LIGHTNING_SOURCE_ID } from '../src/map/lightning-layer.js';
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
const LIGHTNING_FIXTURE = fileURLToPath(
  new URL('../public/fixtures/lightning/recent.json', import.meta.url),
);

const ROW_SELECTOR = '.home-list a.event-row';
const PANEL = '#fw-layers-panel';
const TOGGLE = `button.map-control[aria-controls="${PANEL.slice(1)}"]`;
const LEGEND = `${PANEL} .layers-legend`;
/**
 * The rendered credit, not the bare word: the standing fire-data credit already names
 * EUMETSAT (LSA SAF), so only the Meteosat data credit tells the layer apart.
 */
const CREDIT_MARK = 'Contains modified EUMETSAT Meteosat data';

/** See `polling-only.e2e.ts`: the blocked third-party basemap, and nothing else. */
const EXPECTED_CONSOLE_ERRORS: readonly RegExp[] = [
  /Failed to load resource: net::ERR_BLOCKED_BY_CLIENT/,
  /Failed to fetch/,
];

const MINUTE_MS = 60_000;

let browser: Browser;
let fixture: WireSnapshot;
let coveredThroughMs: number;
const cleanups: (() => Promise<void>)[] = [];

beforeAll(async () => {
  fixture = await loadFixtureSnapshot();
  const doc = JSON.parse(await readFile(LIGHTNING_FIXTURE, 'utf8')) as {
    covered_through: string;
  };
  coveredThroughMs = Date.parse(doc.covered_through);
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

interface Pinned {
  readonly page: InstrumentedPage;
  readonly requested: () => boolean;
}

/** Boot the app with scenario time at `atMs` for the page and the origin alike. */
async function bootAt(
  atMs: number,
  locale: Locale,
  viewport?: { readonly width: number; readonly height: number },
  hash = '',
  realMap = false,
): Promise<Pinned> {
  const offsetMs = atMs - Date.now();
  const origin = await startOrigin({
    distDir: DIST_DIR,
    fixture,
    advertiseStaticCopy: false,
    staleByMs: 0,
    clock: () => Date.now() + offsetMs,
  });
  cleanups.push(() => origin.close());
  origin.setScenario('fresh');
  // With `realMap`, a local stand-in basemap lets the style load, and the map is readable.
  const loadable = realMap ? await startLoadableBasemap() : null;
  if (loadable !== null) cleanups.push(() => loadable.basemap.close());
  const page = await openInstrumentedPage(
    browser,
    origin.baseUrl,
    { [ONBOARDING_STORAGE_KEY]: ONBOARDING_DONE_VALUE, [LOCALE_STORAGE_KEY]: locale },
    { warpClock: true, initialClockOffsetMs: offsetMs, ...loadable?.pageOptions },
  );
  cleanups.push(() => page.close());
  if (loadable !== null) await enableMapInspection(page.page);
  if (viewport !== undefined) {
    await page.page.setViewport({ ...viewport, deviceScaleFactor: 1 });
  }
  await page.page.goto(`${origin.baseUrl}/${hash}`, { waitUntil: 'load' });
  await page.page.waitForSelector(ROW_SELECTOR, { timeout: 15_000 });
  const lightningUrl = DEFAULT_CONFIG.lightningOverlayUrl ?? '';
  return {
    page,
    requested: () => origin.requests.some((request) => request.path === lightningUrl),
  };
}

/** Open the Layers panel. A DOM click: at 320 px the control may sit under the sheet. */
async function openPanel(page: Page): Promise<void> {
  await page.waitForSelector(TOGGLE, { timeout: 15_000 });
  await page.$eval(TOGGLE, (node) => {
    (node as HTMLButtonElement).click();
  });
  await page.waitForSelector(`${PANEL}:not([hidden])`, { timeout: 5_000 });
}

/** Toggle the lightning checkbox, found by its label, with a real click on the input. */
async function clickLightning(page: Page): Promise<void> {
  const index = await page.$$eval(
    `${PANEL} label.layers-option`,
    (options, label) => options.findIndex((option) => (option.textContent ?? '').trim() === label),
    EN.layers.lightning,
  );
  if (index < 0) throw new Error('e2e: no lightning checkbox in the layers panel');
  const input = (await page.$$(`${PANEL} label.layers-option input`))[index];
  if (input === undefined) throw new Error('e2e: the lightning label has no input');
  await input.click();
}

const texts = (page: Page, selector: string): Promise<string[]> =>
  page.$$eval(selector, (nodes) => nodes.map((node) => node.textContent ?? ''));

async function expectQuietPage(page: InstrumentedPage): Promise<void> {
  expect(
    page.consoleErrors.filter((text) => !EXPECTED_CONSOLE_ERRORS.some((re) => re.test(text))),
  ).toEqual([]);
  expect(page.pageErrors).toEqual([]);
  expect(await page.eventSourceCount()).toBe(0);
}

describe('CI-7 lightning context layer (F18)', () => {
  it('draws the fixture by age, says "as of", credits EUMETSAT and records ov= only while on', async () => {
    const { page, requested } = await bootAt(coveredThroughMs + 5 * MINUTE_MS, 'en');
    await openPanel(page.page);
    const before = await texts(page.page, `${PANEL} .layers-credit`);
    expect(before.filter((text) => text.includes(CREDIT_MARK))).toEqual([]);
    expect(requested()).toBe(false);

    await clickLightning(page.page);
    await until(requested, { timeoutMs: 5_000, what: 'the lightning fixture request' });
    await until(
      async () =>
        (await texts(page.page, `${PANEL} .layers-status`)).some((line) =>
          line.includes('Flashes recorded up to '),
        ),
      { timeoutMs: 5_000, what: 'the "as of" line in the panel' },
    );
    const legend = (await texts(page.page, LEGEND)).join('\n');
    expect(legend).toContain(EN.layers.lightningLegendTitle);
    for (const label of EN.layers.lightningClasses) expect(legend).toContain(label);
    // Five minutes after the newest product, every age class has flashes.
    expect(legend).not.toContain(EN.layers.lightningNone);

    const shown = (await texts(page.page, `${PANEL} .layers-credit`)).filter(
      (text) => !before.includes(text),
    );
    expect(shown).toHaveLength(1);
    expect(shown[0]).toContain(CREDIT_MARK);
    expect(await page.page.evaluate(() => window.location.hash)).toContain('ov=lightning');

    await clickLightning(page.page);
    await until(
      async () => (await texts(page.page, `${PANEL} .layers-credit`)).length === before.length,
      { timeoutMs: 5_000, what: 'the EUMETSAT credit gone with the layer' },
    );
    expect(await page.page.$(LEGEND)).toBeNull();
    expect(await page.page.evaluate(() => window.location.hash)).not.toContain('ov=');

    await expectQuietPage(page);
  });

  it('draws on the real map below the fire layers, with the EUMETSAT corner credit only while on', async () => {
    const { page } = await bootAt(coveredThroughMs + 5 * MINUTE_MS, 'en', undefined, '', true);
    const loaded = await untilStyleLoaded(page.page, 20_000);
    expect(loaded.sources).not.toContain(LIGHTNING_SOURCE_ID);
    expect(await cornerText(page.page)).not.toContain(CREDIT_MARK);

    await openPanel(page.page);
    await clickLightning(page.page);
    const on = await until(
      async () => {
        const read = await readMap(page.page);
        return read !== null && belowFireDefect(read, [LIGHTNING_LAYER_ID]) === null ? read : null;
      },
      { timeoutMs: 10_000, what: 'the lightning layer in the style, below the fire layers' },
    );
    expect(on.sources).toContain(LIGHTNING_SOURCE_ID);
    await until(async () => (await cornerText(page.page)).includes(CREDIT_MARK), {
      timeoutMs: 10_000,
      what: 'the exact EUMETSAT credit in the map corner',
    });

    await clickLightning(page.page);
    await until(
      async () => {
        const read = await readMap(page.page);
        return read !== null && read.styleLoaded && noneOf(read, [LIGHTNING_LAYER_ID]);
      },
      { timeoutMs: 10_000, what: 'the lightning layer gone from the style' },
    );
    await until(async () => !(await cornerText(page.page)).includes(CREDIT_MARK), {
      timeoutMs: 10_000,
      what: 'the EUMETSAT credit gone from the map corner',
    });

    // The stand-in basemap means nothing third-party was asked for: an empty allowlist.
    expect(page.blocked).toEqual([]);
    expect(page.consoleErrors).toEqual([]);
    expect(page.pageErrors).toEqual([]);
  });

  it('says there is nothing to draw once every flash in the copy is over six hours old', async () => {
    const { page, requested } = await bootAt(
      coveredThroughMs + 7 * 60 * MINUTE_MS,
      'en',
      undefined,
      '#ov=lightning',
    );
    await openPanel(page.page);
    await until(requested, { timeoutMs: 5_000, what: 'the lightning fixture request' });
    await until(
      async () => (await texts(page.page, LEGEND)).join('\n').includes(EN.layers.lightningNone),
      { timeoutMs: 5_000, what: 'the no-flashes line in the lightning legend' },
    );
    // Nothing drawn, yet the panel still prints the credit for the chosen layer.
    expect((await texts(page.page, `${PANEL} .layers-credit`)).join('\n')).toContain(CREDIT_MARK);
    await expectQuietPage(page);
  });
});

describe('CI-18 lightning legend reflow (F18)', () => {
  it('keeps the open panel inside a 320 CSS px viewport in Bulgarian', async () => {
    const { page, requested } = await bootAt(
      coveredThroughMs + 5 * MINUTE_MS,
      'bg',
      { width: 320, height: 512 },
      '#ov=lightning',
    );
    await openPanel(page.page);
    await until(requested, { timeoutMs: 5_000, what: 'the lightning fixture request' });
    await until(async () => (await page.page.$(`${LEGEND} li`)) !== null, {
      timeoutMs: 5_000,
      what: 'the age classes in the lightning legend',
    });
    expect((await texts(page.page, LEGEND)).join('\n')).toContain(BG.layers.lightningLegendTitle);

    const found = await page.page.$eval(PANEL, (panel) => {
      const width = document.documentElement.clientWidth;
      const out: string[] = [];
      if (document.documentElement.scrollWidth > width + 0.5) {
        out.push(
          `document scrollWidth ${String(document.documentElement.scrollWidth)} > ${String(width)}`,
        );
      }
      for (const el of [panel, ...Array.from(panel.querySelectorAll('*'))]) {
        const box = el.getBoundingClientRect();
        if (box.width === 0 && box.height === 0) continue;
        if (box.left < -0.5 || box.right > width + 0.5) {
          out.push(
            `${el.tagName.toLowerCase()}.${el.getAttribute('class') ?? ''} ${String(box.left)}…${String(box.right)}`,
          );
        }
        if (el.scrollWidth > el.clientWidth + 1 && getComputedStyle(el).overflowX !== 'visible') {
          out.push(`${el.tagName.toLowerCase()}.${el.getAttribute('class') ?? ''} clips sideways`);
        }
      }
      return out;
    });
    expect(found).toEqual([]);
    await expectQuietPage(page);
  });
});
