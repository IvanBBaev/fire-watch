/**
 * CI-7 for V2-E2: the before/after comparison on the event page of `fw-2026-q7f3d`. The page
 * loads with no request to NASA and no GIBS credit; opening the comparison draws the GIBS
 * tiles of the day before the first detection and of the newest available day (the event
 * is still active), shows the registry credit (CI-13), and the divider moves with the arrow
 * keys. Closing it removes the credit and hands focus back to the button that opened it.
 *
 * The network is never reached: every GIBS tile URL the panel can ask for in the scenario's
 * window is rewritten to a local stub that answers with a grey PNG, and any other NASA
 * request would be refused by the harness and recorded in `page.blocked`.
 *
 * Scenario time is pinned to the fixture snapshot's `generated_at` (2026-08-09T09:58Z), for
 * the page and the origin alike, so the dates are fixed: before = 2026-08-06, and after =
 * 2026-08-08, the newest day GIBS publishes before 18:00 UTC.
 */

import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';

import { CREDITS } from '@fire-watch/contracts';
import type { Browser } from 'puppeteer-core';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { addDays, comparisonTiles, gibsTileUrl } from '../src/core/before-after.js';
import type { UtcDay } from '../src/core/before-after.js';
import { formatDateSofia } from '../src/core/i18n/format.js';
import { LOCALE_STORAGE_KEY } from '../src/core/i18n/locale.js';
import EN from '../src/core/i18n/en.js';
import { ONBOARDING_DONE_VALUE, ONBOARDING_STORAGE_KEY } from '../src/ui/logic/onboarding.js';
import { launchBrowser } from './harness/browser.js';
import { loadFixtureSnapshot } from './harness/fixture.js';
import type { WireSnapshot } from './harness/fixture.js';
import { startOrigin } from './harness/origin.js';
import { openInstrumentedPage, until } from './harness/page.js';
import type { InstrumentedPage } from './harness/page.js';
import { paddedPng } from './harness/stand-in-basemap.js';

const DIST_DIR = fileURLToPath(new URL('../dist/', import.meta.url));

const STORAGE: Readonly<Record<string, string>> = {
  [ONBOARDING_STORAGE_KEY]: ONBOARDING_DONE_VALUE,
  [LOCALE_STORAGE_KEY]: 'en',
};

const EVENT_ID = 'fw-2026-q7f3d';
const BEFORE_DAY = '2026-08-06';
const AFTER_DAY = '2026-08-08';
/** The window of days the stub answers for: wide enough for any step the test takes. */
const FIRST_STUB_DAY = '2026-07-20';
const STUB_DAYS = 40;

/** The suite's usual allowance: the blocked third-party basemap, and nothing else. */
const EXPECTED_CONSOLE_ERRORS: readonly RegExp[] = [
  /Failed to load resource: net::ERR_BLOCKED_BY_CLIENT/,
  /Failed to fetch/,
];

const GIBS_CREDIT = CREDITS.find((credit) => credit.id === 'gibs-short');
const TILE_PNG = paddedPng(256, 0x90, 2_048);

interface TileStub {
  readonly baseUrl: string;
  readonly requests: readonly string[];
  close(): Promise<void>;
}

async function startTileStub(): Promise<TileStub> {
  const requests: string[] = [];
  const server = createServer((request, response) => {
    requests.push(new URL(request.url ?? '/', 'http://stub').pathname);
    response
      .writeHead(200, {
        'content-type': 'image/png',
        'cache-control': 'no-store',
        'access-control-allow-origin': '*',
      })
      .end(TILE_PNG);
  });
  await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${String(port)}`,
    requests,
    close: () =>
      new Promise<void>((resolveClose, rejectClose) => {
        server.closeAllConnections();
        server.close((error) => (error === undefined ? resolveClose() : rejectClose(error)));
      }),
  };
}

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

/** Every GIBS URL the panel can ask for around the event, mapped onto the stub. */
function gibsRewrite(
  stub: TileStub,
  lon: number,
  lat: number,
): { rewrite: Record<string, string>; urlOf: (day: UtcDay) => string[] } {
  // The view is at most 800 × 300 CSS px; a wider margin costs nothing.
  const tiles = comparisonTiles(lon, lat, 600, 300);
  const rewrite: Record<string, string> = {};
  for (let i = 0; i < STUB_DAYS; i += 1) {
    const day = addDays(FIRST_STUB_DAY, i);
    for (const tile of tiles) {
      rewrite[gibsTileUrl(day, tile)] =
        `${stub.baseUrl}/tile/${day}/${String(tile.z)}/${String(tile.y)}/${String(tile.x)}.png`;
    }
  }
  return { rewrite, urlOf: (day) => tiles.map((tile) => gibsTileUrl(day, tile)) };
}

async function openEventPage(): Promise<{ page: InstrumentedPage; stub: TileStub }> {
  const feature = fixture.features.find((candidate) => candidate.id === EVENT_ID);
  if (feature === undefined) throw new Error(`e2e: ${EVENT_ID} is not in the fixture`);
  const [lon, lat] = feature.geometry.coordinates;
  if (lon === undefined || lat === undefined) throw new Error('e2e: no event coordinates');
  const stub = await startTileStub();
  cleanups.push(() => stub.close());
  const offsetMs = Date.parse(fixture.generated_at) - Date.now();
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
    extraOrigins: [stub.baseUrl],
    rewrite: gibsRewrite(stub, lon, lat).rewrite,
  });
  cleanups.push(() => page.close());
  await page.page.goto(`${origin.baseUrl}/event/${EVENT_ID}`, { waitUntil: 'load' });
  await page.page.waitForSelector('#event-timeline-title', { timeout: 15_000 });
  return { page, stub };
}

function expectQuietPage(page: InstrumentedPage): void {
  expect(
    page.consoleErrors.filter((text) => !EXPECTED_CONSOLE_ERRORS.some((re) => re.test(text))),
  ).toEqual([]);
  expect(page.pageErrors).toEqual([]);
}

const day = (utcDay: string): string => formatDateSofia(`${utcDay}T12:00:00Z`, 'en');

describe('CI-7 before/after comparison (V2-E2)', () => {
  it('opens on demand with the GIBS credit, moves with the keyboard, and closes', async () => {
    const { page, stub } = await openEventPage();
    const tab = page.page;
    const open = await tab.waitForSelector('button.before-after-open', { timeout: 15_000 });
    if (open === null) throw new Error('e2e: no before/after button');

    // Closed: nothing asked of NASA, no credit on the page.
    expect(await open.evaluate((node) => node.getAttribute('aria-expanded'))).toBe('false');
    expect(stub.requests).toEqual([]);
    expect(await tab.$$('.before-after-credit')).toHaveLength(0);

    await open.click();
    const link = await tab.waitForSelector('.before-after-credit a', { timeout: 15_000 });
    if (link === null) throw new Error('e2e: no GIBS credit link');
    expect(GIBS_CREDIT).toBeDefined();
    expect(
      await link.evaluate((node) => ({
        text: (node.textContent ?? '').trim(),
        href: node.getAttribute('href'),
        rel: node.getAttribute('rel'),
      })),
    ).toEqual({
      text: 'Imagery: NASA GIBS / EOSDIS',
      href: GIBS_CREDIT?.href ?? null,
      rel: 'noopener noreferrer',
    });

    // The two days the date rule picks, worded honestly, and their tiles fetched.
    const labels = await tab.$$eval('.before-after-date span', (nodes) =>
      nodes.map((node) => (node.textContent ?? '').trim()),
    );
    expect(labels).toEqual([
      EN.beforeAfter.beforeLabel(day(BEFORE_DAY)),
      EN.beforeAfter.afterLatestLabel(day(AFTER_DAY)),
    ]);
    await until(
      () =>
        Promise.resolve(
          stub.requests.some((path) => path.includes(`/${BEFORE_DAY}/`)) &&
            stub.requests.some((path) => path.includes(`/${AFTER_DAY}/`)),
        ),
      { timeoutMs: 10_000, what: 'both days of tiles requested' },
    );
    expect(page.blocked.filter((url) => url.includes('gibs.earthdata.nasa.gov'))).toEqual([]);
    expect(await tab.$$('.before-after [role="status"]')).toHaveLength(0);

    // The divider: a native range input, so the arrow keys move it.
    const slider = await tab.$('input.before-after-slider');
    if (slider === null) throw new Error('e2e: no slider');
    await slider.focus();
    await tab.keyboard.press('ArrowRight');
    const moved = await tab.evaluate(() => {
      const input = document.querySelector<HTMLInputElement>('input.before-after-slider');
      const after = document.querySelector<HTMLElement>('.before-after-after');
      return {
        value: input?.value,
        valueText: input?.getAttribute('aria-valuetext'),
        label: input?.getAttribute('aria-label'),
        clip: after?.style.clipPath,
      };
    });
    expect(moved).toEqual({
      value: '51',
      valueText: EN.beforeAfter.sliderValue(51),
      label: EN.beforeAfter.sliderLabel,
      clip: 'inset(0px 0px 0px 51%)',
    });

    // A cloudy day can be stepped past: one day earlier asks for that day's tiles.
    await tab.click(`button[aria-label="${EN.beforeAfter.beforeEarlier}"]`);
    await until(
      () => Promise.resolve(stub.requests.some((path) => path.includes('/2026-08-05/'))),
      { timeoutMs: 10_000, what: 'the stepped day requested' },
    );
    // "After" is already the newest day: it cannot be stepped later.
    expect(
      await tab.$eval(`button[aria-label="${EN.beforeAfter.afterLater}"]`, (node) => node.disabled),
    ).toBe(true);

    // Closing removes the panel and its credit and returns focus to the opener.
    await tab.click('.before-after button:not(.before-after-step)');
    await until(async () => (await tab.$$('.before-after-credit')).length === 0, {
      timeoutMs: 5_000,
      what: 'the comparison closed',
    });
    expect(
      await tab.evaluate(() => document.activeElement?.classList.contains('before-after-open')),
    ).toBe(true);
    expectQuietPage(page);
  });
});
