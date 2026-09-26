/**
 * E6 — the T2 failover demo (docs/TASKS.md E6, ADR-003 A1.2, F4 / ADR-005 honest clock).
 *
 * One session, end to end, against the built app in a real browser:
 *
 *   1. **T1.** The app boots on the origin and polls it with a cursor. The static mirror
 *      is advertised by client-config but never read.
 *   2. **The origin dies.** Every API route answers `503` (`origin-dead`); the push job has
 *      just put its last object on the mirror. The client flips to the mirror — a separate
 *      server on its own origin serving the object exactly as E3 writes it
 *      (`harness/mirror.ts`) — first unconditionally, then revalidating on the bucket's tag
 *      through a CORS preflight. The list stays whole and no banner goes up: T2 on a live
 *      mirror is not a user-facing state (ADR-003 D2).
 *   3. **The push job is dead too, and time passes.** Nothing is pushed any more and the
 *      world clock jumps past the snapshot-age threshold (GLOSSARY §3b). The mirror keeps
 *      answering `304` for its frozen object — and that must *not* restamp the snapshot's
 *      age (the F4 fix: a CDN vouches for its object, not for the pipeline). The banner
 *      goes up with the instant the mirror's document was generated, and stays up.
 *   4. **The origin returns.** The client's origin probes succeed; the banner clears at
 *      once because the origin vouches for the set again, but the client stays on T2:
 *      healthy answers must hold for the whole hysteresis window before it trusts the
 *      origin again (no flapping, L-2 criterion 4).
 *   5. **Back to T1.** The world clock jumps past the hysteresis; the client returns to
 *      cursor polling on the origin and stops reading the mirror. List whole, no banner.
 *
 * Time. Steps 3 and 5 claim things about ten and thirty minutes, so the scenario runs on a
 * world clock (`harness/world-clock.ts`) that both servers read and the page is told —
 * `Date.now` and `performance.now` jump together, timers do not. Every wait is still a
 * polled condition with a deadline derived from the client's own constants; nothing
 * sleeps for a duration and hopes.
 *
 * Load. Each derived bound is what the client needs on an idle host; every deadline is
 * that bound times `LOAD_MARGIN` (`harness/load-margin.ts`), because on a loaded host the page's timers, the CDP
 * round trips and the harness servers all run late, in real time, while the client's
 * behaviour stays the same. A deadline is only how long to wait before calling it broken;
 * what the client did is asserted from the request logs, which load does not change —
 * e.g. the flip to the mirror is checked by *how many* failed polls preceded it, not by
 * how many seconds it took.
 */

import { fileURLToPath } from 'node:url';

import { SNAPSHOT_PUSH_WARN_SECONDS } from '@fire-watch/contracts';
import type { Browser, Page } from 'puppeteer-core';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { DEFAULT_CONFIG } from '../src/core/config.js';
import { STATIC_FLIP_SPAN_INTERVALS, STATIC_FLIP_STREAK } from '../src/core/feed/supervisor.js';
import en from '../src/core/i18n/en.js';
import { LOCALE_STORAGE_KEY } from '../src/core/i18n/locale.js';
import { DEFAULT_AGE_WINDOW, ageWindowHours } from '../src/core/time/age-filter.js';
import { eventPath } from '../src/ui/logic/event-resolution.js';
import { ONBOARDING_DONE_VALUE, ONBOARDING_STORAGE_KEY } from '../src/ui/logic/onboarding.js';
import { DEFAULT_NOW_TICK_MS } from '../src/ui/use-now.js';
import { launchBrowser } from './harness/browser.js';
import { loadFixtureSnapshot, observedWithin } from './harness/fixture.js';
import type { WireSnapshot } from './harness/fixture.js';
import { within } from './harness/load-margin.js';
import {
  MIRROR_CACHE_CONTROL,
  MIRROR_META_GENERATED_AT_HEADER,
  MIRROR_OBJECT_KEY,
  startMirror,
} from './harness/mirror.js';
import type { HarnessMirror, MirrorRequest } from './harness/mirror.js';
import { CURSOR_QUERY_PARAM, HARNESS_POLL_INTERVAL_MS, startOrigin } from './harness/origin.js';
import type { HarnessOrigin, LoggedRequest } from './harness/origin.js';
import { openInstrumentedPage, until } from './harness/page.js';
import type { InstrumentedPage } from './harness/page.js';
import { createWorldClock } from './harness/world-clock.js';
import type { WorldClock } from './harness/world-clock.js';

const DIST_DIR = fileURLToPath(new URL('../dist/', import.meta.url));

const STORAGE: Readonly<Record<string, string>> = {
  [ONBOARDING_STORAGE_KEY]: ONBOARDING_DONE_VALUE,
  [LOCALE_STORAGE_KEY]: 'en',
};

const ROW_SELECTOR = '.home-list a.event-row';
const BANNER_SELECTOR = '.fw-banner[role="status"]';

const AGE_WINDOW_MS = (() => {
  const hours = ageWindowHours(DEFAULT_AGE_WINDOW);
  if (hours === null) throw new Error('e2e: the default age window must be bounded');
  return hours * 3_600_000;
})();

/**
 * The snapshot-age threshold of GLOSSARY §3b, as `ui/status/pick-banner.ts` derives it
 * (`SNAPSHOT_STALE_AFTER_MS`, module-private there): twice the push budget.
 */
const SNAPSHOT_STALE_AFTER_MS = 2 * SNAPSHOT_PUSH_WARN_SECONDS * 1_000;

/** Past a threshold by a clear minute, so no rounding can put a verdict on the fence. */
const PAST_THRESHOLD_MS = 60_000;

/** How long a cold load of the built app may take on an idle host. */
const BOOT_BOUND_MS = 15_000;

const JITTER_CEILING = 1.2;
/** Two polls at the worst jitter, plus the origin's one-second `Retry-After` hold. */
const NEXT_POLL_MS = Math.ceil(2 * HARNESS_POLL_INTERVAL_MS * JITTER_CEILING) + 1_000;
/** Same bound as CI-7 scenario 6: the next poll plus the backoff series of the streak. */
const STATIC_FLIP_BOUND_MS = Math.ceil(
  (1 + (2 ** STATIC_FLIP_STREAK - 1)) * HARNESS_POLL_INTERVAL_MS * JITTER_CEILING,
);
/**
 * The banner reads "now" from a ticking hook (`useNow`, `DEFAULT_NOW_TICK_MS`), so after
 * the clock jumps the verdict can wait for one tick; the tick is real time, not warped.
 */
const BANNER_BOUND_MS = DEFAULT_NOW_TICK_MS + NEXT_POLL_MS;

const EXPECTED_CONSOLE_ERRORS: readonly RegExp[] = [
  /Failed to load resource: net::ERR_BLOCKED_BY_CLIENT/,
  /Failed to fetch/,
  // The scripted outage: every refused API call during step 2–3 is one console line.
  /Failed to load resource: the server responded with a status of 503/,
];

let browser: Browser;
let fixture: WireSnapshot;
const cleanups: (() => Promise<void>)[] = [];

interface Session {
  readonly world: WorldClock;
  readonly origin: HarnessOrigin;
  readonly mirror: HarnessMirror;
  readonly page: InstrumentedPage;
  /** Jump scenario time forward — servers and page together. */
  advance(ms: number): Promise<void>;
}

async function bootSession(): Promise<Session> {
  const world = createWorldClock();
  const origin = await startOrigin({
    distDir: DIST_DIR,
    fixture,
    advertiseStaticCopy: false,
    staleByMs: 0,
    clock: world.now,
  });
  cleanups.push(() => origin.close());
  const mirror = await startMirror({ allowedOrigin: origin.baseUrl, clock: world.now });
  cleanups.push(() => mirror.close());
  origin.advertiseStaticSnapshotUrl(mirror.objectUrl);
  // The push job is alive: the mirror already holds the set the origin serves.
  mirror.push(origin.servedSnapshot(world.now()));

  const page = await openInstrumentedPage(browser, origin.baseUrl, STORAGE, {
    extraOrigins: [mirror.baseUrl],
    warpClock: true,
  });
  cleanups.push(() => page.close());
  await page.page.goto(origin.baseUrl + '/', { waitUntil: 'load', timeout: within(BOOT_BOUND_MS) });
  await page.page.waitForSelector(ROW_SELECTOR, { timeout: within(BOOT_BOUND_MS) });

  return {
    world,
    origin,
    mirror,
    page,
    advance: async (ms) => {
      world.advance(ms);
      await page.setClockOffset(world.offsetMs());
    },
  };
}

const snapshotRequests = (origin: HarnessOrigin): LoggedRequest[] =>
  origin.requests.filter((request) => request.path === DEFAULT_CONFIG.snapshotUrl);

const isCursor = (request: LoggedRequest): boolean =>
  request.query[CURSOR_QUERY_PARAM] !== undefined;

const isHealthy = (request: LoggedRequest): boolean =>
  request.status === 200 || request.status === 304;

const mirrorReads = (mirror: HarnessMirror): MirrorRequest[] =>
  mirror.requests.filter(
    (request) => request.method === 'GET' && request.path === `/${MIRROR_OBJECT_KEY}`,
  );

const rowHrefs = async (page: Page): Promise<string[]> => {
  const hrefs = await page.$$eval(ROW_SELECTOR, (rows) =>
    rows.map((row) => row.getAttribute('href') ?? ''),
  );
  return hrefs.sort();
};

/**
 * How many rows the list says it is leaving out of the current map view, read from its
 * own "N more fires outside the current view" note (0 when there is no such note).
 */
const outsideViewCount = async (page: Page): Promise<number> => {
  const notes = await page.$$eval('.list-scope-note span', (spans) =>
    spans.map((span) => (span.textContent ?? '').trim()),
  );
  for (const note of notes) {
    for (let count = 1; count <= 1_000; count += 1) {
      if (note === en.listInView.outsideView(count)) return count;
    }
  }
  return 0;
};

/**
 * Whether every in-window event is either listed or counted out loud. The list is
 * in-view-only by default, and whether the map has published a frame yet (and which one)
 * is the map's business, not this demo's — the harness blocks the basemap, yet MapLibre
 * may still settle a frame, notably once the page clock jumps. The claim here is the
 * list's own rule (`ui/event-list.tsx`): it may narrow to the view, never silently shrink.
 * So: the rows shown are all expected ones, and shown + counted-outside is all of them.
 */
const wholeWindowAccounted = async (page: Page, expected: readonly string[]): Promise<boolean> => {
  const hrefs = await rowHrefs(page);
  const outside = await outsideViewCount(page);
  return (
    hrefs.length > 0 &&
    hrefs.every((href) => expected.includes(href)) &&
    new Set(hrefs).size === hrefs.length &&
    hrefs.length + outside === expected.length
  );
};

const hasBanner = (page: Page): Promise<boolean> =>
  page.evaluate((target: string) => document.querySelector(target) !== null, BANNER_SELECTOR);

const bannerText = async (page: Page): Promise<string> =>
  (await page.$eval(BANNER_SELECTOR, (banner) => banner.textContent ?? '')).trim();

/** `HH:MM` in Europe/Sofia, read independently of the app's own formatter. */
const SOFIA_HOUR_MINUTE = new Intl.DateTimeFormat('en-GB', {
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
  timeZone: 'Europe/Sofia',
});
const sofiaHourMinute = (iso: string): string => SOFIA_HOUR_MINUTE.format(new Date(iso));

beforeAll(async () => {
  fixture = await loadFixtureSnapshot();
  // The banner wait is a single long CDP evaluate; keep the protocol ceiling above it.
  browser = await launchBrowser({ longestPageWaitMs: within(BANNER_BOUND_MS) });
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

describe('E6 T2 failover demo', () => {
  it(
    'fails over to the mirror, banners its frozen age honestly, and returns to T1 after the hysteresis',
    {
      timeout: within(
        2 * BOOT_BOUND_MS + STATIC_FLIP_BOUND_MS + 2 * BANNER_BOUND_MS + 10 * NEXT_POLL_MS + 60_000,
      ),
    },
    async () => {
      const session = await bootSession();
      const { world, origin, mirror, page } = session;

      // ── 1. T1: cursor polls on the origin, the mirror advertised and untouched ──────
      const expected = observedWithin(
        origin.servedSnapshot(world.now()),
        world.now(),
        AGE_WINDOW_MS,
      )
        .map((id) => eventPath(id))
        .sort();
      expect(expected.length).toBeGreaterThan(0);
      await until(() => wholeWindowAccounted(page.page, expected), {
        timeoutMs: within(NEXT_POLL_MS),
        what: 'the in-window rows',
      });
      await until(() => snapshotRequests(origin).some(isCursor), {
        timeoutMs: within(NEXT_POLL_MS),
        what: 'a T1 cursor poll',
      });
      expect(mirror.requests).toEqual([]);

      // ── 2. The origin dies; the push job has just landed its last object ─────────────
      origin.setScenario('origin-dead');
      const killedAt = world.now();
      const lastPush = mirror.push(origin.servedSnapshot(world.now()));

      const firstRead = await until(
        () => mirrorReads(mirror).find((request) => request.status === 200) ?? null,
        { timeoutMs: within(STATIC_FLIP_BOUND_MS), what: 'the first read of the mirror' },
      );
      // The A1.2 flip rule as seen from the origin: a streak of failures spanning the
      // required intervals, and not one mirror read before it was met.
      const failures = snapshotRequests(origin).filter(
        (request) => request.status === 503 && request.at >= killedAt && request.at <= firstRead.at,
      );
      expect(failures.length).toBeGreaterThanOrEqual(STATIC_FLIP_STREAK);
      // And not a streak longer than it needed: the client flipped on the poll that met the
      // rule, not some polls later. One spare for a poll already in flight when the origin
      // died. This is the timeliness claim, counted in the client's own attempts, so a
      // loaded host that stretches the seconds cannot fake or break it.
      expect(failures.length).toBeLessThanOrEqual(STATIC_FLIP_STREAK + 1);
      const lastFailure = failures[failures.length - 1];
      const firstFailure = failures[0];
      if (lastFailure === undefined || firstFailure === undefined) throw new Error('unreachable');
      expect(lastFailure.at - firstFailure.at).toBeGreaterThanOrEqual(
        STATIC_FLIP_SPAN_INTERVALS * HARNESS_POLL_INTERVAL_MS - 1_000,
      );
      // The first read had no tag to send, so it was a simple request, never preflighted.
      expect(firstRead.conditional).toBe(false);

      // Then it revalidates on the bucket's tag. That needs the tag to be readable
      // cross-origin (`Access-Control-Expose-Headers: ETag`) and `If-None-Match` to pass a
      // preflight — the bucket CORS policy is part of what this demo proves.
      const revalidated = await until(
        () =>
          mirrorReads(mirror).find(
            (request) => request.status === 304 && request.conditional && request.at > firstRead.at,
          ) ?? null,
        { timeoutMs: within(NEXT_POLL_MS), what: 'a conditional 304 from the mirror' },
      );
      expect(
        mirror.requests.some(
          (request) =>
            request.method === 'OPTIONS' &&
            request.status === 204 &&
            request.at >= firstRead.at &&
            request.at <= revalidated.at,
        ),
      ).toBe(true);
      // While on T2 the client keeps probing the origin with whole-set requests.
      await until(
        () =>
          snapshotRequests(origin).some(
            (request) => request.at > firstRead.at && !isCursor(request) && request.status === 503,
          ),
        { timeoutMs: within(NEXT_POLL_MS), what: 'an origin probe from T2' },
      );
      // The mirror is live, so there is nothing to tell the reader (ADR-003 D2).
      expect(await wholeWindowAccounted(page.page, expected)).toBe(true);
      expect(await hasBanner(page.page)).toBe(false);

      // ── 3. The push job is dead too, and eleven minutes pass ─────────────────────────
      // Nothing is pushed from here on: the object on the mirror is `lastPush`, frozen.
      await session.advance(SNAPSHOT_STALE_AFTER_MS + PAST_THRESHOLD_MS);
      const staleFrom = world.now();
      await page.page.waitForSelector(BANNER_SELECTOR, { timeout: within(BANNER_BOUND_MS) });
      // The stamp is the claim: the instant the mirror's document was generated, not the
      // mirror's `Date`, not "now".
      const stoppedAt = sofiaHourMinute(lastPush.generatedAt);
      expect(await bannerText(page.page)).toContain(stoppedAt);
      expect(mirror.current()?.generatedAt).toBe(lastPush.generatedAt);

      // The F4 regression: the mirror keeps answering 304 with an advancing `Date`, and
      // that must never re-anchor the staleness clock. Two more revalidations later the
      // banner is still up with the same stamp.
      await until(
        () =>
          mirrorReads(mirror).filter((request) => request.status === 304 && request.at >= staleFrom)
            .length >= 2,
        { timeoutMs: within(2 * NEXT_POLL_MS), what: 'two mirror revalidations after the jump' },
      );
      expect(await bannerText(page.page)).toContain(stoppedAt);
      expect(await wholeWindowAccounted(page.page, expected)).toBe(true);

      // ── 4. The origin returns: the banner clears, the tier does not flip yet ─────────
      origin.setScenario('fresh');
      const returnedAt = world.now();
      const firstHealthy = await until(
        () =>
          snapshotRequests(origin).find(
            (request) => request.at >= returnedAt && isHealthy(request),
          ) ?? null,
        { timeoutMs: within(NEXT_POLL_MS), what: 'a healthy origin probe' },
      );
      expect(isCursor(firstHealthy)).toBe(false);
      await until(async () => !(await hasBanner(page.page)), {
        timeoutMs: within(NEXT_POLL_MS),
        what: 'the banner to clear once the origin vouches for the set',
      });
      // Healthy is not enough: another mirror read and another healthy probe later, the
      // client is still on T2 — no cursor poll has gone to the origin.
      await until(
        () => {
          const read = mirrorReads(mirror).find((request) => request.at > firstHealthy.at);
          if (read === undefined) return false;
          return snapshotRequests(origin).some(
            (request) => request.at > read.at && isHealthy(request),
          );
        },
        { timeoutMs: within(2 * NEXT_POLL_MS), what: 'a mirror read and a second healthy probe' },
      );
      expect(snapshotRequests(origin).filter((r) => r.at >= returnedAt && isCursor(r))).toEqual([]);

      // ── 5. Thirty healthy minutes later, back on T1 ──────────────────────────────────
      await session.advance(DEFAULT_CONFIG.sseReofferHysteresisMs + PAST_THRESHOLD_MS);
      const hysteresisFrom = world.now();
      const backOnT1 = await until(
        () =>
          snapshotRequests(origin).find(
            (request) => request.at >= hysteresisFrom && isCursor(request) && isHealthy(request),
          ) ?? null,
        { timeoutMs: within(2 * NEXT_POLL_MS), what: 'a T1 cursor poll after the hysteresis' },
      );
      // Two more T1 polls, and not one mirror read since the first of them.
      await until(
        () =>
          snapshotRequests(origin).filter(
            (request) => request.at > backOnT1.at && isCursor(request),
          ).length >= 2,
        { timeoutMs: within(2 * NEXT_POLL_MS), what: 'two further T1 cursor polls' },
      );
      expect(mirrorReads(mirror).filter((request) => request.at > backOnT1.at)).toEqual([]);

      expect(await wholeWindowAccounted(page.page, expected)).toBe(true);
      expect(await hasBanner(page.page)).toBe(false);
      expect(origin.requests.filter((r) => r.path === DEFAULT_CONFIG.streamUrl)).toEqual([]);
      expect(await page.eventSourceCount()).toBe(0);
      expect(page.pageErrors).toEqual([]);
      expect(
        page.consoleErrors.filter((text) => !EXPECTED_CONSOLE_ERRORS.some((re) => re.test(text))),
      ).toEqual([]);
    },
  );

  it('serves the mirror object exactly as E3 plans it', async () => {
    const world = createWorldClock();
    const mirror = await startMirror({ allowedOrigin: 'http://app.invalid', clock: world.now });
    cleanups.push(() => mirror.close());
    const document = fixture;
    const stored = mirror.push(document);

    const first = await fetch(mirror.objectUrl, { headers: { origin: 'http://app.invalid' } });
    expect(first.status).toBe(200);
    // Byte for byte the document the API serves: `JSON.stringify(document)`.
    expect(await first.text()).toBe(JSON.stringify(document));
    expect(first.headers.get('cache-control')).toBe(MIRROR_CACHE_CONTROL);
    expect(first.headers.get(MIRROR_META_GENERATED_AT_HEADER)).toBe(document.generated_at);
    expect(first.headers.get('etag')).toBe(stored.etag);
    expect(first.headers.get('access-control-expose-headers')).toMatch(/ETag/);

    const again = await fetch(mirror.objectUrl, {
      headers: { origin: 'http://app.invalid', 'if-none-match': stored.etag },
    });
    expect(again.status).toBe(304);

    expect(() => mirror.push({ ...document, partial: true })).toThrow(RangeError);
  });
});
