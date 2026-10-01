/**
 * CI-7 — the cloud forecast at each satellite pass end to end (TASKS F17), on T1 alone.
 *
 * Same rules as `satellite-passes.e2e.ts`: the *built* app against the harness origin, the
 * stream never asked for, every wait a polled condition with a deadline, and the same
 * empty page-error allowlist. The committed pass prediction carries an ECMWF `tcc`
 * forecast generated through the server's own path, so opening the Layers panel shows a
 * cloud chip on the looks that have one, says once that it is a forecast and that a fire
 * under cloud may be missed, and prints the five ECMWF credit components with it (CI-13).
 *
 * The page's clock is pinned to the fixture's `computed_for`, so which look is "last" is
 * the same on any day the suite runs: NOAA-20's last look (10:57:55Z) reads 79 %, cloudy.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { ecmwfComponents } from '@fire-watch/contracts';
import type { Browser } from 'puppeteer-core';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { LOCALE_STORAGE_KEY } from '../src/core/i18n/locale.js';
import EN from '../src/core/i18n/en.js';
import { ONBOARDING_DONE_VALUE, ONBOARDING_STORAGE_KEY } from '../src/ui/logic/onboarding.js';
import { launchBrowser } from './harness/browser.js';
import { loadFixtureSnapshot } from './harness/fixture.js';
import type { WireSnapshot } from './harness/fixture.js';
import { startOrigin } from './harness/origin.js';
import { openInstrumentedPage } from './harness/page.js';
import type { InstrumentedPage } from './harness/page.js';

const DIST_DIR = fileURLToPath(new URL('../dist/', import.meta.url));
const PASSES_FIXTURE = JSON.parse(
  readFileSync(
    fileURLToPath(new URL('../public/fixtures/passes/sample.json', import.meta.url)),
    'utf8',
  ),
) as { readonly computed_for: string };

const STORAGE: Readonly<Record<string, string>> = {
  [ONBOARDING_STORAGE_KEY]: ONBOARDING_DONE_VALUE,
  [LOCALE_STORAGE_KEY]: 'en',
};

const ROW_SELECTOR = '.home-list a.event-row';
const PANEL = '#fw-layers-panel';
const SECTION = `${PANEL} section.passes`;

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

async function expectQuietPage(page: InstrumentedPage): Promise<void> {
  expect(
    page.consoleErrors.filter((text) => !EXPECTED_CONSOLE_ERRORS.some((re) => re.test(text))),
  ).toEqual([]);
  expect(page.pageErrors).toEqual([]);
  expect(await page.eventSourceCount()).toBe(0);
}

describe('CI-7 cloud at each satellite pass (F17)', () => {
  it('labels the forecast, warns about cloud once and credits ECMWF with it', async () => {
    const offsetMs = Date.parse(PASSES_FIXTURE.computed_for) - Date.now();
    const origin = await startOrigin({
      distDir: DIST_DIR,
      fixture,
      advertiseStaticCopy: false,
      staleByMs: 0,
      clock: () => Date.now() + offsetMs,
    });
    cleanups.push(() => origin.close());
    origin.setScenario('fresh');
    const page = await openInstrumentedPage(browser, origin.baseUrl, STORAGE, {
      warpClock: true,
      initialClockOffsetMs: offsetMs,
    });
    cleanups.push(() => page.close());
    await page.page.goto(`${origin.baseUrl}/`, { waitUntil: 'load' });
    await page.page.waitForSelector(ROW_SELECTOR, { timeout: 15_000 });

    const toggle = `button.map-control[aria-controls="${PANEL.slice(1)}"]`;
    await page.page.waitForSelector(toggle, { timeout: 15_000 });
    await page.page.click(toggle);
    await page.page.waitForSelector(`${PANEL}:not([hidden])`, { timeout: 5_000 });
    await page.page.waitForSelector(`${SECTION} [data-platform]`, { timeout: 5_000 });

    const chip = await page.page.$eval(
      `${SECTION} [data-platform="noaa20"] .pass-cloud`,
      (node) => ({
        text: node.textContent ?? '',
        level: node.getAttribute('data-cloud-level'),
      }),
    );
    expect(chip).toEqual({
      text: EN.passes.cloudForecast(EN.passes.cloudCloudy, 79),
      level: 'cloudy',
    });

    const section = await page.page.$eval(SECTION, (node) => node.textContent ?? '');
    expect(section.split(EN.passes.cloudCaveat)).toHaveLength(2);

    const ecmwf = await page.page.$$eval(`${SECTION} .pass-cloud-credit`, (nodes) =>
      nodes.map((node) => node.textContent ?? ''),
    );
    expect(ecmwf).toHaveLength(ecmwfComponents().length);
    expect(ecmwf.every((line) => line.length > 0)).toBe(true);

    await expectQuietPage(page);
  });
});
