/**
 * CI-7 — the web security headers end to end (TASKS R5-SEC-2, review 28 E-2).
 *
 * Same rules as `polling-only.e2e.ts`: the *built* app against the harness origin, every
 * wait a polled condition with a deadline, and an *empty* console-error allowlist — here
 * that emptiness is the point, because a Content-Security-Policy violation surfaces as a
 * console error ("Refused to …") as well as a `securitypolicyviolation` event.
 *
 * - The build carries the `_headers` file Pages reads, and it says exactly what
 *   `src/edge/security-headers.ts` says — the unit test holds the two equal at source;
 *   this holds it for the artefact that ships.
 * - The harness origin serves the build under those headers (`securityHeaders`, opt-in),
 *   so the browser enforces the policy on every route of the CI-18 sweep table, the map
 *   included: the style loads, tiles are fetched, the worker starts, and nothing is refused.
 *
 * The stand-in basemap is admitted to the policy with `admitOrigins`, the same operation
 * the deploy performs for the T2 mirror host: the page's `rewrite` hook swaps the
 * configured style URL at the network layer, but the style it receives points at the
 * stand-in's own origin for tiles and glyphs, which the browser then fetches directly and
 * the policy must therefore name. The a11y suite does not opt in: it injects a `<style>`
 * element for its own instrumentation, which `style-src 'self'` would refuse.
 */

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import type { Browser, HTTPResponse, Page } from 'puppeteer-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { LOCALE_STORAGE_KEY } from '../src/core/i18n/locale.js';
import {
  WEB_SECURITY_HEADERS,
  admitOrigins,
  parseHeadersFile,
} from '../src/edge/security-headers.js';
import { ONBOARDING_DONE_VALUE, ONBOARDING_STORAGE_KEY } from '../src/ui/logic/onboarding.js';
import { launchBrowser } from './harness/browser.js';
import { loadFixtureSnapshot } from './harness/fixture.js';
import type { WireSnapshot } from './harness/fixture.js';
import {
  enableMapInspection,
  startLoadableBasemap,
  untilStyleLoaded,
} from './harness/map-inspect.js';
import { startOrigin } from './harness/origin.js';
import { openInstrumentedPage, until } from './harness/page.js';
import type { InstrumentedPage } from './harness/page.js';
import { ROUTE_SURFACES } from './harness/route-surfaces.js';

const DIST_DIR = fileURLToPath(new URL('../dist/', import.meta.url));
const HEADERS_FILE = new URL('../dist/_headers', import.meta.url);

const STORAGE: Readonly<Record<string, string>> = {
  [ONBOARDING_STORAGE_KEY]: ONBOARDING_DONE_VALUE,
  [LOCALE_STORAGE_KEY]: 'en',
};

/** Where the page keeps the violations it saw; a name no app code could collide with. */
const VIOLATIONS_KEY = '__fireWatchE2eCspViolations';

let browser: Browser;
let fixture: WireSnapshot;

beforeAll(async () => {
  fixture = await loadFixtureSnapshot();
  browser = await launchBrowser();
});

afterAll(async () => {
  await browser.close();
});

/** Records every policy violation the document reports, from before the first script. */
async function recordViolations(page: Page): Promise<void> {
  await page.evaluateOnNewDocument((key: string) => {
    const seen: string[] = [];
    (globalThis as unknown as Record<string, unknown>)[key] = seen;
    document.addEventListener('securitypolicyviolation', (event) => {
      seen.push(
        `${event.violatedDirective} blocked ${event.blockedURI} (${event.sourceFile}:${String(event.lineNumber)})`,
      );
    });
  }, VIOLATIONS_KEY);
}

async function violationsOf(page: Page): Promise<readonly string[]> {
  return page.evaluate((key: string) => {
    const seen = (globalThis as unknown as Record<string, unknown>)[key];
    return Array.isArray(seen) ? (seen as string[]) : [];
  }, VIOLATIONS_KEY);
}

function expectSecurityHeaders(response: HTTPResponse | null, path: string): void {
  expect(response, path).not.toBeNull();
  if (response === null) return;
  const headers = response.headers();
  for (const name of Object.keys(WEB_SECURITY_HEADERS)) {
    expect(headers[name], `${path} ${name}`).toBeDefined();
  }
  expect(headers['content-security-policy'], path).toContain("frame-ancestors 'self'");
  expect(headers['x-content-type-options'], path).toBe('nosniff');
}

describe('CI-7 security headers: the build ships the Pages headers file', () => {
  it('carries a _headers file that says what the edge module says', () => {
    expect(existsSync(HEADERS_FILE)).toBe(true);
    const rules = parseHeadersFile(readFileSync(HEADERS_FILE, 'utf8'));
    expect(rules).toEqual([{ path: '/*', headers: WEB_SECURITY_HEADERS }]);
  });
});

describe('CI-7 security headers: the app runs under its own policy', () => {
  // One page sweeps every surface, so the policy's console record spans them all; the
  // suite's resources therefore live for the suite, not for a test.
  const cleanups: (() => Promise<void>)[] = [];
  let instrumented: InstrumentedPage;
  let baseUrl: string;
  let tileRequests: () => number;

  beforeAll(async () => {
    const loadable = await startLoadableBasemap();
    cleanups.push(() => loadable.basemap.close());
    tileRequests = () => loadable.basemap.tileRequests.length;
    const origin = await startOrigin({
      distDir: DIST_DIR,
      fixture,
      advertiseStaticCopy: false,
      staleByMs: 0,
      securityHeaders: admitOrigins(WEB_SECURITY_HEADERS, [loadable.basemap.baseUrl]),
    });
    cleanups.push(() => origin.close());
    origin.setScenario('fresh');
    baseUrl = origin.baseUrl;
    instrumented = await openInstrumentedPage(browser, baseUrl, STORAGE, loadable.pageOptions);
    cleanups.push(() => instrumented.close());
    await enableMapInspection(instrumented.page);
    await recordViolations(instrumented.page);
  });

  afterAll(async () => {
    while (cleanups.length > 0) {
      const cleanup = cleanups.pop();
      if (cleanup !== undefined) await cleanup();
    }
  });

  it.each(ROUTE_SURFACES.map((surface) => [surface.name, surface] as const))(
    'serves %s under the headers and renders it without a refusal',
    async (_name, surface) => {
      const response = await instrumented.page.goto(baseUrl + surface.path, {
        waitUntil: 'load',
      });
      expectSecurityHeaders(response, surface.path);
      await instrumented.page.waitForSelector(surface.ready, { timeout: 15_000 });
      if (surface.path === '/') {
        await untilStyleLoaded(instrumented.page, 30_000);
        await until(() => tileRequests() > 0, {
          timeoutMs: 15_000,
          what: 'the stand-in basemap to receive a tile request',
        });
      }
      expect(await violationsOf(instrumented.page), surface.path).toEqual([]);
    },
  );

  it('refused nothing across the sweep', () => {
    expect(instrumented.blocked).toEqual([]);
    expect(instrumented.consoleErrors).toEqual([]);
    expect(instrumented.pageErrors).toEqual([]);
  });
});
