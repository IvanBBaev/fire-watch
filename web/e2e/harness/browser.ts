/**
 * Finding and driving a browser for the end-to-end suite.
 *
 * The suite depends on `puppeteer-core`, which ships no browser, on purpose: a download
 * hook in `pnpm install` would run on every developer box and every CI job that never
 * runs this suite, and the repository's install is `--ignore-scripts` anyway. So the
 * browser is provisioned outside the package manager and found here, in this order:
 *
 *   1. `FIRE_WATCH_E2E_BROWSER` — an explicit executable, for a box with an unusual
 *      layout or a deliberately different build. Nothing else is consulted.
 *   2. The build `puppeteer-core` was released against, in the puppeteer cache: exactly
 *      what CI installs, so CI and a developer who ran the printed command exercise the
 *      same binary. The cache is `PUPPETEER_CACHE_DIR`, or puppeteer's own default.
 *   3. Any Chrome or headless shell already in the cache, newest first — a developer
 *      who has puppeteer's browser from another project need not download again.
 *   4. A system Chrome/Chromium at its well-known paths.
 *
 * Otherwise the error names the variable and the install command, rather than letting
 * `launch` fail on a missing path.
 *
 * `chrome-headless-shell` is preferred over full Chrome: it is the old headless mode as
 * a separate, smaller binary, starts faster, and is what the fixture app needs — no
 * extensions, no profile, a software GL context. Full Chrome runs in its new headless
 * mode when it is what was found.
 */

import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';

import {
  Browser as BrowserName,
  computeExecutablePath,
  getInstalledBrowsers,
} from '@puppeteer/browsers';
import type { InstalledBrowser } from '@puppeteer/browsers';
import puppeteer from 'puppeteer-core';
import type { Browser } from 'puppeteer-core';
import { PUPPETEER_REVISIONS } from 'puppeteer-core/internal/revisions.js';

export const BROWSER_ENV_VAR = 'FIRE_WATCH_E2E_BROWSER';

/** The build CI pins; `ci.yml` resolves the same constant to install it. */
export const PINNED_HEADLESS_SHELL_BUILD: string = PUPPETEER_REVISIONS['chrome-headless-shell'];

/** Where `@puppeteer/browsers` installs to unless told otherwise. */
function cacheDir(): string {
  return process.env['PUPPETEER_CACHE_DIR'] ?? join(homedir(), '.cache', 'puppeteer');
}

const SYSTEM_CANDIDATES: readonly string[] = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium-browser',
  '/usr/bin/chromium',
];

/**
 * The command the error prints. `--path` is not a detail: the `browsers` CLI installs
 * into the *current working directory* by default — which under `pnpm --filter` is
 * `web/`, inside the repository and nowhere this module looks. Naming the cache makes
 * the printed command actually fix the failure it is printed for.
 */
export function installHint(): string {
  return (
    `pnpm --filter @fire-watch/web exec browsers install ` +
    `chrome-headless-shell@${PINNED_HEADLESS_SHELL_BUILD} --path "${cacheDir()}"`
  );
}

export async function resolveBrowserExecutable(): Promise<string> {
  const explicit = process.env[BROWSER_ENV_VAR];
  if (explicit !== undefined && explicit !== '') {
    if (!existsSync(explicit)) {
      throw new Error(`e2e: ${BROWSER_ENV_VAR}=${explicit} does not exist`);
    }
    return explicit;
  }

  const cache = cacheDir();
  const pinned = computeExecutablePath({
    cacheDir: cache,
    browser: BrowserName.CHROMEHEADLESSSHELL,
    buildId: PINNED_HEADLESS_SHELL_BUILD,
  });
  if (existsSync(pinned)) return pinned;

  const installed = await installedCandidates(cache);
  const fallback = installed[0];
  if (fallback !== undefined) return fallback.executablePath;

  const system = SYSTEM_CANDIDATES.find((candidate) => existsSync(candidate));
  if (system !== undefined) return system;

  throw new Error(
    `e2e: no browser found. Set ${BROWSER_ENV_VAR} to a Chrome/Chromium executable, ` +
      `or install the pinned headless shell with:\n  ${installHint()}`,
  );
}

/** Headless shells first, then Chrome; within a kind the highest build first. */
async function installedCandidates(cache: string): Promise<InstalledBrowser[]> {
  let all: InstalledBrowser[];
  try {
    all = await getInstalledBrowsers({ cacheDir: cache });
  } catch {
    // A cache directory that does not exist yet, or one we cannot read: nothing installed.
    return [];
  }
  const rank = (browser: InstalledBrowser): number =>
    browser.browser === BrowserName.CHROMEHEADLESSSHELL
      ? 0
      : browser.browser === BrowserName.CHROME
        ? 1
        : 2;
  return all
    .filter((browser) => rank(browser) < 2 && existsSync(browser.executablePath))
    .sort((a, b) => rank(a) - rank(b) || compareBuilds(b.buildId, a.buildId));
}

/** Dotted Chrome build ids compare component by component, not as strings. */
function compareBuilds(a: string, b: string): number {
  const as = a.split('.').map(Number);
  const bs = b.split('.').map(Number);
  for (let i = 0; i < Math.max(as.length, bs.length); i += 1) {
    const diff = (as[i] ?? 0) - (bs[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/**
 * `'shell'` selects the old headless implementation, which is the only mode the
 * headless-shell binary has; full Chrome takes `true` for its new headless mode.
 */
export function headlessModeFor(executablePath: string): boolean | 'shell' {
  return basename(executablePath).startsWith('chrome-headless-shell') ? 'shell' : true;
}

/**
 * Puppeteer's own ceiling on a single CDP call. It is not only a transport timeout: a
 * `waitForSelector`/`waitForFunction` holds *one* evaluate open until its predicate is
 * true, so every such wait is also capped here — whatever `timeout` it was given. A wait
 * longer than this ceiling dies as a `ProtocolError` instead of timing out with its own
 * message, which reads as a hang in the harness.
 */
export const DEFAULT_PROTOCOL_TIMEOUT_MS = 180_000;

/** Headroom above a scenario's longest page-side wait before the CDP call is cut. */
const PROTOCOL_TIMEOUT_HEADROOM_MS = 30_000;

export interface LaunchOptions {
  /**
   * The longest `timeout` any page-side wait of the scenario passes. The CDP ceiling is
   * raised above it (never lowered below the default), so a wait scaled by a load margin
   * always fails with its own timeout, not with a protocol error.
   */
  readonly longestPageWaitMs?: number;
}

/** The CDP ceiling for a scenario whose longest page-side wait is `longestPageWaitMs`. */
export function protocolTimeoutFor(longestPageWaitMs = 0): number {
  return Math.max(DEFAULT_PROTOCOL_TIMEOUT_MS, longestPageWaitMs + PROTOCOL_TIMEOUT_HEADROOM_MS);
}

export async function launchBrowser(options: LaunchOptions = {}): Promise<Browser> {
  const executablePath = await resolveBrowserExecutable();
  return puppeteer.launch({
    executablePath,
    headless: headlessModeFor(executablePath),
    protocolTimeout: protocolTimeoutFor(options.longestPageWaitMs),
    // No sandbox: CI runners and containers lack the user namespaces it needs, and the
    // only content loaded is the repository's own build from loopback.
    //
    // Software WebGL rather than `--disable-gpu`: nothing here asserts on rendered pixels,
    // but MapLibre needs a WebGL2 context to *exist*, and this launch is the baseline every
    // scenario runs on — the context a reader's browser has. SwiftShader being slow does
    // not matter: the map is off-screen work nothing waits on. A reader whose browser
    // refuses the context is covered too, but by a scenario that refuses it in the page
    // (`harness/page.ts` `denyWebGl`) rather than by taking the flag away here, which would
    // have quietly moved every scenario onto the degraded path and covered neither.
    args: ['--no-sandbox', '--enable-unsafe-swiftshader'],
  });
}
