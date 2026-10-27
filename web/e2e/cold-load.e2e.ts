/**
 * Cold loads — what a first document shows before the data arrives, and what it asks of
 * the reader before they have asked for anything (docs/TASKS.md F3, 07-product-ux §5.9.1).
 *
 * Against the built app, in a real browser, over the harness origin, with no test hook in
 * application code:
 *
 *   1. **A cold permalink open with a slow snapshot.** The origin holds its snapshot answer;
 *      the event page must say it is loading — never "not found" — for as long as it is
 *      held, and show the event once it is released. A mutation observer installed before
 *      the app's first script records every state the page ever rendered, so a flash that
 *      lasts one frame still fails the scenario.
 *   2. **A cold permalink open on a failing origin.** The snapshot route answers `503` on a
 *      streak; the page goes from loading to "could not load", and never says "not found":
 *      an absence is a claim only a fresh snapshot can make.
 *   3. **No location prompt on load.** The context is granted nothing; the wrapped
 *      Geolocation API counts every request the document makes. A first visit — no camera
 *      in the link, nothing remembered — asks for nothing; a press of the locate control
 *      asks exactly once and answers the outcome out loud.
 *   4. **The control still works with permission.** Granted, with a position outside the
 *      coverage box (a deterministic answer), one press asks once and says so.
 *
 * Every wait is a polled condition with a deadline derived from the client's own
 * constants, times the suite's load margin; nothing sleeps for a duration and hopes.
 */

import { fileURLToPath } from 'node:url';

import type { Browser, Page } from 'puppeteer-core';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { GEO_TIMEOUT_MS } from '../src/adapters/browser-geolocation.js';
import { DEFAULT_CONFIG } from '../src/core/config.js';
import en from '../src/core/i18n/en.js';
import { LOCALE_STORAGE_KEY } from '../src/core/i18n/locale.js';
import { eventPath } from '../src/ui/logic/event-resolution.js';
import { ONBOARDING_DONE_VALUE, ONBOARDING_STORAGE_KEY } from '../src/ui/logic/onboarding.js';
import { launchBrowser } from './harness/browser.js';
import { loadFixtureSnapshot } from './harness/fixture.js';
import type { WireSnapshot } from './harness/fixture.js';
import { within } from './harness/load-margin.js';
import { HARNESS_POLL_INTERVAL_MS, startOrigin } from './harness/origin.js';
import type { HarnessOrigin, Scenario } from './harness/origin.js';
import { openInstrumentedPage, until } from './harness/page.js';
import type { InstrumentedPage } from './harness/page.js';

const DIST_DIR = fileURLToPath(new URL('../dist/', import.meta.url));

/** A returning reader: onboarding done, locale chosen — so the catalog asserted on is `en`. */
const STORAGE: Readonly<Record<string, string>> = {
  [ONBOARDING_STORAGE_KEY]: ONBOARDING_DONE_VALUE,
  [LOCALE_STORAGE_KEY]: 'en',
};

const EVENT_ID = 'fw-2026-q7f3d';
const EVENT_PAGE_SELECTOR = 'article.page.event-page';
const ROW_SELECTOR = '.home-list a.event-row';
const LOCATE_SELECTOR = '.map-controls-buttons .map-control';
const STATUS_SELECTOR = '.map-controls-status';
/** Outside the coverage box, so a granted fix has one deterministic answer. */
const OUTSIDE_COVERAGE = { latitude: 0, longitude: 0 };

/** Two polls at the client's worst jitter: long enough for the second failed attempt. */
const DEGRADED_BOUND_MS = Math.ceil(2 * HARNESS_POLL_INTERVAL_MS * 1.2);

/** The page-side record of every event-page state rendered, and of location requests. */
const SEEN_STATES_KEY = '__fireWatchE2eEventPageStates';
const NOT_FOUND_SEEN_KEY = '__fireWatchE2eNotFoundSeen';
const GEO_CALLS_KEY = '__fireWatchE2eGeolocationCalls';

/** The console noise this harness causes on purpose (basemap host blocked; scripted 503s). */
const EXPECTED_CONSOLE_ERRORS: readonly RegExp[] = [
  /Failed to load resource: net::ERR_BLOCKED_BY_CLIENT/,
  /Failed to fetch/,
];

let browser: Browser;
let fixture: WireSnapshot;
const cleanups: (() => Promise<void>)[] = [];

async function startHarness(scenario: Scenario): Promise<HarnessOrigin> {
  const origin = await startOrigin({
    distDir: DIST_DIR,
    fixture,
    advertiseStaticCopy: false,
    staleByMs: 0,
  });
  cleanups.push(() => origin.close());
  origin.setScenario(scenario);
  return origin;
}

async function openPage(origin: HarnessOrigin): Promise<InstrumentedPage> {
  const page = await openInstrumentedPage(browser, origin.baseUrl, STORAGE);
  cleanups.push(() => page.close());
  return page;
}

/**
 * Record, from before the app's first script, every `data-state` the event page renders
 * and whether the "not found" sentence ever reached the document. Observing `document`
 * itself covers the body that does not exist yet when this runs.
 */
async function watchEventPage(page: Page): Promise<void> {
  await page.evaluateOnNewDocument(
    (statesKey: string, notFoundKey: string, selector: string, notFoundText: string) => {
      const holder = window as unknown as Record<string, unknown>;
      const states: string[] = [];
      holder[statesKey] = states;
      holder[notFoundKey] = false;
      const record = (): void => {
        const state = document.querySelector(selector)?.getAttribute('data-state') ?? null;
        if (state !== null && states[states.length - 1] !== state) states.push(state);
        if (state === 'not-found' || (document.body?.textContent ?? '').includes(notFoundText)) {
          holder[notFoundKey] = true;
        }
      };
      new MutationObserver(record).observe(document, {
        subtree: true,
        childList: true,
        characterData: true,
        attributes: true,
        attributeFilter: ['data-state'],
      });
    },
    SEEN_STATES_KEY,
    NOT_FOUND_SEEN_KEY,
    EVENT_PAGE_SELECTOR,
    en.eventNotFound,
  );
}

const seenStates = (page: Page): Promise<string[]> =>
  page.evaluate((key: string) => {
    const value: unknown = (window as unknown as Record<string, unknown>)[key];
    return Array.isArray(value) ? value.map(String) : [];
  }, SEEN_STATES_KEY);

const notFoundSeen = (page: Page): Promise<boolean> =>
  page.evaluate(
    (key: string) => (window as unknown as Record<string, unknown>)[key] === true,
    NOT_FOUND_SEEN_KEY,
  );

const eventPageState = (page: Page): Promise<string | null> =>
  page.evaluate(
    (selector: string) => document.querySelector(selector)?.getAttribute('data-state') ?? null,
    EVENT_PAGE_SELECTOR,
  );

/** Count every location request the document makes, at the API the adapter calls. */
async function countGeolocation(page: Page): Promise<void> {
  await page.evaluateOnNewDocument((countKey: string) => {
    const holder = window as unknown as Record<string, unknown>;
    holder[countKey] = 0;
    const proto = Geolocation.prototype as unknown as Record<string, unknown>;
    for (const name of ['getCurrentPosition', 'watchPosition']) {
      const native = proto[name] as (this: Geolocation, ...args: unknown[]) => unknown;
      proto[name] = function counted(this: Geolocation, ...args: unknown[]): unknown {
        holder[countKey] = (holder[countKey] as number) + 1;
        return native.apply(this, args);
      };
    }
  }, GEO_CALLS_KEY);
}

const geolocationCalls = (page: Page): Promise<number> =>
  page.evaluate((key: string) => {
    const value: unknown = (window as unknown as Record<string, unknown>)[key];
    return typeof value === 'number' ? value : -1;
  }, GEO_CALLS_KEY);

const statusText = (page: Page): Promise<string> =>
  page.evaluate(
    (selector: string) => (document.querySelector(selector)?.textContent ?? '').trim(),
    STATUS_SELECTOR,
  );

async function pressLocate(page: Page): Promise<void> {
  const buttons = await page.$$(LOCATE_SELECTOR);
  const labels = await Promise.all(
    buttons.map((button) => button.evaluate((element) => element.textContent ?? '')),
  );
  const locate = buttons[labels.findIndex((label) => label.trim() === en.mapControls.locate)];
  if (locate === undefined) throw new Error('e2e: the "my location" control is missing');
  await locate.click();
}

function expectQuietConsole(page: InstrumentedPage): void {
  expect(
    page.consoleErrors.filter((text) => !EXPECTED_CONSOLE_ERRORS.some((re) => re.test(text))),
  ).toEqual([]);
  expect(page.pageErrors).toEqual([]);
}

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

describe('cold load — an event permalink before its snapshot', () => {
  it('is loading while the snapshot is held, then shows the event, and never says "not found"', async () => {
    const origin = await startHarness('fresh');
    const release = origin.holdSnapshots();
    const page = await openPage(origin);
    await watchEventPage(page.page);

    await page.page.goto(origin.baseUrl + eventPath(EVENT_ID), { waitUntil: 'load' });
    // The snapshot request is in and held: the page is past boot and still has nothing.
    await until(
      () => origin.requests.length > 0 && eventPageState(page.page).then((s) => s === 'loading'),
      { timeoutMs: within(5_000), what: 'the event page in its loading state' },
    );
    expect(
      await page.page.$eval(`${EVENT_PAGE_SELECTOR}`, (article) =>
        article.getAttribute('aria-busy'),
      ),
    ).toBe('true');
    expect(
      await page.page.$eval(`${EVENT_PAGE_SELECTOR} [role="status"]`, (line) =>
        (line.textContent ?? '').trim(),
      ),
    ).toBe(en.loading);

    release();
    await page.page.waitForSelector(`${EVENT_PAGE_SELECTOR}[data-state="found"] h1`, {
      timeout: within(5_000),
    });

    expect(await notFoundSeen(page.page)).toBe(false);
    expect(await seenStates(page.page)).toEqual(['loading', 'found']);
    expect(
      origin.requests.some(
        (request) => request.path === DEFAULT_CONFIG.snapshotUrl && request.status === 200,
      ),
    ).toBe(true);
    expectQuietConsole(page);
  });

  it('says "could not load", never "not found", when the snapshot keeps failing', async () => {
    const origin = await startHarness('origin-down');
    const page = await openPage(origin);
    await watchEventPage(page.page);

    await page.page.goto(origin.baseUrl + eventPath(EVENT_ID), { waitUntil: 'load' });
    await page.page.waitForSelector(`${EVENT_PAGE_SELECTOR}[data-state="unavailable"]`, {
      timeout: within(DEGRADED_BOUND_MS),
    });
    expect(
      await page.page.$eval(`${EVENT_PAGE_SELECTOR} [role="status"]`, (line) =>
        (line.textContent ?? '').trim(),
      ),
    ).toBe(en.eventUnavailable);
    // The way out is on the page in this state too.
    expect(await page.page.$(`${EVENT_PAGE_SELECTOR} a.back-link`)).not.toBeNull();

    expect(await notFoundSeen(page.page)).toBe(false);
    expect(await seenStates(page.page)).toEqual(['loading', 'unavailable']);
  });
});

describe('cold load — no location request until the reader asks (07-product-ux §5.9.1)', () => {
  it('asks for nothing on a first visit, and asks once on a press of the locate control', async () => {
    const origin = await startHarness('fresh');
    const page = await openPage(origin);
    await countGeolocation(page.page);

    // A first visit: no `#map=` in the link and no remembered frame in storage.
    await page.page.goto(origin.baseUrl + '/', { waitUntil: 'load' });
    await page.page.waitForSelector(ROW_SELECTOR, { timeout: within(15_000) });
    // The removed automatic attempt fired from the map controls' mount effect; the list
    // being up means that effect has long run.
    await page.page.waitForSelector(LOCATE_SELECTOR, { timeout: within(5_000) });
    expect(await geolocationCalls(page.page)).toBe(0);
    expect(await statusText(page.page)).toBe('');

    // Permission not granted: whatever the browser answers (a refusal, or nothing until
    // the adapter's own timeout), the control says so out loud.
    await pressLocate(page.page);
    const answer = await until(
      async () => {
        const text = await statusText(page.page);
        return text === en.mapControls.locationDenied || text === en.mapControls.locationUnavailable
          ? text
          : null;
      },
      { timeoutMs: within(GEO_TIMEOUT_MS), what: 'the answer to the locate press' },
    );
    expect(answer.length).toBeGreaterThan(0);
    expect(await geolocationCalls(page.page)).toBe(1);
    expectQuietConsole(page);
  });

  it('with permission granted, still asks only on the press, and answers the fix', async () => {
    const origin = await startHarness('fresh');
    const page = await openPage(origin);
    await countGeolocation(page.page);
    await page.page.browserContext().overridePermissions(origin.baseUrl, ['geolocation']);
    await page.page.setGeolocation(OUTSIDE_COVERAGE);

    await page.page.goto(origin.baseUrl + '/', { waitUntil: 'load' });
    await page.page.waitForSelector(ROW_SELECTOR, { timeout: within(15_000) });
    await page.page.waitForSelector(LOCATE_SELECTOR, { timeout: within(5_000) });
    // A granted permission is not a request: the map does not jump to the reader unasked.
    expect(await geolocationCalls(page.page)).toBe(0);

    await pressLocate(page.page);
    await until(
      async () => (await statusText(page.page)) === en.mapControls.locationOutsideCoverage,
      { timeoutMs: within(GEO_TIMEOUT_MS), what: 'the outside-coverage answer' },
    );
    expect(await geolocationCalls(page.page)).toBe(1);
    expectQuietConsole(page);
  });
});
