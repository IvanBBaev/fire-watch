/**
 * CI-7 and CI-18 — the predicted satellite swath overlay end to end (TASKS F15), on T1
 * alone.
 *
 * Same rules as `polling-only.e2e.ts`: the *built* app against the harness origin, the
 * stream never asked for, every wait a polled condition with a deadline, and the same
 * empty page-error allowlist. Switching the swath layer on in the Layers panel fetches the
 * committed fixture (the fixtures build points the layer there), labels it as predicted,
 * lists the next and recent passes, credits CelesTrak in the panel and records
 * `ov=swaths`; switching it off takes the credit away again. A page error from drawing the
 * swaths fails the quiet-page check.
 *
 * The map corner is not asserted here: the harness blocks the third-party basemap, so the
 * style never finishes loading and no runtime source (swaths, wind, lightning) reaches the
 * map — the corner shows only the controller's own attribution line. That the swath source
 * carries the CelesTrak credit into the corner is CI-13's unit case
 * (`ui/attribution-presence.test.tsx`), against the real controller.
 *
 * ## Not time-bombed: the scenario runs at the fixture's moment
 *
 * The fixture is real SGP4 output for one fixed moment (`computed_for`), regenerated from
 * the recorded CelesTrak elements by the server's drift test and never shifted. The web
 * re-decides "recent" and "next" against the reader's clock, so on the real clock the
 * fixture would draw passes for a few hours and then, correctly, nothing. Instead of
 * asserting what the day happens to allow, each scenario pins scenario time — the page's
 * `Date.now` / `performance.now` *and* the origin's clock, so the server-corrected clock
 * agrees — to a chosen instant relative to `computed_for`. The same assertions hold on any
 * day the suite runs, including the "window is over" branch, which is asserted on purpose.
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
import { ONBOARDING_DONE_VALUE, ONBOARDING_STORAGE_KEY } from '../src/ui/logic/onboarding.js';
import { launchBrowser } from './harness/browser.js';
import { loadFixtureSnapshot } from './harness/fixture.js';
import type { WireSnapshot } from './harness/fixture.js';
import { startOrigin } from './harness/origin.js';
import { openInstrumentedPage, until } from './harness/page.js';
import type { InstrumentedPage } from './harness/page.js';

const DIST_DIR = fileURLToPath(new URL('../dist/', import.meta.url));
const SWATHS_FIXTURE = fileURLToPath(
  new URL('../public/fixtures/passes/swaths.json', import.meta.url),
);

const ROW_SELECTOR = '.home-list a.event-row';
const PANEL = '#fw-layers-panel';
const TOGGLE = `button.map-control[aria-controls="${PANEL.slice(1)}"]`;
const LEGEND = `${PANEL} .layers-legend`;

/** See `polling-only.e2e.ts`: the blocked third-party basemap, and nothing else. */
const EXPECTED_CONSOLE_ERRORS: readonly RegExp[] = [
  /Failed to load resource: net::ERR_BLOCKED_BY_CLIENT/,
  /Failed to fetch/,
];

const MINUTE_MS = 60_000;

let browser: Browser;
let fixture: WireSnapshot;
let computedForMs: number;
let windowToMs: number;
const cleanups: (() => Promise<void>)[] = [];

beforeAll(async () => {
  fixture = await loadFixtureSnapshot();
  const doc = JSON.parse(await readFile(SWATHS_FIXTURE, 'utf8')) as {
    computed_for: string;
    window: { to: string };
  };
  computedForMs = Date.parse(doc.computed_for);
  windowToMs = Date.parse(doc.window.to);
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
  const page = await openInstrumentedPage(
    browser,
    origin.baseUrl,
    { [ONBOARDING_STORAGE_KEY]: ONBOARDING_DONE_VALUE, [LOCALE_STORAGE_KEY]: locale },
    { warpClock: true, initialClockOffsetMs: offsetMs },
  );
  cleanups.push(() => page.close());
  if (viewport !== undefined) {
    await page.page.setViewport({ ...viewport, deviceScaleFactor: 1 });
  }
  await page.page.goto(`${origin.baseUrl}/${hash}`, { waitUntil: 'load' });
  await page.page.waitForSelector(ROW_SELECTOR, { timeout: 15_000 });
  const swathsUrl = DEFAULT_CONFIG.passSwathsUrl ?? '';
  return {
    page,
    requested: () => origin.requests.some((request) => request.path === swathsUrl),
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

/** Toggle the swath checkbox, found by its label, with a real click on the input. */
async function clickSwaths(page: Page): Promise<void> {
  const index = await page.$$eval(
    `${PANEL} label.layers-option`,
    (options, label) => options.findIndex((option) => (option.textContent ?? '').trim() === label),
    EN.layers.swaths,
  );
  if (index < 0) throw new Error('e2e: no swath checkbox in the layers panel');
  const input = (await page.$$(`${PANEL} label.layers-option input`))[index];
  if (input === undefined) throw new Error('e2e: the swath label has no input');
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

describe('CI-7 predicted satellite swaths (F15)', () => {
  it('lists next and recent passes, credits CelesTrak and records ov= only while on', async () => {
    const { page, requested } = await bootAt(computedForMs + 5 * MINUTE_MS, 'en');
    await openPanel(page.page);
    const before = await texts(page.page, `${PANEL} .layers-credit`);
    expect(before.filter((text) => text.includes('CelesTrak'))).toEqual([]);
    expect(requested()).toBe(false);

    await clickSwaths(page.page);
    await until(requested, { timeoutMs: 5_000, what: 'the swath fixture request' });
    await until(
      async () => (await texts(page.page, `${LEGEND} li`)).some((line) => line.includes(' at ')),
      { timeoutMs: 5_000, what: 'the listed passes in the swath legend' },
    );
    const legend = (await texts(page.page, LEGEND)).join('\n');
    expect(legend).toContain(EN.layers.swathsNext);
    expect(legend).toContain(EN.layers.swathsRecent);
    // At the fixture's own moment the window is open: no "expired" line.
    expect(legend).not.toContain(EN.passes.expired);
    const status = (await texts(page.page, `${PANEL} .layers-status`)).join('\n');
    expect(status).toContain('Predicted from orbital elements, computed for ');

    const shown = (await texts(page.page, `${PANEL} .layers-credit`)).filter(
      (text) => !before.includes(text),
    );
    expect(shown).toHaveLength(1);
    expect(shown[0]).toContain('CelesTrak');
    expect(await page.page.evaluate(() => window.location.hash)).toContain('ov=swaths');

    await clickSwaths(page.page);
    await until(
      async () => (await texts(page.page, `${PANEL} .layers-credit`)).length === before.length,
      { timeoutMs: 5_000, what: 'the CelesTrak layer credit gone with the layer' },
    );
    expect(await page.page.$(LEGEND)).toBeNull();
    expect(await page.page.evaluate(() => window.location.hash)).not.toContain('ov=');

    await expectQuietPage(page);
  });

  it('says the prediction has expired, and lists nothing ahead, once its window is over', async () => {
    const { page, requested } = await bootAt(
      windowToMs + 30 * MINUTE_MS,
      'en',
      undefined,
      '#ov=swaths',
    );
    await openPanel(page.page);
    await until(requested, { timeoutMs: 5_000, what: 'the swath fixture request' });
    await until(
      async () => (await texts(page.page, LEGEND)).join('\n').includes(EN.passes.expired),
      { timeoutMs: 5_000, what: 'the expired line in the swath legend' },
    );
    // Nothing is "next" in an expired window; the nearest recent passes may still show.
    const nextGroup = await page.page.$eval(
      `${LEGEND} #fw-layers-panel-swaths-next`,
      (node) => node.parentElement?.querySelectorAll('li').length ?? -1,
    );
    expect(nextGroup).toBe(0);
    await expectQuietPage(page);
  });
});

describe('CI-18 swath legend reflow (F15)', () => {
  it('keeps the open panel inside a 320 CSS px viewport in Bulgarian', async () => {
    const { page, requested } = await bootAt(
      computedForMs + 5 * MINUTE_MS,
      'bg',
      { width: 320, height: 512 },
      '#ov=swaths',
    );
    await openPanel(page.page);
    await until(requested, { timeoutMs: 5_000, what: 'the swath fixture request' });
    await until(async () => (await page.page.$(`${LEGEND} li`)) !== null, {
      timeoutMs: 5_000,
      what: 'the listed passes in the swath legend',
    });
    expect((await texts(page.page, LEGEND)).join('\n')).toContain(BG.layers.swathsNext);

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
