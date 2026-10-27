/**
 * TASKS V2-C5 — cross-device sync, in a real browser against the built app.
 *
 * What this proves:
 *
 *   1. **A signed-in reader gets the account's choices.** With the account hint set (a
 *      browser that had a live session before), boot loads the sync chunk after first
 *      paint, reads `GET /api/v1/account/preferences`, and the account's theme lands on
 *      `<html data-theme>` without a reload — the account wins on a first sync.
 *   2. **What this browser adds is written back against the revision it was based on:**
 *      the first sync's merge (the seeded language the account lacked), then a theme click
 *      in Settings, each as one debounced `PUT` with `If-Match` on the last revision seen
 *      and a same-origin `Origin`.
 *   3. **A signed-out reader is untouched:** with no hint, the page never asks for the
 *      preferences — not at boot, not after a change — and the choice stays in storage.
 *
 * As in `sign-in.e2e.ts`, a small proxy in front of the harness origin answers the
 * account routes the way the server does (`account-route.ts`,
 * `account-preferences-route.ts`) and passes everything else through.
 *
 * Load: every deadline is an idle-host bound times the shared load margin
 * (`harness/load-margin.ts`); the assertions are on what the page sent and showed.
 */

import { once } from 'node:events';
import { createServer, request as httpRequest } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';

import { ACCOUNT_PREFERENCES_SCHEMA } from '@fire-watch/contracts';
import type { AccountPreferences } from '@fire-watch/contracts';
import type { Browser } from 'puppeteer-core';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { LOCALE_STORAGE_KEY } from '../src/core/i18n/locale.js';
import { ACCOUNT_PREFERENCES_URL } from '../src/core/preferences/client.js';
import { PREFERENCES_SYNC_DEBOUNCE_MS } from '../src/core/preferences/sync.js';
import { ONBOARDING_DONE_VALUE, ONBOARDING_STORAGE_KEY } from '../src/ui/logic/onboarding.js';
import { THEME_STORAGE_KEY } from '../src/ui/logic/theme.js';
import { launchBrowser } from './harness/browser.js';
import { loadFixtureSnapshot } from './harness/fixture.js';
import type { WireSnapshot } from './harness/fixture.js';
import { within } from './harness/load-margin.js';
import { startOrigin } from './harness/origin.js';
import type { InstrumentedPage } from './harness/page.js';
import { openInstrumentedPage, until } from './harness/page.js';

const DIST_DIR = fileURLToPath(new URL('../dist/', import.meta.url));
const ACCOUNT_PATH = '/api/v1/account';
/**
 * `ACCOUNT_HINT_STORAGE_KEY` in `src/ui/preferences-sync.ts`, spelled out: that module
 * binds browser signals at import and is not loaded into this Node process.
 */
const ACCOUNT_HINT_STORAGE_KEY = 'fw:account-hint';

/** A cold load of the built app, or the page's reaction to one click or one answer. */
const PAGE_BOUND_MS = 15_000;
const SCENARIO = { timeout: within(60_000) } as const;

interface ProxiedRequest {
  readonly method: string;
  readonly url: string;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  readonly body: string;
}

interface AccountProxy {
  readonly baseUrl: string;
  readonly requests: readonly ProxiedRequest[];
  close(): Promise<void>;
}

/** The account's stored copy; `revision` moves on every accepted write. */
interface StoredPreferences {
  revision: number;
  preferences: AccountPreferences;
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  response.end(JSON.stringify(body));
}

function problem(response: ServerResponse, status: number, title: string, code: string): void {
  response.writeHead(status, { 'content-type': 'application/problem+json' });
  response.end(JSON.stringify({ type: 'about:blank', title, status, code }));
}

function state(stored: StoredPreferences): unknown {
  return {
    revision: stored.revision,
    document: { schema: ACCOUNT_PREFERENCES_SCHEMA, preferences: stored.preferences },
    updated_at: '2026-10-27T10:00:00.000Z',
  };
}

/** Mirrors the server's account routes closely enough to drive the page; always signed in. */
function answerAccount(
  stored: StoredPreferences,
  method: string,
  path: string,
  headers: IncomingMessage['headers'],
  body: string,
  response: ServerResponse,
): void {
  if (path === ACCOUNT_PATH) {
    json(response, 200, { signed_in: true, session_expires_at: '2099-01-01T00:00:00Z' });
    return;
  }
  if (method === 'GET') {
    json(response, 200, state(stored));
    return;
  }
  const ifMatch = headers['if-match'];
  if (typeof ifMatch !== 'string') {
    problem(response, 428, 'Revision required', 'preferences_revision_required');
    return;
  }
  if (ifMatch !== `"${stored.revision}"`) {
    problem(response, 409, 'Preferences changed elsewhere', 'preferences_conflict');
    return;
  }
  const document = JSON.parse(body) as { preferences: AccountPreferences };
  stored.revision += 1;
  stored.preferences = document.preferences;
  json(response, 200, state(stored));
}

async function startAccountProxy(
  upstream: string,
  stored: StoredPreferences,
): Promise<AccountProxy> {
  const requests: ProxiedRequest[] = [];
  const upstreamUrl = new URL(upstream);
  const server: Server = createServer((incoming: IncomingMessage, response: ServerResponse) => {
    const chunks: Buffer[] = [];
    incoming.on('data', (chunk: Buffer) => chunks.push(chunk));
    incoming.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      const url = incoming.url ?? '/';
      const method = incoming.method ?? 'GET';
      requests.push({ method, url, headers: { ...incoming.headers }, body });
      const path = url.split('?')[0] ?? url;
      if (path === ACCOUNT_PATH || path === ACCOUNT_PREFERENCES_URL) {
        answerAccount(stored, method, path, incoming.headers, body, response);
        return;
      }
      const forwarded = httpRequest(
        {
          hostname: upstreamUrl.hostname,
          port: upstreamUrl.port,
          method,
          path: url,
          headers: { ...incoming.headers, host: upstreamUrl.host },
        },
        (answer) => {
          response.writeHead(answer.statusCode ?? 502, answer.headers);
          answer.pipe(response);
        },
      );
      forwarded.on('error', () => {
        if (!response.headersSent) response.writeHead(502);
        response.end();
      });
      response.on('close', () => forwarded.destroy());
      forwarded.end(body.length > 0 ? body : undefined);
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => {
          resolve();
        });
      }),
  };
}

let fixture: WireSnapshot;
let browser: Browser;
const cleanups: (() => Promise<void>)[] = [];

beforeAll(async () => {
  fixture = await loadFixtureSnapshot();
  browser = await launchBrowser({ longestPageWaitMs: within(PAGE_BOUND_MS) });
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

async function open(
  stored: StoredPreferences,
  storage: Readonly<Record<string, string>>,
): Promise<{ proxy: AccountProxy; page: InstrumentedPage }> {
  const origin = await startOrigin({
    distDir: DIST_DIR,
    fixture,
    advertiseStaticCopy: false,
    staleByMs: 0,
  });
  cleanups.push(() => origin.close());
  origin.setScenario('fresh');
  const proxy = await startAccountProxy(origin.baseUrl, stored);
  cleanups.push(() => proxy.close());
  const page = await openInstrumentedPage(browser, proxy.baseUrl, {
    [ONBOARDING_STORAGE_KEY]: ONBOARDING_DONE_VALUE,
    [LOCALE_STORAGE_KEY]: 'en',
    ...storage,
  });
  cleanups.push(() => page.close());
  await page.page.goto(`${proxy.baseUrl}/settings`, {
    waitUntil: 'load',
    timeout: within(PAGE_BOUND_MS),
  });
  await page.page.waitForSelector('input[name="theme"]', { timeout: within(PAGE_BOUND_MS) });
  return { proxy, page };
}

function preferenceRequests(proxy: AccountProxy, method: 'GET' | 'PUT'): ProxiedRequest[] {
  return proxy.requests.filter((r) => r.url === ACCOUNT_PREFERENCES_URL && r.method === method);
}

/** Wait for the `n`th preferences `PUT` (1-based) and return it. */
async function putNumber(proxy: AccountProxy, n: number): Promise<ProxiedRequest> {
  return until(() => preferenceRequests(proxy, 'PUT')[n - 1], {
    timeoutMs: within(PAGE_BOUND_MS + PREFERENCES_SYNC_DEBOUNCE_MS),
    what: `preferences PUT #${n}`,
  });
}

/** Pick a theme the way a reader does: the radio in Settings (light, dark, auto). */
async function chooseTheme(page: InstrumentedPage, index: number): Promise<void> {
  const radios = await page.page.$$('input[name="theme"]');
  const radio = radios[index];
  if (radio === undefined) throw new Error('e2e: no theme radio at that position');
  await radio.click();
}

describe('V2-C5 cross-device sync — signed in', SCENARIO, () => {
  it('applies the account`s theme, then writes a local change back once', async () => {
    const stored: StoredPreferences = { revision: 3, preferences: { theme: 'dark' } };
    const { proxy, page } = await open(stored, {
      [ACCOUNT_HINT_STORAGE_KEY]: '1',
      [THEME_STORAGE_KEY]: 'light',
    });

    // 1. The account wins on a first sync: dark, without a reload.
    await page.page.waitForFunction(
      () => document.documentElement.getAttribute('data-theme') === 'dark',
      { timeout: within(PAGE_BOUND_MS) },
    );
    expect(preferenceRequests(proxy, 'GET')).toHaveLength(1);
    // This browser fills what the account lacks (the language it was seeded with), and
    // the merge goes back on the revision it read.
    const first = await putNumber(proxy, 1);
    expect(first.headers['if-match']).toBe('"3"');
    expect(first.headers['origin']).toBe(proxy.baseUrl);
    expect(JSON.parse(first.body)).toMatchObject({
      schema: ACCOUNT_PREFERENCES_SCHEMA,
      preferences: { theme: 'dark', locale: 'en' },
    });

    // 2. A choice made here goes back, debounced, on the revision the last write left.
    await chooseTheme(page, 0);
    const second = await putNumber(proxy, 2);
    expect(second.headers['if-match']).toBe('"4"');
    expect(JSON.parse(second.body)).toMatchObject({ preferences: { theme: 'light' } });
    expect(stored.revision).toBe(5);
    expect(stored.preferences.theme).toBe('light');
    expect(preferenceRequests(proxy, 'PUT')).toHaveLength(2);
    expect(
      await page.page.evaluate(() => document.documentElement.getAttribute('data-theme')),
    ).toBe('light');
    expect(page.pageErrors).toEqual([]);
  });
});

describe('V2-C5 cross-device sync — signed out', SCENARIO, () => {
  it('never asks for the preferences, and keeps the choice in storage', async () => {
    const stored: StoredPreferences = { revision: 3, preferences: { theme: 'dark' } };
    const { proxy, page } = await open(stored, {});

    await chooseTheme(page, 1);
    await page.page.waitForFunction(
      () => document.documentElement.getAttribute('data-theme') === 'dark',
      { timeout: within(PAGE_BOUND_MS) },
    );
    // Long enough for a debounced write to have gone out, had one been scheduled.
    await new Promise((resolve) => setTimeout(resolve, PREFERENCES_SYNC_DEBOUNCE_MS * 2));
    expect(proxy.requests.filter((r) => r.url === ACCOUNT_PREFERENCES_URL)).toEqual([]);
    expect(
      await page.page.evaluate((key: string) => localStorage.getItem(key), THEME_STORAGE_KEY),
    ).toBe('dark');
    expect(page.pageErrors).toEqual([]);
  });
});
