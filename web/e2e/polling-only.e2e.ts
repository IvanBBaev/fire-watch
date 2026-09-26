/**
 * CI-7 — the polling-only end-to-end suite (docs/GATES.md CI-7, docs/TASKS.md E6, review
 * 08 §5.7.3).
 *
 * The gate says: every feature must be complete on T1 alone, with the stream switched
 * off and nothing but `/snapshot.json` polled on a cadence. This suite proves it against
 * the *built* app, in a real browser, over real HTTP — the same `web/dist` a deploy would
 * ship, a hand-rolled origin (`harness/origin.ts`) that answers the app's own routes from
 * the shipped fixture, and no test hook in application code. The app is configured the
 * way production configures it: the fleet-control document says `poll`, and the shortest
 * interval the client accepts keeps the run under a minute per scenario.
 *
 * What is asserted is what a user (and an operator) could see: DOM state, the URL, and
 * the request log of the origin. Every wait is a polled condition with a deadline, never
 * a sleep; every timing bound is derived from the constants the client itself uses, so a
 * change to the cadence rules moves the bounds with it.
 *
 * Scenarios, in the order a T1-only life runs:
 *   1. boot — client-config first, then one full snapshot; the in-window events list;
 *      the stream is never asked for, at the network and at the `EventSource` API;
 *   2. cadence — cursor polls on the interval, unconditional first, then a 304 on the tag;
 *   3. change — a status flip, an arrival and a removal reach the list by polling alone,
 *      with the S15 rule visible: a cursor answer never removes, the next full does;
 *   4. permalinks — a row click lands on the detail page; a merged id resolves to its
 *      survivor and the URL is replaced with the canonical one;
 *   5. the honest clock — a stopped publishing pipeline puts the staleness banner up,
 *      stamped with the instant data actually stopped, and it stays up across polls; a
 *      healthy origin renders no banner at all;
 *   6. A1.2 — an origin answering 503 on a streak flips the client to the static copy,
 *      and the list stays populated the whole time;
 *   7. no WebGL — a browser that refuses the map its context still gets the product: the
 *      in-window list, a row click through to the detail page, and a quiet console;
 *   8. sharing (TASKS F6) — an event permalink carries its own Open Graph / Twitter meta,
 *      with the observation stamp as an absolute Sofia date and time, and gives it back
 *      when the reader leaves; the share button hands the platform sheet a 1200×630 PNG.
 */

import { fileURLToPath } from 'node:url';

import { SNAPSHOT_PUSH_WARN_SECONDS } from '@fire-watch/contracts';
import type { Browser, Page } from 'puppeteer-core';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { DEFAULT_CONFIG } from '../src/core/config.js';
import { STATIC_FLIP_SPAN_INTERVALS, STATIC_FLIP_STREAK } from '../src/core/feed/supervisor.js';
import { LOCALE_STORAGE_KEY } from '../src/core/i18n/locale.js';
import { DEFAULT_AGE_WINDOW, ageWindowHours } from '../src/core/time/age-filter.js';
import { eventPath } from '../src/ui/logic/event-resolution.js';
import { ONBOARDING_DONE_VALUE, ONBOARDING_STORAGE_KEY } from '../src/ui/logic/onboarding.js';
import { launchBrowser } from './harness/browser.js';
import { loadFixtureSnapshot, observedWithin } from './harness/fixture.js';
import type { WireFeature, WireSnapshot } from './harness/fixture.js';
import {
  CURSOR_QUERY_PARAM,
  HARNESS_POLL_INTERVAL_MS,
  STATIC_COPY_PATH,
  startOrigin,
} from './harness/origin.js';
import type { HarnessOrigin, LoggedRequest, Scenario } from './harness/origin.js';
import { openInstrumentedPage, until } from './harness/page.js';
import type { InstrumentedPage } from './harness/page.js';

const DIST_DIR = fileURLToPath(new URL('../dist/', import.meta.url));

/** The persisted state a returning user has: onboarding done, locale chosen. */
const STORAGE: Readonly<Record<string, string>> = {
  [ONBOARDING_STORAGE_KEY]: ONBOARDING_DONE_VALUE,
  [LOCALE_STORAGE_KEY]: 'en',
};

const ROW_SELECTOR = '.home-list a.event-row';
const BANNER_SELECTOR = '.fw-banner[role="status"]';
const EVENT_PAGE_SELECTOR = 'article.page.event-page';

/** The home list's default window, in ms — what `observedWithin` is compared against. */
const AGE_WINDOW_MS = (() => {
  const hours = ageWindowHours(DEFAULT_AGE_WINDOW);
  if (hours === null) throw new Error('e2e: the default age window must be bounded');
  return hours * 3_600_000;
})();

/** Twice the banner's threshold: unmistakably old, and older than the T2 flip bound too. */
const STALE_BY_MS = 2 * (2 * SNAPSHOT_PUSH_WARN_SECONDS * 1_000);

/** The client jitters every delay by ±20 %; bounds on its timing allow for the worst side. */
const JITTER_CEILING = 1.2;

/** How long the DOM is given to reflect a change the next poll should carry. */
const NEXT_POLL_MS = Math.ceil(2 * HARNESS_POLL_INTERVAL_MS * JITTER_CEILING);

/**
 * The A1.2 flip needs `STATIC_FLIP_STREAK` failures spanning `STATIC_FLIP_SPAN_INTERVALS`
 * intervals, with the client backing off exponentially between them. In the worst case
 * the span rule needs one failure more than the streak rule, so the bound is the next
 * scheduled poll plus the backoff series for that many failures, at maximum jitter.
 */
const STATIC_FLIP_BOUND_MS = Math.ceil(
  (1 + (2 ** STATIC_FLIP_STREAK - 1)) * HARNESS_POLL_INTERVAL_MS * JITTER_CEILING,
);

/**
 * The console errors this harness provokes on purpose, and which prove nothing about the
 * app: the basemap style is fetched from a third party the page is not allowed to reach,
 * so the request is aborted and MapLibre reports both the abort and its own failed fetch.
 * That the product carries on without a basemap is itself asserted — every scenario reads
 * the list, a detail page or the banner with the map in exactly that state. Anything else
 * in the console is a failure.
 */
const EXPECTED_CONSOLE_ERRORS: readonly RegExp[] = [
  /Failed to load resource: net::ERR_BLOCKED_BY_CLIENT/,
  /Failed to fetch/,
];

/**
 * Empty, and meant to stay empty: any uncaught error, in any scenario, fails.
 *
 * It held one pattern — `Style is not done loading.` — for as long as the map controller
 * called `setFeatureState` without checking that there was a style to put state on. With
 * the basemap host unreachable from this page there never is one, so the selection path
 * threw on every run. The note that used to sit here also named the wrong path: it blamed
 * the permalink that opens with an event already selected, but that path runs inside the
 * map chunk's dynamic `import().then(...)`, and `ui/map-pane.tsx` catches whatever it
 * throws. The error was a *row click* — the shell's selection effect calling `setSelected`
 * directly. The constant stays because the machinery around it does; a scenario that needs
 * an entry in it is a scenario that has found a bug.
 */
const EXPECTED_PAGE_ERRORS: readonly RegExp[] = [];

let browser: Browser;
let fixture: WireSnapshot;
const cleanups: (() => Promise<void>)[] = [];

interface Booted {
  readonly origin: HarnessOrigin;
  readonly page: InstrumentedPage;
}

interface BootOptions {
  readonly scenario?: Scenario;
  readonly advertiseStaticCopy?: boolean;
  readonly path?: string;
  /** What must be in the DOM before the scenario runs; the home list by default. */
  readonly readySelector?: string;
  /** Boot in a document where no canvas will hand out a WebGL context. */
  readonly denyWebGl?: boolean;
}

async function boot(options: BootOptions = {}): Promise<Booted> {
  const origin = await startOrigin({
    distDir: DIST_DIR,
    fixture,
    advertiseStaticCopy: options.advertiseStaticCopy ?? false,
    staleByMs: STALE_BY_MS,
  });
  cleanups.push(() => origin.close());
  origin.setScenario(options.scenario ?? 'fresh');

  const page = await openInstrumentedPage(browser, origin.baseUrl, STORAGE, {
    denyWebGl: options.denyWebGl ?? false,
  });
  cleanups.push(() => page.close());
  await page.page.goto(origin.baseUrl + (options.path ?? '/'), { waitUntil: 'load' });
  await page.page.waitForSelector(options.readySelector ?? ROW_SELECTOR, { timeout: 15_000 });
  return { origin, page };
}

const requestsTo = (origin: HarnessOrigin, path: string): LoggedRequest[] =>
  origin.requests.filter((request) => request.path === path);

const snapshotRequests = (origin: HarnessOrigin): LoggedRequest[] =>
  requestsTo(origin, DEFAULT_CONFIG.snapshotUrl);

const isCursor = (request: LoggedRequest): boolean =>
  request.query[CURSOR_QUERY_PARAM] !== undefined;

function requireAt<T>(items: readonly T[], index: number): T {
  const item = items[index];
  if (item === undefined) throw new Error(`e2e: no item at ${index} (have ${items.length})`);
  return item;
}

/** The rows' hrefs, sorted: the list's own order is a UI concern, membership is the claim. */
const rowHrefs = async (page: Page): Promise<string[]> => {
  const hrefs = await page.$$eval(ROW_SELECTOR, (rows) =>
    rows.map((row) => row.getAttribute('href') ?? ''),
  );
  return hrefs.sort();
};

const rowBadgeClass = (page: Page, href: string): Promise<string | null> =>
  page.evaluate(
    (selector: string, target: string) => {
      const badge = document.querySelector(`${selector}[href="${target}"] .status-badge`);
      return badge === null ? null : badge.className;
    },
    ROW_SELECTOR,
    href,
  );

const hasSelector = (page: Page, selector: string): Promise<boolean> =>
  page.evaluate((target: string) => document.querySelector(target) !== null, selector);

const pathname = (page: Page): Promise<string> => page.evaluate(() => window.location.pathname);

const bannerText = async (page: Page): Promise<string> =>
  (await page.$eval(BANNER_SELECTOR, (banner) => banner.textContent ?? '')).trim();

/**
 * `HH:MM` in Europe/Sofia — the app's own display zone (GLOSSARY: one zone, always), built
 * here from `Intl` rather than imported from `core/i18n`, so the assertion is an
 * independent reading of the instant and not the formatter agreeing with itself.
 */
const SOFIA_HOUR_MINUTE = new Intl.DateTimeFormat('en-GB', {
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
  timeZone: 'Europe/Sofia',
});

const sofiaHourMinute = (iso: string): string => SOFIA_HOUR_MINUTE.format(new Date(iso));

/** `DD/MM/YYYY, HH:MM` in Europe/Sofia — independent of the app, like the one above. */
const SOFIA_DATE_TIME = new Intl.DateTimeFormat('en-GB', {
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
  timeZone: 'Europe/Sofia',
});

const sofiaDateTime = (iso: string): string => SOFIA_DATE_TIME.format(new Date(iso));

const metaContent = (page: Page, selector: string): Promise<string | null> =>
  page.evaluate(
    (target: string) => document.head.querySelector(target)?.getAttribute('content') ?? null,
    selector,
  );

/** Ids the home list should show now, as the origin would serve the set at this instant. */
function expectedRows(origin: HarnessOrigin): string[] {
  const now = Date.now();
  return observedWithin(origin.servedSnapshot(now), now, AGE_WINDOW_MS)
    .map((id) => eventPath(id))
    .sort();
}

async function waitForRows(page: Page, expected: readonly string[], what: string): Promise<void> {
  await until(
    async () => {
      const hrefs = await rowHrefs(page);
      return hrefs.length === expected.length && hrefs.every((href, i) => href === expected[i]);
    },
    { timeoutMs: NEXT_POLL_MS, what },
  );
}

function unexpectedConsoleErrors(
  page: InstrumentedPage,
  alsoExpected: readonly RegExp[],
): string[] {
  const allowed = [...EXPECTED_CONSOLE_ERRORS, ...alsoExpected];
  return page.consoleErrors.filter((text) => !allowed.some((pattern) => pattern.test(text)));
}

/**
 * The quiet-page assertions every scenario ends with. `alsoExpected` is for a scenario
 * that scripts a failure of its own — the console noise of an outage the test *caused* is
 * evidence the script ran, not evidence of a bug — and is deliberately per-scenario, so
 * one scenario's allowance never silences another's.
 */
async function expectQuietPage(
  page: InstrumentedPage,
  alsoExpected: readonly RegExp[] = [],
): Promise<void> {
  expect(unexpectedConsoleErrors(page, alsoExpected)).toEqual([]);
  expect(
    page.pageErrors.filter((text) => !EXPECTED_PAGE_ERRORS.some((pattern) => pattern.test(text))),
  ).toEqual([]);
  expect(await page.eventSourceCount()).toBe(0);
}

/** A feature in the default window that no scenario has touched, by id. */
function fixtureFeature(id: string): WireFeature {
  const feature = fixture.features.find((candidate) => candidate.id === id);
  if (feature === undefined) throw new Error(`e2e: fixture has no feature ${id}`);
  return feature;
}

/** A fresh in-window arrival: an existing feature under a new identity. */
function arrivalFrom(feature: WireFeature, id: string): WireFeature {
  return {
    ...feature,
    id,
    properties: {
      ...feature.properties,
      id,
      place_name_bg: 'Тестово',
      place_name_en: 'Testovo',
    },
  };
}

beforeAll(async () => {
  fixture = await loadFixtureSnapshot();
  browser = await launchBrowser();
});

afterAll(async () => {
  await browser.close();
});

afterEach(async () => {
  // Newest first: the page goes before the origin it was talking to.
  while (cleanups.length > 0) {
    const cleanup = cleanups.pop();
    if (cleanup !== undefined) await cleanup();
  }
});

describe('CI-7 polling-only', () => {
  it('boots on T1: client-config, then one full snapshot, then the in-window list', async () => {
    const { origin, page } = await boot();

    const expected = expectedRows(origin);
    // The window must actually cut: a list that shows the whole fixture proves nothing.
    expect(expected.length).toBeGreaterThan(0);
    expect(expected.length).toBeLessThan(fixture.features.length);
    await waitForRows(page.page, expected, 'the in-window rows');

    const configAt = origin.requests.findIndex(
      (request) => request.path === DEFAULT_CONFIG.clientConfigUrl,
    );
    const snapshotAt = origin.requests.findIndex(
      (request) => request.path === DEFAULT_CONFIG.snapshotUrl,
    );
    expect(configAt).toBeGreaterThanOrEqual(0);
    expect(snapshotAt).toBeGreaterThan(configAt);
    const first = requireAt(origin.requests, snapshotAt);
    expect(first.query).toEqual({});
    expect(first.conditional).toBe(false);
    expect(first.status).toBe(200);

    expect(await page.page.$eval('html', (html) => html.lang)).toBe('en');
    expect(requestsTo(origin, DEFAULT_CONFIG.streamUrl)).toEqual([]);
    expect(page.blocked.every((url) => !url.startsWith(origin.baseUrl))).toBe(true);
    await expectQuietPage(page);
  });

  it('polls the origin on the cadence with a cursor, and revalidates on the tag', async () => {
    const { origin, page } = await boot();

    const cursors = await until(
      () => {
        const seen = snapshotRequests(origin).filter(isCursor);
        return seen.length >= 2 ? seen : null;
      },
      { timeoutMs: 3 * NEXT_POLL_MS, what: 'two cursor polls' },
    );
    const first = requireAt(cursors, 0);
    const second = requireAt(cursors, 1);
    expect(first.query[CURSOR_QUERY_PARAM]).toBe(String(fixture.max_seq));
    expect(first.conditional).toBe(false);
    expect(first.status).toBe(200);
    expect(second.query[CURSOR_QUERY_PARAM]).toBe(String(fixture.max_seq));
    expect(second.conditional).toBe(true);
    expect(second.status).toBe(304);
    // On the cadence: one interval apart, within the client's jitter.
    const gap = second.at - first.at;
    expect(gap).toBeGreaterThanOrEqual(HARNESS_POLL_INTERVAL_MS * (2 - JITTER_CEILING) - 500);
    expect(gap).toBeLessThanOrEqual(HARNESS_POLL_INTERVAL_MS * JITTER_CEILING + 500);

    expect(snapshotRequests(origin).filter((request) => !isCursor(request))).toHaveLength(1);
    expect(requestsTo(origin, DEFAULT_CONFIG.streamUrl)).toEqual([]);
    await expectQuietPage(page);
  });

  it('carries a status flip, an arrival and a removal to the list by polling alone', async () => {
    const { origin, page } = await boot();
    await waitForRows(page.page, expectedRows(origin), 'the in-window rows');

    // A status flip arrives on the next cursor poll.
    const flipped = fixtureFeature('fw-2026-q7f3d');
    const flippedHref = eventPath(flipped.id);
    expect(await rowBadgeClass(page.page, flippedHref)).toContain(
      `status-${flipped.properties.status}`,
    );
    const flipSeq = origin.snapshot.bump(flipped.id, { status: 'signal_weakening' });
    await until(
      async () =>
        (await rowBadgeClass(page.page, flippedHref))?.includes('status-signal_weakening'),
      { timeoutMs: NEXT_POLL_MS, what: 'the flipped status badge' },
    );
    expect(await rowBadgeClass(page.page, flippedHref)).not.toContain(
      `status-${flipped.properties.status}`,
    );

    // An arrival: a new id the client has never held, above its settled floor.
    const arrival = arrivalFrom(fixtureFeature('fw-2026-x4k6m'), 'fw-2026-e2e0a');
    const arrivalSeq = origin.snapshot.add(arrival);
    await waitForRows(page.page, expectedRows(origin), 'the arrival in the list');
    // The cursor moved with the mark: the poll that fetched the arrival asked past the flip.
    const arrivalPoll = snapshotRequests(origin)
      .filter(isCursor)
      .find(
        (request) =>
          request.status === 200 && request.query[CURSOR_QUERY_PARAM] === String(flipSeq),
      );
    expect(arrivalPoll).toBeDefined();

    // A removal: the cursor answer that omits it does not remove it (S15) ...
    const removed = fixtureFeature('fw-2026-k9s2r');
    const removedHref = eventPath(removed.id);
    expect(await rowHrefs(page.page)).toContain(removedHref);
    const removeSeq = origin.snapshot.remove(removed.id);
    const partialAfterRemoval = await until(
      () =>
        snapshotRequests(origin)
          .filter(isCursor)
          .find(
            (request) =>
              request.status === 200 && request.query[CURSOR_QUERY_PARAM] === String(arrivalSeq),
          ) ?? null,
      { timeoutMs: NEXT_POLL_MS, what: 'the cursor poll after the removal' },
    );
    expect(partialAfterRemoval.status).toBe(200);
    // Let one more poll pass on the new mark: still there, and the mark has moved past it.
    await until(
      () =>
        snapshotRequests(origin).some(
          (request) => isCursor(request) && request.query[CURSOR_QUERY_PARAM] === String(removeSeq),
        ),
      { timeoutMs: NEXT_POLL_MS, what: 'a cursor poll on the mark past the removal' },
    );
    expect(await rowHrefs(page.page)).toContain(removedHref);

    // ... and the next full snapshot does. Connectivity returning is one of the two cues
    // (ADR-003 D3) that force a full refetch before any transport is trusted again.
    await page.page.setOfflineMode(true);
    await until(() => page.page.evaluate(() => !navigator.onLine), {
      timeoutMs: 5_000,
      what: 'the page to go offline',
    });
    await page.page.setOfflineMode(false);
    await waitForRows(page.page, expectedRows(origin), 'the list without the removed event');
    const fullAfterRemoval = snapshotRequests(origin).filter(
      (request) =>
        !isCursor(request) && request.at >= partialAfterRemoval.at && request.status === 200,
    );
    expect(fullAfterRemoval.length).toBeGreaterThanOrEqual(1);

    expect(requestsTo(origin, DEFAULT_CONFIG.streamUrl)).toEqual([]);
    await expectQuietPage(page);
  });

  it('opens the detail page from a row, and resolves a merged permalink to its survivor', async () => {
    const { origin, page } = await boot();
    await waitForRows(page.page, expectedRows(origin), 'the in-window rows');

    const target = fixtureFeature('fw-2026-q7f3d');
    await page.page.click(`${ROW_SELECTOR}[href="${eventPath(target.id)}"]`);
    await page.page.waitForSelector(`${EVENT_PAGE_SELECTOR} h1`, { timeout: 5_000 });
    expect(await pathname(page.page)).toBe(eventPath(target.id));
    expect(await page.page.$eval(`${EVENT_PAGE_SELECTOR} h1`, (h1) => h1.textContent)).toContain(
      target.properties.place_name_en,
    );
    expect(
      await page.page.$eval(`${EVENT_PAGE_SELECTOR} p.lifecycle-line`, (line) => line.textContent),
    ).not.toBe('');
    await expectQuietPage(page);

    // A merged tombstone's permalink: the URL is replaced with the survivor's, never 404.
    const tombstone = fixtureFeature('fw-2026-z7c3f');
    const survivor = tombstone.properties.merged_into;
    if (survivor === null) throw new Error('e2e: the fixture tombstone must name a survivor');
    const merged = await boot({
      path: eventPath(tombstone.id),
      readySelector: EVENT_PAGE_SELECTOR,
    });
    await until(async () => (await pathname(merged.page.page)) === eventPath(survivor), {
      timeoutMs: 10_000,
      what: 'the permalink to resolve to the survivor',
    });
    await merged.page.page.waitForSelector(`${EVENT_PAGE_SELECTOR} h1`, { timeout: 5_000 });
    expect(
      await merged.page.page.$eval(`${EVENT_PAGE_SELECTOR} h1`, (h1) => h1.textContent),
    ).toContain(fixtureFeature(survivor).properties.place_name_en);
    await expectQuietPage(merged.page);
  });

  it('banners a stopped pipeline with the instant it stopped, and stays quiet when fresh', async () => {
    const stale = await boot({ scenario: 'stale' });
    await stale.page.page.waitForSelector(BANNER_SELECTOR, { timeout: 10_000 });

    // The stamp is the claim: a banner that says "delayed since <when data stopped>" is
    // the honest one, and a banner reading the wrong instant — or the offline banner,
    // which carries no instant at all — fails this.
    const stoppedIso = stale.origin.servedSnapshot(Date.now()).generated_at;
    expect(await bannerText(stale.page.page)).toContain(sofiaHourMinute(stoppedIso));

    // And it stays up. The origin keeps answering — `304` on every revalidation — and the
    // client treats a full `304` as the set being confirmed *now*; the banner must survive
    // that, or an outage would banner for one frame and then go quiet.
    await until(
      () => snapshotRequests(stale.origin).filter((request) => request.status === 304).length >= 2,
      { timeoutMs: 3 * NEXT_POLL_MS, what: 'two revalidations against the stopped origin' },
    );
    expect(await bannerText(stale.page.page)).toContain(sofiaHourMinute(stoppedIso));

    // Stale, not broken: the list is still there (the map fails open).
    expect(await rowHrefs(stale.page.page)).toEqual(expectedRows(stale.origin));
    await expectQuietPage(stale.page);

    const fresh = await boot();
    // Both banner inputs must have arrived before "no banner" means anything.
    await until(
      () =>
        requestsTo(fresh.origin, DEFAULT_CONFIG.freshnessUrl).length >= 1 &&
        snapshotRequests(fresh.origin).filter(isCursor).length >= 1,
      { timeoutMs: 3 * NEXT_POLL_MS, what: 'a freshness report and a cursor poll' },
    );
    expect(await hasSelector(fresh.page.page, BANNER_SELECTOR)).toBe(false);
    await expectQuietPage(fresh.page);
  });

  it(
    'flips to the static copy after a streak of origin failures, and keeps the list',
    { timeout: STATIC_FLIP_BOUND_MS + 30_000 },
    async () => {
      const { origin, page } = await boot({ advertiseStaticCopy: true });
      const expected = expectedRows(origin);
      await waitForRows(page.page, expected, 'the in-window rows');
      expect(requestsTo(origin, STATIC_COPY_PATH)).toEqual([]);

      origin.setScenario('origin-down');
      const downSince = Date.now();
      const staticRead = await until(
        () =>
          requestsTo(origin, STATIC_COPY_PATH).find(
            (request) => request.status === 200 && request.at >= downSince,
          ) ?? null,
        { timeoutMs: STATIC_FLIP_BOUND_MS, what: 'the static copy to be read' },
      );

      // The flip rule, as observed at the origin: a streak of unusable answers spanning
      // the required intervals, and nothing read from the static copy before it was met.
      const failures = snapshotRequests(origin).filter(
        (request) => request.status === 503 && request.at <= staticRead.at,
      );
      expect(failures.length).toBeGreaterThanOrEqual(STATIC_FLIP_STREAK);
      const span = requireAt(failures, failures.length - 1).at - requireAt(failures, 0).at;
      expect(span).toBeGreaterThanOrEqual(
        STATIC_FLIP_SPAN_INTERVALS * HARNESS_POLL_INTERVAL_MS - 1_000,
      );

      // Still the same list, still no error surface.
      expect(await rowHrefs(page.page)).toEqual(expected);
      expect(await hasSelector(page.page, BANNER_SELECTOR)).toBe(false);
      expect(requestsTo(origin, DEFAULT_CONFIG.streamUrl)).toEqual([]);
      // The scripted outage is loud in the console by design: every failed snapshot fetch
      // is one line. Allowed here and nowhere else, and only for the status this scenario
      // scripts — the app's own reaction to it is what the assertions above measure.
      await expectQuietPage(page, [
        /Failed to load resource: the server responded with a status of 503/,
      ]);
    },
  );

  it('serves a browser that refuses the map a WebGL context', async () => {
    const { origin, page } = await boot({ denyWebGl: true });

    // The premise, checked rather than assumed: in this document no canvas hands out the
    // context MapLibre needs to exist, which is the state a launch without
    // `--enable-unsafe-swiftshader` leaves the whole browser in.
    expect(
      await page.page.evaluate(
        () => document.createElement('canvas').getContext('webgl2') === null,
      ),
    ).toBe(true);

    // The list is a peer surface to the map, not decoration around it: the same window
    // still cuts the same rows, with nothing to draw them on.
    const expected = expectedRows(origin);
    expect(expected.length).toBeGreaterThan(0);
    expect(expected.length).toBeLessThan(fixture.features.length);
    await waitForRows(page.page, expected, 'the in-window rows without a map');

    // And the map said so once, on the app's own boot timeline, instead of throwing a
    // camera read per store push — the mark is set by the first read that cannot answer,
    // and the latch behind it is why there is never a second.
    await until(
      () =>
        page.page.evaluate(
          () => performance.getEntriesByName('fw:map-unavailable', 'mark').length > 0,
        ),
      { timeoutMs: NEXT_POLL_MS, what: 'the map to record that it has no frame' },
    );

    // The row click is the path that used to throw out of `setSelected`; it still reaches
    // the detail page, and the shell's fly-to for the new selection has nowhere to fly.
    const target = fixtureFeature('fw-2026-q7f3d');
    await page.page.click(`${ROW_SELECTOR}[href="${eventPath(target.id)}"]`);
    await page.page.waitForSelector(`${EVENT_PAGE_SELECTOR} h1`, { timeout: 5_000 });
    expect(await pathname(page.page)).toBe(eventPath(target.id));
    expect(await page.page.$eval(`${EVENT_PAGE_SELECTOR} h1`, (h1) => h1.textContent)).toContain(
      target.properties.place_name_en,
    );

    expect(requestsTo(origin, DEFAULT_CONFIG.streamUrl)).toEqual([]);
    // MapLibre reports the refused context itself, loudly, and that report is the library
    // telling the truth about the environment this scenario scripts. Allowed here and
    // nowhere else; the uncaught-error list stays empty for this scenario like every other.
    await expectQuietPage(page, [/WebGL2 is required to display this map/]);
  });
  it('gives an event permalink its share meta, and shares a card as a 1200×630 PNG', async () => {
    const target = fixtureFeature('fw-2026-q7f3d');
    const bootedAt = Date.now();
    const { origin, page } = await boot({
      path: eventPath(target.id),
      readySelector: `${EVENT_PAGE_SELECTOR} h1`,
    });

    // The served clock moves with the harness's, so the stamp the app holds is the one
    // anchored somewhere between boot and now: at most a minute boundary apart.
    const readAt = Date.now();
    const servedStamps = [bootedAt, readAt].map((at) => {
      const served = origin.servedSnapshot(at).features.find((f) => f.id === target.id);
      if (served === undefined) throw new Error(`e2e: origin does not serve ${target.id}`);
      return sofiaDateTime(served.properties.last_observed_at);
    });

    const title = await metaContent(page.page, 'meta[property="og:title"]');
    expect(title).toContain(target.properties.place_name_en);
    expect(await metaContent(page.page, 'meta[name="twitter:title"]')).toBe(title);
    expect(await metaContent(page.page, 'meta[property="og:url"]')).toBe(
      origin.baseUrl + eventPath(target.id),
    );
    const description = (await metaContent(page.page, 'meta[property="og:description"]')) ?? '';
    expect(servedStamps.some((stamp) => description.includes(stamp))).toBe(true);
    // Exactly one of each tag: the page overrode the shell's defaults, it did not add twins.
    expect(
      await page.page.evaluate(
        () => document.head.querySelectorAll('meta[property="og:title"]').length,
      ),
    ).toBe(1);

    // The platform share sheet, scripted: it accepts files and records what it was handed.
    await page.page.evaluate(() => {
      const shared: { name: string; type: string; bytes: number[] }[] = [];
      Object.assign(window, { __sharedFiles: shared });
      Object.defineProperty(navigator, 'canShare', { configurable: true, value: () => true });
      Object.defineProperty(navigator, 'share', {
        configurable: true,
        value: async (data: ShareData) => {
          for (const file of data.files ?? []) {
            shared.push({
              name: file.name,
              type: file.type,
              bytes: [...new Uint8Array(await file.arrayBuffer()).slice(0, 24)],
            });
          }
        },
      });
    });
    await page.page.click(`${EVENT_PAGE_SELECTOR} button.share-card-button`);
    const shared = await until(
      async () => {
        const files = await page.page.evaluate(
          () =>
            (
              window as unknown as {
                __sharedFiles: { name: string; type: string; bytes: number[] }[];
              }
            ).__sharedFiles,
        );
        return files.length > 0 ? files : null;
      },
      { timeoutMs: 5_000, what: 'the share sheet to receive the card' },
    );
    const file = requireAt(shared, 0);
    expect(file.name).toBe(`${target.id}.png`);
    expect(file.type).toBe('image/png');
    // PNG signature, then the IHDR chunk: width and height as big-endian 32-bit integers.
    expect(file.bytes.slice(0, 8)).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    const u32 = (at: number): number =>
      file.bytes.slice(at, at + 4).reduce((value, byte) => value * 256 + byte, 0);
    expect([u32(16), u32(20)]).toEqual([1200, 630]);

    // Leaving the event in-app (no reload) gives the shell its defaults back.
    await page.page.click(`${EVENT_PAGE_SELECTOR} a.back-link`);
    await page.page.waitForSelector(ROW_SELECTOR, { timeout: 5_000 });
    expect(await pathname(page.page)).toBe('/');
    expect(await metaContent(page.page, 'meta[property="og:title"]')).toBe('Fire Watch');
    expect(await metaContent(page.page, 'meta[property="og:description"]')).toBeNull();

    await expectQuietPage(page);
  });
});
