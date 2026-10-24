/**
 * CI-7 for V2-E3: the event page of `fw-2026-q7f3d` shows the Copernicus EMS badge of the
 * committed fixture activation (synthetic EMSR000, drawn around that event), linking to
 * the activation's page with the activation citation as its title, and loads its lazy
 * chunk without a console error. Another event's page shows no badge.
 *
 * Scenario time is pinned to the fixture snapshot's own `generated_at`, for the page and the
 * origin alike: the origin moves every snapshot stamp onto its clock, while the activation
 * fixture is a static file whose instants never move, so on the wall clock the event would
 * drift out of the activation's time window.
 */

import { fileURLToPath } from 'node:url';

import { cemsActivationCitation, cemsActivationUrl } from '@fire-watch/contracts';
import type { Browser, HTTPResponse } from 'puppeteer-core';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

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

const MATCHED_EVENT_ID = 'fw-2026-q7f3d';
/** Sofia, far from the fixture activation's area. */
const OTHER_EVENT_ID = 'fw-2026-k9s2r';
const FIXTURE_CODE = 'EMSR000';

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

async function openEventPage(
  eventId: string,
): Promise<{ page: InstrumentedPage; listed: Promise<HTTPResponse> }> {
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
  });
  cleanups.push(() => page.close());
  // Armed before navigation so a fast answer cannot slip past it.
  const listed = page.page.waitForResponse(
    (response) => response.url().includes('/fixtures/cems/activations.json'),
    { timeout: 15_000 },
  );
  await page.page.goto(`${origin.baseUrl}/event/${eventId}`, { waitUntil: 'load' });
  return { page, listed };
}

function expectQuietPage(page: InstrumentedPage): void {
  expect(
    page.consoleErrors.filter((text) => !EXPECTED_CONSOLE_ERRORS.some((re) => re.test(text))),
  ).toEqual([]);
  expect(page.pageErrors).toEqual([]);
}

describe('CI-7 Copernicus EMS badge (V2-E3)', () => {
  it('badges the matching event with a link to its activation', async () => {
    const { page, listed } = await openEventPage(MATCHED_EVENT_ID);
    await listed;
    const link = await page.page.waitForSelector('.cems-badge a', { timeout: 15_000 });
    if (link === null) throw new Error('e2e: no CEMS badge link');
    const read = await link.evaluate((node) => ({
      text: (node.textContent ?? '').trim(),
      href: node.getAttribute('href'),
      title: node.getAttribute('title'),
      rel: node.getAttribute('rel'),
    }));
    expect(read).toEqual({
      text: EN.eventDetail.cemsActivation(FIXTURE_CODE),
      href: cemsActivationUrl(FIXTURE_CODE),
      title: cemsActivationCitation(FIXTURE_CODE, '2026-08-07T18:00:00Z'),
      rel: 'noopener noreferrer',
    });
    expect(await page.page.$$('.cems-badge')).toHaveLength(1);
    expectQuietPage(page);
  });

  it('shows no badge on an event no activation is about', async () => {
    const { page, listed } = await openEventPage(OTHER_EVENT_ID);
    const response = await listed;
    expect(response.ok()).toBe(true);
    await page.page.waitForSelector('#event-timeline-title', { timeout: 15_000 });
    // The answer is in; one more task turn lets a (wrong) badge render if it were going to.
    await until(async () => (await page.page.$$('.lightning-context-note')).length > 0, {
      timeoutMs: 10_000,
      what: 'the event page settled',
    });
    expect(await page.page.$$('.cems-badge')).toHaveLength(0);
    expectQuietPage(page);
  });
});
