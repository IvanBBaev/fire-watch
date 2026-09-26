/**
 * CI-18 — the three layout accessibility floors, measured in a real browser, plus the
 * list view's reachability without the map.
 *
 * `docs/IMPLEMENTATION-PLAN.md` (WP4) states the criteria as testable and this file is
 * where they are tested: **200 % font-scale reflow with no horizontal scrolling; 44 px
 * minimum touch targets; 16 px body-text floor** (TASKS F7, GATES CI-18). Nothing here is
 * asserted from the stylesheet: every number is read back from the layout engine after the
 * shipped bundle has rendered, because a floor written in CSS and lost to a cascade, an
 * override or a wrapper that does not stretch is a floor the reader never gets. Two of the
 * defects this suite found on its first run were exactly that (`.back-link` declared and
 * never applied; `.button-secondary` never declared at all).
 *
 * **Each criterion is read in the sense that matters to a reader, not the sense that is
 * easiest to assert.** "No horizontal scrolling" is both `document.scrollWidth` and the
 * position of every control: an ancestor with `overflow: hidden` absorbs the overflow, so
 * a control can sit at x = -216 in a 360 px viewport while the document measures clean.
 * "44 px target" is both the box and a hit test at its centre: a 44 px box under the
 * bottom sheet's handle is not a target, and the reader who presses it gets the handle.
 * Both readings are there because both defects were real in this build at a 200 % font
 * size — the measurements are in the F7 report.
 *
 * **Four legs**, each one a viewport the corpus names, and each one there for a reason a
 * single leg cannot cover:
 *
 *   * **320 × 512** is WCAG 1.4.10 Reflow's literal requirement — the width at which a
 *     320 CSS-px viewport must present without two-dimensional scrolling. It runs in
 *     Bulgarian, the shipped default and the longer copy: the narrowest viewport meets the
 *     widest words.
 *   * **360 × 640** is review 06 §5.4's budget Android — the primary rural user's phone.
 *     The target and text floors are asserted at the size that reader actually holds.
 *   * **360 × 640 at a 32 px root font** is WCAG 1.4.4 Resize Text and review 19
 *     Appendix B step 7. Because the app declares no `html { font-size }` of its own, a
 *     32 px root is exactly what a browser whose default font size has been doubled
 *     produces, and the floors scale with it: at 200 % the 16 px floor is a 32 px floor.
 *     That is the leg that catches text sized in `px` instead of `rem` — text that does
 *     not grow is text the criterion fails, even though it never dips below 16 px.
 *   * **1280 × 800** is the only leg above `@media (min-width: 48rem)`, where the panel
 *     stops being a sheet over the map and becomes a column beside it. That is a different
 *     layout, not a wider one: different boxes, a different scroll container and a
 *     different set of visible controls, so three narrow legs say nothing about it. It is
 *     also the layout the rest of the e2e suite runs in (an 800 px browser), which makes
 *     it the one every other gate silently depends on.
 *
 * **What this file does not cover, and why.** Review 19 §5.8.1 is explicit that *OS font
 * scale is not browser zoom*: an Android OEM skin scales beyond 200 %, reflows on its own
 * rules, and cannot be reproduced by a root font-size in headless Chrome. Chrome exposes no
 * OS-font-scale emulation, so faking one here would be a green check standing in for an
 * untested claim. That leg, the assistive-technology pass and the full keyboard order are
 * the documented manual protocol in `docs/GATES.md` §1.2, which cites review 19 Appendix B.
 *
 * **Scope.** The sweep skips everything inside `.map-pane`. Review 19 Appendix A puts the
 * WebGL map canvas in the *exempt-with-alternative* class — its obligation is information
 * parity with the DOM twin (the proposed parity gate), not a 44 px hit box on MapLibre's
 * own attribution chrome, which is third-party DOM this repository does not author. Our own
 * controls sit outside `.map-pane` and stay in scope.
 *
 * **The list without the map** is already proven by CI-7: `polling-only.e2e.ts`'s
 * `'serves a browser that refuses the map a WebGL context'` boots with `denyWebGl: true`,
 * waits for rows, and clicks through to an event page. That is not repeated here. What it
 * does not cover is *keyboard* reachability, so that is what the last scenario adds: in a
 * browser with no WebGL, Tab alone reaches the first row, the focus ring is visible on it,
 * and Enter opens the event.
 */

import { fileURLToPath } from 'node:url';

import type { Browser, Page } from 'puppeteer-core';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { LOCALE_STORAGE_KEY } from '../src/core/i18n/locale.js';
import type { Locale } from '../src/core/types.js';
import { eventPath } from '../src/ui/logic/event-resolution.js';
import { ONBOARDING_DONE_VALUE, ONBOARDING_STORAGE_KEY } from '../src/ui/logic/onboarding.js';
import type { AppRoute, RouteId } from '../src/ui/logic/routes.js';
import { ROUTES } from '../src/ui/logic/routes.js';
import { launchBrowser } from './harness/browser.js';
import { loadFixtureSnapshot } from './harness/fixture.js';
import type { WireSnapshot } from './harness/fixture.js';
import { startOrigin } from './harness/origin.js';
import type { HarnessOrigin } from './harness/origin.js';
import { openInstrumentedPage } from './harness/page.js';
import type { InstrumentedPage } from './harness/page.js';

const DIST_DIR = fileURLToPath(new URL('../dist/', import.meta.url));

/** The floors, in CSS px at a 16 px root. Both are corpus commitments, not WCAG minima. */
const TARGET_FLOOR_PX = 44;
const TEXT_FLOOR_PX = 16;

/**
 * Sub-pixel layout is real: a 44 px `min-height` can measure 43.99 after a border and a
 * fractional line box. A tolerance smaller than one device pixel keeps that from being a
 * finding while staying far below anything a reader could feel.
 */
const EPSILON_PX = 0.5;

/** Everything MapLibre owns — review 19 Appendix A, "WebGL map canvas: exempt". */
const MAP_CANVAS_SCOPE = '.map-pane';

/** Old enough that the degradation banner is up; the banner is an in-scope surface. */
const STALE_BY_MS = 90 * 60_000;

/** The fixture event `polling-only.e2e.ts` also navigates to. */
const EVENT_ID = 'fw-2026-q7f3d';

/** Well-formed and absent from the fixture, so the not-found branch renders. */
const MISSING_EVENT_ID = 'fw-2026-zzzz9';

/** Far outside the coverage box, so "My location" answers with a status, deterministically. */
const OUTSIDE_COVERAGE = { latitude: 0, longitude: 0 };

const ROW_SELECTOR = '.home-list a.event-row';
const PANEL_TOGGLE_SELECTOR = '.panel-toggle';
const BANNER_SELECTOR = '.fw-banner[role="status"]';
const EVENT_PAGE_SELECTOR = 'article.page.event-page';
const CHIP_SELECTOR = '.fw-chip';
const STATUS_SELECTOR = '.map-controls-status';
const ONBOARDING_SELECTOR = '.onboarding-overlay';

interface Leg {
  readonly name: string;
  readonly width: number;
  readonly height: number;
  /** A root font size to impose, or `null` for the browser's own default. */
  readonly rootFontPx: number | null;
  /** The body-text floor this leg asserts — the 16 px floor, scaled with the root. */
  readonly textFloorPx: number;
  readonly locale: Locale;
}

const LEGS: readonly Leg[] = [
  {
    name: 'WCAG 1.4.10 reflow — 320 CSS px, Bulgarian',
    width: 320,
    height: 512,
    rootFontPx: null,
    textFloorPx: TEXT_FLOOR_PX,
    locale: 'bg',
  },
  {
    name: 'budget Android (06 §5.4) — 360 × 640, English',
    width: 360,
    height: 640,
    rootFontPx: null,
    textFloorPx: TEXT_FLOOR_PX,
    locale: 'en',
  },
  {
    name: 'WCAG 1.4.4 resize text — 360 × 640 at a 200 % root font, Bulgarian',
    width: 360,
    height: 640,
    rootFontPx: 2 * TEXT_FLOOR_PX,
    textFloorPx: 2 * TEXT_FLOOR_PX,
    locale: 'bg',
  },
  {
    name: 'wide two-column layout — 1280 × 800, Bulgarian',
    width: 1280,
    height: 800,
    rootFontPx: null,
    textFloorPx: TEXT_FLOOR_PX,
    locale: 'bg',
  },
];

/** A check this suite names, so a failure says which of F7's floors gave way. */
const CHECKS = ['reflow', 'target-size', 'text-floor', 'clipping'] as const;
type Check = (typeof CHECKS)[number];

interface Violation {
  readonly check: Check;
  /** The surface it was measured on, so the failure is reproducible by hand. */
  readonly surface: string;
  /** The element, named the way a developer greps for it. */
  readonly what: string;
  /** Measured against required, in CSS px. */
  readonly detail: string;
}

let browser: Browser;
let fixture: WireSnapshot;
const cleanups: (() => Promise<void>)[] = [];

interface Booted {
  readonly origin: HarnessOrigin;
  readonly page: InstrumentedPage;
}

interface BootOptions {
  readonly leg: Leg;
  /** Leave the onboarding marker unset, so the first-launch overlay is the surface. */
  readonly showOnboarding?: boolean;
  readonly denyWebGl?: boolean;
}

async function boot(options: BootOptions): Promise<Booted> {
  const { leg } = options;
  const origin = await startOrigin({
    distDir: DIST_DIR,
    fixture,
    advertiseStaticCopy: false,
    staleByMs: STALE_BY_MS,
  });
  cleanups.push(() => origin.close());
  origin.setScenario('fresh');

  const storage: Record<string, string> = { [LOCALE_STORAGE_KEY]: leg.locale };
  if (options.showOnboarding !== true) storage[ONBOARDING_STORAGE_KEY] = ONBOARDING_DONE_VALUE;

  const page = await openInstrumentedPage(browser, origin.baseUrl, storage, {
    denyWebGl: options.denyWebGl ?? false,
  });
  cleanups.push(() => page.close());
  await page.page.setViewport({ width: leg.width, height: leg.height, deviceScaleFactor: 1 });

  if (leg.rootFontPx !== null) {
    // The app sets no `html { font-size }`, so a root font size imposed here is exactly
    // what a browser whose default font size was changed would hand the same stylesheet.
    // It is injected on every new document rather than after load, so nothing is ever
    // measured against a layout that has not seen it. The one thing it does not reproduce
    // is media queries: `@media (min-width: 48rem)` resolves `rem` against the initial
    // font size, which a real browser setting also changes and this does not. It only
    // matters at 48rem, and every leg here is far narrower than either reading of it.
    await page.page.evaluateOnNewDocument((px: number) => {
      const apply = (): void => {
        const style = document.createElement('style');
        style.textContent = `:root { font-size: ${String(px)}px; }`;
        document.head.append(style);
      };
      if (document.head as HTMLHeadElement | null) apply();
      else document.addEventListener('DOMContentLoaded', apply, { once: true });
    }, leg.rootFontPx);
  }

  return { origin, page };
}

/**
 * Every measurement this suite makes, taken in one pass in the page.
 *
 * It runs in the browser, so it is written against the DOM and cannot close over anything
 * here: the two selectors it needs are arguments. It reports *measurements*, not verdicts —
 * the thresholds stay on this side, next to the review that sets them.
 */
interface Measurements {
  readonly docScrollWidth: number;
  readonly docClientWidth: number;
  readonly targets: readonly { readonly what: string; readonly w: number; readonly h: number }[];
  readonly texts: readonly { readonly what: string; readonly px: number }[];
  readonly clipped: readonly { readonly what: string; readonly detail: string }[];
  readonly offscreen: readonly { readonly what: string; readonly detail: string }[];
  readonly obscured: readonly { readonly what: string; readonly detail: string }[];
}

const measure = (page: Page, exempt: string): Promise<Measurements> =>
  page.evaluate((exemptSelector: string): Measurements => {
    const describe = (el: Element): string => {
      const id = el.id === '' ? '' : `#${el.id}`;
      const cls = el.getAttribute('class');
      const classes =
        cls === null || cls.trim() === '' ? '' : `.${cls.trim().split(/\s+/).join('.')}`;
      const text = (el.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 40);
      const name = `${el.tagName.toLowerCase()}${id}${classes}`;
      return text === '' ? name : `${name} "${text}"`;
    };

    /** Out of scope, or not rendered at all: either way, nothing a reader can reach. */
    const skip = (el: Element): boolean => {
      if (el.closest(exemptSelector) !== null) return true;
      if (el.closest('[hidden], [aria-hidden="true"]') !== null) return true;
      const style = window.getComputedStyle(el);
      return style.display === 'none' || style.visibility === 'hidden';
    };

    const INTERACTIVE = [
      'a[href]',
      'button',
      'input:not([type="hidden"])',
      'select',
      'textarea',
      'summary',
      '[role="button"]',
      '[role="link"]',
      '[tabindex]:not([tabindex="-1"])',
    ].join(', ');

    const EPS = 0.5;
    const px = (value: number): string => String(Math.round(value * 100) / 100);
    const root = document.documentElement;
    const viewWidth = root.clientWidth;
    const viewHeight = root.clientHeight;

    /** True when some ancestor is a legitimate horizontal scroller. */
    const scrollsX = (el: Element): boolean => {
      for (let node: Element | null = el; node !== null; node = node.parentElement) {
        const overflow = window.getComputedStyle(node).overflowX;
        if (overflow === 'auto' || overflow === 'scroll') return true;
      }
      return false;
    };

    // A control the design deliberately stacks something over is not a defect: the
    // first-launch dialog covers the list on purpose, and so does the bottom sheet once
    // the reader has pulled it up. Anything else on top of a control is an accident —
    // and an accident is exactly how a wrapped header pushed the map controls under the
    // sheet's handle at a 200 % font size.
    const modal = document.querySelector('[aria-modal="true"]');
    const openSheet = document.querySelector('.side-panel.open');
    const intentionalCover = (target: Element, cover: Element): boolean => {
      if (modal !== null && modal.contains(cover) && !modal.contains(target)) return true;
      return openSheet !== null && openSheet.contains(cover) && !openSheet.contains(target);
    };

    const targets: { what: string; w: number; h: number }[] = [];
    const offscreen: { what: string; detail: string }[] = [];
    const obscured: { what: string; detail: string }[] = [];
    for (const el of Array.from(document.querySelectorAll(INTERACTIVE))) {
      if (skip(el)) continue;
      // A control wrapped in its own `<label>` is hit anywhere on the label, so the label
      // is the target — a 20 px radio inside a 44 px row is not a 20 px target.
      const label = el.closest('label');
      const hit = label ?? el;
      const box = hit.getBoundingClientRect();
      // A zero box is a control the layout gave no space; `skip` already removed the ones
      // that are not rendered, and a genuinely collapsed control is a different bug.
      if (box.width === 0 && box.height === 0) continue;
      targets.push({ what: describe(el), w: box.width, h: box.height });

      // Horizontal containment. The document-level reflow assertion cannot see this: an
      // ancestor with `overflow: hidden` absorbs the overflow, so `scrollWidth` stays
      // clean while the control itself sits outside the viewport, unreachable and
      // unscrollable-to. That is precisely what happened to the "Balkans" map control at
      // a 200 % font size (measured at left -216 in a 360 px viewport).
      if (!scrollsX(hit) && (box.left < -EPS || box.right > viewWidth + EPS)) {
        offscreen.push({
          what: describe(el),
          detail: `left ${px(box.left)} … right ${px(box.right)} is outside 0 … ${String(viewWidth)}`,
        });
      }

      // Hit-testing, not geometry: a 44 px box under something else is not a 44 px target
      // (WCAG 2.5.8's "not obscured" sense). Only the centre is tested, and only when the
      // centre is on screen — a control below the fold is reachable by scrolling.
      const cx = box.left + box.width / 2;
      const cy = box.top + box.height / 2;
      if (cx < 0 || cy < 0 || cx > viewWidth || cy > viewHeight) continue;
      const atPoint = document.elementFromPoint(cx, cy);
      if (atPoint === null) continue;
      if (hit.contains(atPoint) || atPoint.contains(hit)) continue;
      if (intentionalCover(hit, atPoint)) continue;
      obscured.push({
        what: describe(el),
        detail: `its centre (${px(cx)}, ${px(cy)}) hits ${describe(atPoint)}`,
      });
    }

    const texts: { what: string; px: number }[] = [];
    const clipped: { what: string; detail: string }[] = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const seen = new Set<Element>();
    for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
      if ((node.nodeValue ?? '').trim() === '') continue;
      const el = node.parentElement;
      if (el === null || seen.has(el)) continue;
      seen.add(el);
      if (skip(el)) continue;
      const style = window.getComputedStyle(el);
      texts.push({ what: describe(el), px: Number.parseFloat(style.fontSize) });

      // Clipping is asserted on the boxes that *hold text*, not on every box that hides
      // overflow: the collapsed bottom sheet is deliberately translated out of the map
      // frame and reached by its handle, and calling that clipped would be calling the
      // design a defect. A text box whose own overflow is hidden and whose content does
      // not fit is a line the reader cannot finish.
      const hides = (value: string): boolean => value === 'hidden' || value === 'clip';
      if (hides(style.overflowX) && el.scrollWidth > el.clientWidth + 1) {
        clipped.push({
          what: describe(el),
          detail: `scrollWidth ${el.scrollWidth} > clientWidth ${el.clientWidth}`,
        });
      }
      if (hides(style.overflowY) && el.scrollHeight > el.clientHeight + 1) {
        clipped.push({
          what: describe(el),
          detail: `scrollHeight ${el.scrollHeight} > clientHeight ${el.clientHeight}`,
        });
      }
    }

    return {
      docScrollWidth: root.scrollWidth,
      docClientWidth: root.clientWidth,
      targets,
      texts,
      clipped,
      offscreen,
      obscured,
    };
  }, exempt);

/** Turn one surface's measurements into whatever it violates. */
function violations(surface: string, leg: Leg, m: Measurements): Violation[] {
  const found: Violation[] = [];
  const round = (value: number): string => String(Math.round(value * 100) / 100);

  if (m.docScrollWidth > m.docClientWidth + EPSILON_PX) {
    found.push({
      check: 'reflow',
      surface,
      what: 'document',
      detail: `scrollWidth ${m.docScrollWidth} > clientWidth ${m.docClientWidth} — the page scrolls sideways`,
    });
  }

  for (const off of m.offscreen) {
    found.push({ check: 'reflow', surface, what: off.what, detail: off.detail });
  }

  for (const target of m.targets) {
    if (target.w + EPSILON_PX >= TARGET_FLOOR_PX && target.h + EPSILON_PX >= TARGET_FLOOR_PX) {
      continue;
    }
    found.push({
      check: 'target-size',
      surface,
      what: target.what,
      detail: `${round(target.w)} × ${round(target.h)} < ${TARGET_FLOOR_PX} × ${TARGET_FLOOR_PX}`,
    });
  }

  for (const covered of m.obscured) {
    found.push({ check: 'target-size', surface, what: covered.what, detail: covered.detail });
  }

  for (const text of m.texts) {
    if (text.px + EPSILON_PX >= leg.textFloorPx) continue;
    found.push({
      check: 'text-floor',
      surface,
      what: text.what,
      detail: `${round(text.px)} px < ${leg.textFloorPx} px`,
    });
  }

  for (const clip of m.clipped) {
    found.push({ check: 'clipping', surface, what: clip.what, detail: clip.detail });
  }

  return found;
}

/** Wait for the layout to settle, then measure it. */
async function sweep(surface: string, leg: Leg, page: Page): Promise<Violation[]> {
  // Fonts are the system stack (CI-12), so nothing is downloaded, but a route change still
  // takes a frame or two to lay out. Two animation frames is the shortest honest wait.
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            resolve();
          });
        });
      }),
  );
  return violations(surface, leg, await measure(page, MAP_CANVAS_SCOPE));
}

const byCheck = (found: readonly Violation[], check: Check): string[] =>
  found
    .filter((violation) => violation.check === check)
    .map((violation) => `[${violation.surface}] ${violation.what} — ${violation.detail}`);

const has = (page: Page, selector: string): Promise<boolean> =>
  page.evaluate((target: string) => document.querySelector(target) !== null, selector);

/**
 * Present *and* rendered. Above `@media (min-width: 48rem)` the sheet handle is still in
 * the DOM but `display: none`, and clicking a box with no box is a timeout, not a test.
 */
const isVisible = (page: Page, selector: string): Promise<boolean> =>
  page.evaluate((target: string) => {
    const el = document.querySelector(target);
    if (el === null) return false;
    const box = el.getBoundingClientRect();
    return box.width > 0 && box.height > 0;
  }, selector);

beforeAll(async () => {
  fixture = await loadFixtureSnapshot();
  browser = await launchBrowser();
}, 120_000);

afterAll(async () => {
  await browser.close();
});

afterEach(async () => {
  while (cleanups.length > 0) {
    const cleanup = cleanups.pop();
    if (cleanup !== undefined) await cleanup();
  }
});

/**
 * How this sweep knows a route has finished rendering — one selector per route, exhaustive
 * over `RouteId`.
 *
 * This is the half of the gate that used to be a hand-written list. A route added to
 * `ui/logic/routes.ts` and forgotten here would not have failed anything: the sweep would
 * simply have stopped covering the newest surface while staying green, which is the worst
 * shape a gate can fail in. Now it is a compile error in this file until someone says what
 * "rendered" looks like on the new page.
 */
const READY_SELECTOR: Record<RouteId, string> = {
  home: ROW_SELECTOR,
  event: EVENT_PAGE_SELECTOR,
  settings: '.settings-group',
  about: '#data-freshness',
  credits: '.credits-list',
  privacy: '#disclaimer',
  // TASKS I1. The harness origin serves no auth routes, so both pages settle on their
  // neutral "not available" line — the state a deployment with auth off shows.
  signIn: '.auth-page[data-ready]',
  signInContinue: '.auth-page[data-ready]',
};

/** One URL the sweep visits, under the name its findings are reported against. */
interface Visit {
  readonly name: string;
  readonly path: string;
}

/**
 * The URLs each route is swept at, and what to call them.
 *
 * A static path is swept at itself, taken from the route table rather than written out a
 * second time. `/event/:id` is a pattern and not a URL, so it names the two ids this suite
 * has always swept: one the fixture contains and one it does not, which renders the
 * not-found branch on the same route. Exhaustive over `RouteId` as well, so a
 * parameterised route cannot be added to the table and then swept at a literal `:param`.
 */
const SWEEP_VISITS: Record<RouteId, (route: AppRoute) => readonly Visit[]> = {
  home: (route) => [{ name: 'home list', path: route.path }],
  event: () => [
    { name: 'event page', path: eventPath(EVENT_ID) },
    { name: 'event not found', path: eventPath(MISSING_EVENT_ID) },
  ],
  settings: (route) => [{ name: 'settings', path: route.path }],
  about: (route) => [{ name: 'about', path: route.path }],
  credits: (route) => [{ name: 'credits', path: route.path }],
  privacy: (route) => [{ name: 'privacy', path: route.path }],
  signIn: (route) => [{ name: 'sign in', path: route.path }],
  signInContinue: (route) => [{ name: 'sign-in landing', path: route.path }],
};

/**
 * Every in-scope surface of review 19 Appendix A that this build can reach without an
 * account: the list, an event, the not-found branch that shares its route, and the four
 * static pages — in the route table's own order. The states that are not routes — the
 * degradation banner, the location status line, the first-launch overlay, the no-map
 * layout — are visited below.
 */
const ROUTE_SURFACES: readonly (Visit & { readonly ready: string })[] = ROUTES.flatMap((route) =>
  SWEEP_VISITS[route.id](route).map((visit) => ({ ...visit, ready: READY_SELECTOR[route.id] })),
);

describe.each(LEGS)('CI-18 layout floors — $name', (leg: Leg) => {
  it('holds the reflow, target-size and text floors on every in-scope surface', async () => {
    const found: Violation[] = [];

    // Every measurement is taken inside one `try`: a prerequisite that throws — a control
    // the layout put somewhere unclickable, a state that therefore never arrives — would
    // otherwise discard everything measured before it and report only a bare timeout. At a
    // 200 % font size the findings usually *are* the explanation for the step that failed.
    try {
      const { origin, page } = await boot({ leg });
      const tab = page.page;

      // The bottom sheet is closed on a narrow viewport, so the list — a peer surface, not a
      // fallback (IMPLEMENTATION-PLAN WP4) — is measured open, the way a reader reads it.
      for (const surface of ROUTE_SURFACES) {
        await tab.goto(origin.baseUrl + surface.path, { waitUntil: 'load' });
        await tab.waitForSelector(surface.ready, { timeout: 15_000 });
        if (await isVisible(tab, PANEL_TOGGLE_SELECTOR)) await tab.click(PANEL_TOGGLE_SELECTOR);
        found.push(...(await sweep(surface.name, leg, tab)));
      }

      // The freshness chip's help target and the event page's own chrome, with the panel open
      // over the map: the freshness line is the one line review 19 §5.8.1 says must never be
      // clipped, and this is the only surface that renders it.
      await tab.goto(origin.baseUrl + eventPath(EVENT_ID), { waitUntil: 'load' });
      await tab.waitForSelector(CHIP_SELECTOR, { timeout: 15_000 });
      expect(await has(tab, CHIP_SELECTOR)).toBe(true);
      found.push(...(await sweep('event page (freshness line)', leg, tab)));

      // The location status line only exists once the question has been asked and answered.
      // A coordinate outside the coverage box makes the answer deterministic.
      await tab.browserContext().overridePermissions(origin.baseUrl, ['geolocation']);
      await tab.setGeolocation(OUTSIDE_COVERAGE);
      await tab.goto(origin.baseUrl + '/', { waitUntil: 'load' });
      await tab.waitForSelector(ROW_SELECTOR, { timeout: 15_000 });
      const locateButton = (await tab.$$('.map-controls-buttons .map-control'))[1];
      if (locateButton === undefined) throw new Error('e2e: the "my location" control is missing');
      await locateButton.click();
      await tab.waitForFunction(
        (selector: string) => (document.querySelector(selector)?.textContent ?? '') !== '',
        { timeout: 15_000 },
        STATUS_SELECTOR,
      );
      found.push(...(await sweep('home list (location status)', leg, tab)));

      // The degradation banner, on the same page: an in-scope surface in Appendix A, and the
      // widest single line the shell ever renders above the fold.
      origin.setScenario('stale');
      await tab.goto(origin.baseUrl + '/', { waitUntil: 'load' });
      await tab.waitForSelector(BANNER_SELECTOR, { timeout: 15_000 });
      found.push(...(await sweep('home list (degradation banner)', leg, tab)));

      // First launch: three cards and one button over the list, in a document that was never
      // told onboarding was done.
      const first = await boot({ leg, showOnboarding: true });
      await first.page.page.goto(first.origin.baseUrl + '/', { waitUntil: 'load' });
      await first.page.page.waitForSelector(ONBOARDING_SELECTOR, { timeout: 15_000 });
      found.push(...(await sweep('first-launch onboarding', leg, first.page.page)));

      // The same floors in the browser CI-7 already proves the product serves: no WebGL, so
      // no map, and the list is the whole screen.
      const noMap = await boot({ leg, denyWebGl: true });
      await noMap.page.page.goto(noMap.origin.baseUrl + '/', { waitUntil: 'load' });
      await noMap.page.page.waitForSelector(ROW_SELECTOR, { timeout: 15_000 });
      found.push(...(await sweep('home list (no WebGL)', leg, noMap.page.page)));
    } catch (error) {
      const measured = CHECKS.map(
        (check) => `  ${check}: ${JSON.stringify(byCheck(found, check))}`,
      ).join('\n');
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`${message}\n\nmeasured before the failure:\n${measured}`, {
        cause: error,
      });
    }

    // One assertion with four named keys, not four assertions: four would stop at the
    // first floor that gave way and hide the rest, and an a11y run that reports one third
    // of the damage costs three runs to fix. The sweep is shared because booting a browser
    // per criterion would triple the gate's cost to say the same thing.
    expect({
      reflow: byCheck(found, 'reflow'),
      targetSize: byCheck(found, 'target-size'),
      textFloor: byCheck(found, 'text-floor'),
      clipping: byCheck(found, 'clipping'),
    }).toEqual({ reflow: [], targetSize: [], textFloor: [], clipping: [] });
  }, 180_000);
});

/**
 * CI-7 already proves a browser with no WebGL is served the list and can click through to
 * an event (`polling-only.e2e.ts`, "serves a browser that refuses the map a WebGL
 * context"). What it does not prove is that the list is reachable *without a pointer*, and
 * "reachable without the map" is F7's wording. Tab alone, from the top of the document.
 *
 * The bound is a number, not "eventually": a list that is thirty stops down the order is
 * reachable in the same sense that a fire is survivable. This build reaches the first row
 * on stop 15 with WebGL denied — five header links, MapLibre's canvas and its attribution
 * `<summary>` (third-party DOM inside the exempt pane, focusable even with no context),
 * two map controls, the sheet handle and the four age-window buttons. Twenty is that
 * measurement plus headroom for one more control; a surface that pushes the list past it
 * fails, and the failure prints the walk so the regression names itself.
 */
describe('CI-18 — the list view is reachable without the map', () => {
  const leg = LEGS[1];
  if (leg === undefined) throw new Error('e2e: no leg to run the keyboard walk on');

  it('reaches the first row by keyboard alone, with a visible focus ring', async () => {
    const { origin, page } = await boot({ leg, denyWebGl: true });
    const tab = page.page;
    await tab.goto(origin.baseUrl + '/', { waitUntil: 'load' });
    await tab.waitForSelector(ROW_SELECTOR, { timeout: 15_000 });

    // Start the order at the document, not at whatever the app happened to focus.
    await tab.evaluate(() => {
      if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    });

    const MAX_TABS = 20;
    const onFirstRow = (): Promise<boolean> =>
      tab.evaluate((selector: string) => {
        const first = document.querySelector(selector);
        return first !== null && document.activeElement === first;
      }, ROW_SELECTOR);

    const focused = (): Promise<string> =>
      tab.evaluate(() => {
        const active = document.activeElement;
        if (active === null) return 'nothing';
        const cls = (active.getAttribute('class') ?? '').trim();
        const text = (active.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 24);
        const name = `${active.tagName.toLowerCase()}${cls === '' ? '' : `.${cls.split(/\s+/).join('.')}`}`;
        return text === '' ? name : `${name} "${text}"`;
      });

    const walk: string[] = [];
    let stops = 0;
    while (stops < MAX_TABS && !(await onFirstRow())) {
      await tab.keyboard.press('Tab');
      stops += 1;
      walk.push(`${String(stops)}. ${await focused()}`);
    }
    expect(
      await onFirstRow(),
      `the first list row was not reached in ${String(MAX_TABS)} Tab stops; the walk was ${walk.join(' → ')}`,
    ).toBe(true);

    // Keyboard focus matches `:focus-visible`, so the outline the stylesheet promises is
    // readable straight off the focused element — no screenshot, no colour maths.
    const outline = await tab.evaluate(() => {
      const active = document.activeElement;
      if (active === null) return null;
      const style = window.getComputedStyle(active);
      return { style: style.outlineStyle, width: Number.parseFloat(style.outlineWidth) };
    });
    expect(outline).not.toBeNull();
    expect(outline?.style).not.toBe('none');
    expect(outline?.width ?? 0).toBeGreaterThanOrEqual(2);

    const href = await tab.evaluate(() => document.activeElement?.getAttribute('href') ?? null);
    await tab.keyboard.press('Enter');
    await tab.waitForSelector(EVENT_PAGE_SELECTOR, { timeout: 15_000 });
    expect(await tab.evaluate(() => window.location.pathname)).toBe(href);

    // Nothing above went out to the network, and nothing opened a stream: this is still the
    // polling-only product CI-7 gates, measured rather than re-proved.
    expect(await page.eventSourceCount()).toBe(0);
  }, 120_000);
});
