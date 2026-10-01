/**
 * CI-7 — satellite passes end to end (TASKS F15), on T1 alone.
 *
 * Same rules as `polling-only.e2e.ts`: the *built* app against the harness origin, the
 * stream never asked for, every wait a polled condition with a deadline, and the same
 * empty page-error allowlist. Opening the Layers panel asks for the committed pass
 * prediction (the fixtures build points the section there), shows one row per platform,
 * labels the times as predicted and credits CelesTrak. Nothing is asked for while the
 * panel is closed.
 *
 * The fixture is a prediction for a fixed moment and the harness runs on the real clock,
 * so which pass is "last" and which "next" depends on the day the suite runs: this file
 * asserts only what does not — the rows, the labels, the credit and the request.
 */

import { fileURLToPath } from 'node:url';

import type { Browser } from 'puppeteer-core';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { DEFAULT_CONFIG } from '../src/core/config.js';
import { LOCALE_STORAGE_KEY } from '../src/core/i18n/locale.js';
import EN from '../src/core/i18n/en.js';
import { ONBOARDING_DONE_VALUE, ONBOARDING_STORAGE_KEY } from '../src/ui/logic/onboarding.js';
import { launchBrowser } from './harness/browser.js';
import { loadFixtureSnapshot } from './harness/fixture.js';
import type { WireSnapshot } from './harness/fixture.js';
import { startOrigin } from './harness/origin.js';
import { openInstrumentedPage, until } from './harness/page.js';
import type { InstrumentedPage } from './harness/page.js';

const DIST_DIR = fileURLToPath(new URL('../dist/', import.meta.url));

const STORAGE: Readonly<Record<string, string>> = {
  [ONBOARDING_STORAGE_KEY]: ONBOARDING_DONE_VALUE,
  [LOCALE_STORAGE_KEY]: 'en',
};

const ROW_SELECTOR = '.home-list a.event-row';
const PANEL = '#fw-layers-panel';
const SECTION = `${PANEL} section.passes`;
const PLATFORMS = ['noaa20', 'snpp', 'noaa21', 's3a', 's3b'] as const;

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

describe('CI-7 satellite passes (F15)', () => {
  it('asks for the prediction only once the panel opens, and labels it as predicted', async () => {
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

    const passesUrl = DEFAULT_CONFIG.passesUrlTemplate ?? '';
    const askedForPasses = () => origin.requests.some((request) => request.path === passesUrl);
    expect(askedForPasses()).toBe(false);
    expect(await page.page.$(SECTION)).toBeNull();

    const toggle = `button.map-control[aria-controls="${PANEL.slice(1)}"]`;
    await page.page.waitForSelector(toggle, { timeout: 15_000 });
    await page.page.click(toggle);
    await page.page.waitForSelector(`${PANEL}:not([hidden])`, { timeout: 5_000 });

    await until(askedForPasses, { timeoutMs: 5_000, what: 'the pass prediction request' });
    await page.page.waitForSelector(`${SECTION} [data-platform]`, { timeout: 5_000 });

    const section = await page.page.$eval(SECTION, (node) => node.textContent ?? '');
    expect(section).toContain(EN.passes.title);
    expect(section).toContain(EN.passes.forMapCentre);
    expect(section).toContain(EN.passes.predicted);
    const rows = await page.page.$$eval(`${SECTION} [data-platform]`, (nodes) =>
      nodes.map((node) => node.getAttribute('data-platform')),
    );
    expect([...rows].sort()).toEqual([...PLATFORMS].sort());

    const credit = await page.page.$eval(`${SECTION} .passes-credit a`, (node) => ({
      text: node.textContent ?? '',
      href: node.getAttribute('href'),
    }));
    expect(credit.text).toContain('CelesTrak');
    expect(credit.href).toBe('https://celestrak.org/');

    await expectQuietPage(page);
  });
});
