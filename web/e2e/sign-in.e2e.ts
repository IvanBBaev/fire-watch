/**
 * TASKS I1 — sign-in by email link, in a real browser against the built app.
 *
 * What this proves, in the order a link is used:
 *
 *   1. **The token leaves the URL before anything else happens.** An init script records
 *      `location.href` at every `history.replaceState` and every `fetch` call. The first
 *      `fetch` of the document — and every one after it — sees a URL with no token in it.
 *   2. **It is sent to exactly one place:** the JSON body of `POST /api/v1/auth/continue`,
 *      and only after the reader presses Continue (C2 — scanners prefetch links). No
 *      other request carries it anywhere — URL, header or body — and no `Referer` does.
 *   3. **The auth calls are same-origin and pass the server's CSRF check:** each carries
 *      an `Origin` equal to the page's own (a `no-referrer` policy would have made it
 *      `null`, which the server refuses).
 *   4. **It is never logged:** no console message of any level contains it.
 *   5. **Auth off is absence, not an error:** where the routes answer 404, Settings has no
 *      account section, no banner appears, and the pages say "not available" in one line.
 *
 * The harness origin (`harness/origin.ts`) serves no auth routes, and this file does not
 * change it: a small proxy in front of it answers `/api/v1/auth/*` the way the server's
 * `auth-route.ts` does, and passes everything else through. The proxy is the page's
 * origin, so it sees — and logs — every request the page makes. Its problem documents
 * carry the same `code` members the server's do, because that — not the title — is what
 * the page reads.
 *
 * Load. Every deadline is an idle-host bound times the shared load margin
 * (`harness/load-margin.ts`, `FIRE_WATCH_E2E_LOAD_MARGIN`): on a loaded host the page, the
 * CDP round trips and the two local servers all run late while the client behaves the
 * same. A deadline only says how long to wait before calling the page broken; every
 * assertion is on what the page showed and sent, which load does not change.
 */

import { once } from 'node:events';
import { createServer, request as httpRequest } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';

import type { ProblemCode } from '@fire-watch/contracts';
import type { Browser } from 'puppeteer-core';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { LOCALE_STORAGE_KEY } from '../src/core/i18n/locale.js';
import en from '../src/core/i18n/en.js';
import { ONBOARDING_DONE_VALUE, ONBOARDING_STORAGE_KEY } from '../src/ui/logic/onboarding.js';
import { launchBrowser } from './harness/browser.js';
import { loadFixtureSnapshot } from './harness/fixture.js';
import type { WireSnapshot } from './harness/fixture.js';
import { within } from './harness/load-margin.js';
import { startOrigin } from './harness/origin.js';
import type { InstrumentedPage } from './harness/page.js';
import { openInstrumentedPage, until } from './harness/page.js';

const DIST_DIR = fileURLToPath(new URL('../dist/', import.meta.url));

const STORAGE: Readonly<Record<string, string>> = {
  [ONBOARDING_STORAGE_KEY]: ONBOARDING_DONE_VALUE,
  [LOCALE_STORAGE_KEY]: 'en',
};

/** A token of the shape the server issues: 32 random bytes, base64url, 43 characters. */
const TOKEN = 'Zm9yLWUyZS1vbmx5LW5vdC1hLXJlYWwtdG9rZW4tX0';

const READY = '.auth-page[data-ready]';

/**
 * How long one page step may take on an idle host: a cold load of the built app, or the
 * page's reaction to one click or one answer.
 */
const PAGE_BOUND_MS = 15_000;
/** A whole scenario on an idle host: the e2e project's default test budget. */
const SCENARIO_BOUND_MS = 60_000;
/** Every scenario's deadline, scaled like its steps. */
const SCENARIO = { timeout: within(SCENARIO_BOUND_MS) } as const;
const BANNER_SELECTOR = '.fw-banner[role="status"]';
const AUTH_PREFIX = '/api/v1/auth/';
const ACCOUNT_PATH = '/api/v1/account';

/** How the fake auth routes answer. */
type AuthMode =
  | { readonly kind: 'disabled' }
  | {
      readonly kind: 'enabled';
      readonly link?: 'sent' | 'rate-limited';
      /** Refuse `continue` with this problem, as the server's `AUTH_REFUSALS` would. */
      readonly continueRefusal?: { readonly title: string; readonly code: ProblemCode };
    };

interface ProxiedRequest {
  readonly method: string;
  readonly url: string;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  readonly body: string;
}

interface AuthProxy {
  readonly baseUrl: string;
  readonly requests: readonly ProxiedRequest[];
  setMode(mode: AuthMode): void;
  close(): Promise<void>;
}

/** A problem document; `code` is absent only where the server's is (Fastify's own 404). */
function problem(
  response: ServerResponse,
  status: number,
  title: string,
  code: ProblemCode | undefined,
  extra: Record<string, string> = {},
): void {
  response.writeHead(status, { 'content-type': 'application/problem+json', ...extra });
  response.end(
    JSON.stringify({ type: 'about:blank', title, status, ...(code === undefined ? {} : { code }) }),
  );
}

/** The proxy's one piece of server state: whether "the cookie" is set. */
interface FakeSession {
  signedIn: boolean;
}

/**
 * Mirrors `server/src/adapters/http/auth-route.ts` and the `GET` of `account-route.ts`
 * closely enough to drive the pages. The session is a flag here, not a cookie: what is
 * under test is what the page sends and shows, not the server's cookie handling.
 */
function answerAuth(
  mode: AuthMode,
  session: FakeSession,
  path: string,
  body: string,
  response: ServerResponse,
): void {
  if (mode.kind === 'disabled') {
    problem(response, 404, 'Not Found', undefined);
    return;
  }
  if (path === ACCOUNT_PATH) {
    if (!session.signedIn) {
      problem(response, 401, 'Not signed in', 'not_signed_in');
      return;
    }
    response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    response.end(JSON.stringify({ signed_in: true, session_expires_at: '2099-01-01T00:00:00Z' }));
    return;
  }
  let parsed: Record<string, unknown> = {};
  try {
    parsed = JSON.parse(body) as Record<string, unknown>;
  } catch {
    // Treated as an empty body below.
  }
  if (path === `${AUTH_PREFIX}link`) {
    if (typeof parsed['email'] !== 'string') {
      problem(response, 400, 'Invalid request body', 'invalid_body');
      return;
    }
    if (mode.link === 'rate-limited') {
      problem(response, 429, 'Too many sign-in links', 'rate_limited', { 'retry-after': '600' });
      return;
    }
    response.writeHead(202, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ status: 'sent' }));
    return;
  }
  if (path === `${AUTH_PREFIX}continue`) {
    if (typeof parsed['token'] !== 'string') {
      problem(response, 400, 'Invalid request body', 'invalid_body');
      return;
    }
    if (mode.continueRefusal !== undefined) {
      problem(response, 400, mode.continueRefusal.title, mode.continueRefusal.code);
      return;
    }
    session.signedIn = true;
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ account_created: true }));
    return;
  }
  if (path === `${AUTH_PREFIX}logout`) {
    session.signedIn = false;
    response.writeHead(204);
    response.end();
    return;
  }
  problem(response, 404, 'Not Found', undefined);
}

async function startAuthProxy(upstream: string): Promise<AuthProxy> {
  const requests: ProxiedRequest[] = [];
  let mode: AuthMode = { kind: 'disabled' };
  const session: FakeSession = { signedIn: false };
  const upstreamUrl = new URL(upstream);

  const server: Server = createServer((incoming: IncomingMessage, response: ServerResponse) => {
    const chunks: Buffer[] = [];
    incoming.on('data', (chunk: Buffer) => chunks.push(chunk));
    incoming.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      const url = incoming.url ?? '/';
      requests.push({
        method: incoming.method ?? 'GET',
        url,
        headers: { ...incoming.headers },
        body,
      });
      const path = url.split('?')[0] ?? url;
      if (path.startsWith(AUTH_PREFIX) || path === ACCOUNT_PATH) {
        answerAuth(mode, session, path, body, response);
        return;
      }
      const forwarded = httpRequest(
        {
          hostname: upstreamUrl.hostname,
          port: upstreamUrl.port,
          method: incoming.method,
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
      // The reader went away (a navigation, a closed stream): stop the upstream request too.
      // Not `incoming`'s 'close' — that fires as soon as the request body has been read.
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
    setMode(next) {
      mode = next;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => {
          resolve();
        });
      }),
  };
}

/** What the init script records, in call order. */
interface PageEvent {
  readonly kind: 'replaceState' | 'fetch';
  /** `location.href` at the moment of the call. */
  readonly href: string;
  readonly target: string;
}

const EVENT_LOG_KEY = '__fireWatchE2eAuthLog';

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

interface Session {
  readonly proxy: AuthProxy;
  readonly page: InstrumentedPage;
  /** Every console message, any level. */
  readonly console: readonly string[];
  events(): Promise<readonly PageEvent[]>;
}

async function open(mode: AuthMode): Promise<Session> {
  const origin = await startOrigin({
    distDir: DIST_DIR,
    fixture,
    advertiseStaticCopy: false,
    staleByMs: 0,
  });
  cleanups.push(() => origin.close());
  origin.setScenario('fresh');
  const proxy = await startAuthProxy(origin.baseUrl);
  cleanups.push(() => proxy.close());
  proxy.setMode(mode);

  const page = await openInstrumentedPage(browser, proxy.baseUrl, STORAGE);
  cleanups.push(() => page.close());
  const consoleLines: string[] = [];
  page.page.on('console', (message) => {
    consoleLines.push(message.text());
  });
  await page.page.evaluateOnNewDocument((key: string) => {
    const log: { kind: string; href: string; target: string }[] = [];
    Reflect.set(window, key, log);
    const nativeFetch = window.fetch.bind(window);
    window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
      const target = input instanceof Request ? input.url : String(input);
      log.push({ kind: 'fetch', href: location.href, target });
      return nativeFetch(input, init);
    };
    const nativeReplace = history.replaceState.bind(history);
    history.replaceState = (data: unknown, unused: string, url?: string | URL | null) => {
      log.push({ kind: 'replaceState', href: location.href, target: String(url) });
      nativeReplace(data, unused, url);
    };
  }, EVENT_LOG_KEY);

  return {
    proxy,
    page,
    console: consoleLines,
    events: () =>
      page.page.evaluate((key: string) => Reflect.get(window, key) as PageEvent[], EVENT_LOG_KEY),
  };
}

function authRequests(proxy: AuthProxy, name: 'link' | 'continue' | 'logout'): ProxiedRequest[] {
  return proxy.requests.filter((r) => r.url === `${AUTH_PREFIX}${name}`);
}

/** Every place a request could carry the token: its URL, any header, its body. */
function carriesToken(request: ProxiedRequest): boolean {
  return (
    request.url.includes(TOKEN) ||
    request.body.includes(TOKEN) ||
    Object.values(request.headers).some((value) => String(value).includes(TOKEN))
  );
}

async function textOf(page: InstrumentedPage, selector: string): Promise<string> {
  return page.page.$eval(selector, (element) => element.textContent ?? '');
}

async function clickButton(page: InstrumentedPage, label: string): Promise<void> {
  const buttons = await page.page.$$('.auth-page button, .settings-account button');
  for (const button of buttons) {
    const text = await button.evaluate((element) => element.textContent ?? '');
    if (text.trim() === label) {
      await button.click();
      return;
    }
  }
  throw new Error(`e2e: no button labelled "${label}"`);
}

describe('I1 sign-in — token hygiene', SCENARIO, () => {
  it('strips the token before any request, sends it only to continue, and only on Continue', async () => {
    const session = await open({ kind: 'enabled' });
    const { proxy, page } = session;
    // The mailer's landing URL is server configuration; a token on any path is moved.
    await page.page.goto(`${proxy.baseUrl}/#token=${TOKEN}`, {
      waitUntil: 'load',
      timeout: within(PAGE_BOUND_MS),
    });
    await page.page.waitForSelector(`${READY} .button-primary`, { timeout: within(PAGE_BOUND_MS) });

    const url = new URL(page.page.url());
    expect(url.pathname).toBe('/sign-in/continue');
    expect(page.page.url()).not.toContain(TOKEN);

    // The strip is the first recorded call, and no fetch ever saw the token in the URL.
    const before = await session.events();
    expect(before[0]?.kind).toBe('replaceState');
    expect(before[0]?.target).not.toContain(TOKEN);
    const fetches = before.filter((event) => event.kind === 'fetch');
    expect(fetches.length).toBeGreaterThan(0);
    for (const event of fetches) expect(event.href, event.target).not.toContain(TOKEN);

    // Loading the page never exchanges the link (C2).
    expect(authRequests(proxy, 'continue')).toStrictEqual([]);

    await clickButton(page, en.signIn.continue);
    await until(() => authRequests(proxy, 'continue').length === 1, {
      timeoutMs: within(PAGE_BOUND_MS),
      what: 'the continue POST',
    });
    await page.page.waitForFunction(
      (text: string) => document.querySelector('.auth-page')?.textContent?.includes(text) === true,
      { timeout: within(PAGE_BOUND_MS) },
      en.signIn.accountCreated,
    );

    const [exchange] = authRequests(proxy, 'continue');
    expect(exchange?.method).toBe('POST');
    expect(JSON.parse(exchange?.body ?? '')).toStrictEqual({ token: TOKEN });
    // Same-origin, and an Origin the server's CSRF check accepts (not `null`).
    expect(exchange?.headers['origin']).toBe(proxy.baseUrl);

    await clickButton(page, en.signIn.signOut);
    await until(() => authRequests(proxy, 'logout').length === 1, {
      timeoutMs: within(PAGE_BOUND_MS),
      what: 'the logout POST',
    });
    await page.page.waitForFunction(
      (text: string) => document.querySelector('.auth-page')?.textContent?.includes(text) === true,
      { timeout: within(PAGE_BOUND_MS) },
      en.signIn.signedOut,
    );

    // Exactly one request ever carried the token, and it is the exchange — in its body.
    const carriers = proxy.requests.filter(carriesToken);
    expect(carriers.map((r) => `${r.method} ${r.url}`)).toStrictEqual([
      `POST ${AUTH_PREFIX}continue`,
    ]);
    expect(exchange?.url).not.toContain(TOKEN);
    for (const request of proxy.requests) {
      const referer = request.headers['referer'];
      if (referer !== undefined) expect(String(referer)).not.toContain(TOKEN);
    }
    for (const request of proxy.requests.filter((r) => r.url.startsWith(AUTH_PREFIX))) {
      expect(request.headers['origin'], request.url).toBe(proxy.baseUrl);
      // `strict-origin`: at most the origin, never the path.
      const referer = request.headers['referer'];
      if (referer !== undefined) expect(String(referer)).toBe(`${proxy.baseUrl}/`);
    }

    // Never logged, at any level, and the page raised nothing.
    expect(session.console.filter((line) => line.includes(TOKEN))).toStrictEqual([]);
    expect(page.pageErrors).toStrictEqual([]);
    // Nor did any request that left the harness (the basemap style is blocked by design).
    expect(page.blocked.filter((url) => url.includes(TOKEN))).toStrictEqual([]);
    // A later render cannot find the token again: history holds only the stripped URL.
    expect(await page.page.evaluate(() => location.hash)).toBe('');
  });

  it('keeps the map fragment when it strips the token', async () => {
    const { proxy, page } = await open({ kind: 'enabled' });
    await page.page.goto(`${proxy.baseUrl}/#map=7/42.7/25.4&token=${TOKEN}`, {
      waitUntil: 'load',
      timeout: within(PAGE_BOUND_MS),
    });
    await page.page.waitForSelector(READY, { timeout: within(PAGE_BOUND_MS) });
    expect(page.page.url()).not.toContain(TOKEN);
    expect(new URL(page.page.url()).hash).toBe('#map=7/42.7/25.4');
  });

  it('shows a refused link and offers a new one', async () => {
    const { proxy, page } = await open({
      kind: 'enabled',
      continueRefusal: { title: 'Link already used', code: 'link_used' },
    });
    await page.page.goto(`${proxy.baseUrl}/sign-in/continue#token=${TOKEN}`, {
      waitUntil: 'load',
      timeout: within(PAGE_BOUND_MS),
    });
    await page.page.waitForSelector(`${READY} .button-primary`, { timeout: within(PAGE_BOUND_MS) });
    await clickButton(page, en.signIn.continue);
    await page.page.waitForFunction(
      (text: string) => document.querySelector('.auth-page')?.textContent?.includes(text) === true,
      { timeout: within(PAGE_BOUND_MS) },
      en.signIn.used,
    );
    expect(await page.page.$eval('.auth-page a[href="/sign-in"]', (a) => a.textContent)).toBe(
      en.signIn.requestNew,
    );
  });

  it('never sends a malformed token', async () => {
    const { proxy, page } = await open({ kind: 'enabled' });
    await page.page.goto(`${proxy.baseUrl}/#token=not%20a%20token`, {
      waitUntil: 'load',
      timeout: within(PAGE_BOUND_MS),
    });
    await page.page.waitForSelector(READY, { timeout: within(PAGE_BOUND_MS) });
    expect(await textOf(page, '.auth-page')).toContain(en.signIn.noLink);
    expect(await page.page.$('.auth-page .button-primary')).toBeNull();
    expect(authRequests(proxy, 'continue')).toStrictEqual([]);
    expect(page.page.url()).not.toContain('token');
  });
});

describe('I1 sign-in — the request form', SCENARIO, () => {
  it('answers neutrally, whether or not the address has an account', async () => {
    const { proxy, page } = await open({ kind: 'enabled', link: 'sent' });
    await page.page.goto(`${proxy.baseUrl}/sign-in`, {
      waitUntil: 'load',
      timeout: within(PAGE_BOUND_MS),
    });
    await page.page.waitForSelector(`${READY} input[type="email"]`, {
      timeout: within(PAGE_BOUND_MS),
    });
    await page.page.type('#auth-email', 'reader@example.org');
    await clickButton(page, en.signIn.send);
    await page.page.waitForFunction(
      (text: string) => document.querySelector('.auth-page')?.textContent?.includes(text) === true,
      { timeout: within(PAGE_BOUND_MS) },
      en.signIn.sent,
    );
    const sent = authRequests(proxy, 'link').filter((r) => r.body.includes('reader@example.org'));
    expect(sent).toHaveLength(1);
    expect(sent[0]?.headers['origin']).toBe(proxy.baseUrl);
  });

  it('says so when too many links were requested', async () => {
    const { proxy, page } = await open({ kind: 'enabled', link: 'rate-limited' });
    await page.page.goto(`${proxy.baseUrl}/sign-in`, {
      waitUntil: 'load',
      timeout: within(PAGE_BOUND_MS),
    });
    await page.page.waitForSelector(`${READY} input[type="email"]`, {
      timeout: within(PAGE_BOUND_MS),
    });
    await page.page.type('#auth-email', 'reader@example.org');
    await clickButton(page, en.signIn.send);
    await page.page.waitForFunction(
      (text: string) => document.querySelector('.auth-page')?.textContent?.includes(text) === true,
      { timeout: within(PAGE_BOUND_MS) },
      en.signIn.rateLimited,
    );
    // The form stays, so the reader can try again later.
    expect(await page.page.$('#auth-email')).not.toBeNull();
  });
});

describe('I1 sign-in — the signed-in indicator', SCENARIO, () => {
  it('shows the account state in Settings, and signs out from there', async () => {
    const { proxy, page } = await open({ kind: 'enabled' });

    await page.page.goto(`${proxy.baseUrl}/settings`, {
      waitUntil: 'load',
      timeout: within(PAGE_BOUND_MS),
    });
    await page.page.waitForSelector('.settings-account a[href="/sign-in"]', {
      timeout: within(PAGE_BOUND_MS),
    });
    expect(await textOf(page, '.settings-account')).toContain(en.signIn.accountNote);

    await page.page.goto(`${proxy.baseUrl}/#token=${TOKEN}`, {
      waitUntil: 'load',
      timeout: within(PAGE_BOUND_MS),
    });
    await page.page.waitForSelector(`${READY} .button-primary`, { timeout: within(PAGE_BOUND_MS) });
    await clickButton(page, en.signIn.continue);
    await page.page.waitForFunction(
      (text: string) => document.querySelector('.auth-page')?.textContent?.includes(text) === true,
      { timeout: within(PAGE_BOUND_MS) },
      en.signIn.accountCreated,
    );

    await page.page.click('header a[href="/settings"]');
    await page.page.waitForFunction(
      (text: string) =>
        document.querySelector('.settings-account')?.textContent?.includes(text) === true,
      { timeout: within(PAGE_BOUND_MS) },
      en.signIn.signedIn,
    );
    await clickButton(page, en.signIn.signOut);
    await page.page.waitForSelector('.settings-account a[href="/sign-in"]', {
      timeout: within(PAGE_BOUND_MS),
    });
    expect(authRequests(proxy, 'logout')).toHaveLength(1);
    // The session check is a GET: no body, and the token is nowhere near it.
    for (const check of proxy.requests.filter((r) => r.url === ACCOUNT_PATH)) {
      expect(check.method).toBe('GET');
      expect(carriesToken(check)).toBe(false);
    }
    expect(page.pageErrors).toStrictEqual([]);
  });
});

describe('I1 sign-in — auth switched off server-side', SCENARIO, () => {
  it('shows no entry point, no banner and never sends a held token', async () => {
    const { proxy, page } = await open({ kind: 'disabled' });

    await page.page.goto(`${proxy.baseUrl}/#token=${TOKEN}`, {
      waitUntil: 'load',
      timeout: within(PAGE_BOUND_MS),
    });
    await page.page.waitForSelector(READY, { timeout: within(PAGE_BOUND_MS) });
    expect(await textOf(page, '.auth-page')).toContain(en.signIn.unavailable);
    expect(await page.page.$('.auth-page button')).toBeNull();
    expect(page.page.url()).not.toContain(TOKEN);
    expect(authRequests(proxy, 'continue')).toStrictEqual([]);
    expect(proxy.requests.filter(carriesToken)).toStrictEqual([]);
    expect(await page.page.$(BANNER_SELECTOR)).toBeNull();

    await page.page.goto(`${proxy.baseUrl}/sign-in`, {
      waitUntil: 'load',
      timeout: within(PAGE_BOUND_MS),
    });
    await page.page.waitForSelector(READY, { timeout: within(PAGE_BOUND_MS) });
    expect(await textOf(page, '.auth-page')).toContain(en.signIn.unavailable);
    expect(await page.page.$('.auth-page form')).toBeNull();

    // In-app navigation keeps the document, so Settings mounts with the 404 already
    // known: its section can only stay hidden, and no second request is made for it.
    const checks = proxy.requests.filter((r) => r.url === ACCOUNT_PATH).length;
    await page.page.click('header a[href="/settings"]');
    await page.page.waitForSelector('.settings-group', { timeout: within(PAGE_BOUND_MS) });
    expect(await page.page.$('.settings-account')).toBeNull();
    expect(await page.page.$('a[href="/sign-in"]')).toBeNull();
    expect(await page.page.$(BANNER_SELECTOR)).toBeNull();
    expect(proxy.requests.filter((r) => r.url === ACCOUNT_PATH)).toHaveLength(checks);
    expect(page.pageErrors).toStrictEqual([]);
  });
});
