/**
 * One instrumented page per scenario, and the one way the suite waits.
 *
 * Every page opens in its own browser context — its own cookie jar, storage and HTTP
 * cache — because the client-config document is cacheable for thirty seconds by design
 * and one scenario must not boot on the document another scenario was served. The page
 * is set up before the app is loaded, never after, and nothing in the app is touched:
 *
 *   * **Only the harness origin is reachable** (plus any origin a scenario names, such as
 *     its static mirror). Request interception aborts every other `http(s)` request and
 *     records it. The built app would otherwise fetch the basemap
 *     style from OpenFreeMap, which would make the run depend on a third party and on
 *     the network; a suite that reaches out is not a gate. The record lets the test
 *     assert that nothing *else* leaked out.
 *   * **Storage is seeded** on every new document, before any script of the app runs:
 *     the onboarding marker (so the cards do not cover the list) and an explicit locale
 *     (the shipped HTML says `lang="bg"`, so a document that ends up `lang="en"` proves
 *     boot read its persisted state). The keys and values are the app's own constants.
 *   * **`EventSource` construction is counted** by wrapping the native constructor:
 *     "the stream was never requested" is checked at the network log *and* at the API
 *     the client would have used, so a stream that is opened and closed before a request
 *     is written still counts as an offer taken.
 *   * **Console errors and page errors are collected** for the test to assert on.
 *   * **The clock can be warped**, per scenario: `Date.now` and `performance.now` — the two
 *     readings the app's clock adapter makes — are shifted by an offset the test sets, so
 *     a scenario can let half an hour pass without waiting for it (`world-clock.ts`).
 *     Timers are not touched. Off by default.
 *   * **WebGL can be refused**, per scenario, for the one scenario that needs a browser
 *     without it. Off by default, so every other scenario runs on the context a reader's
 *     browser actually has.
 *
 * Waiting: every wait in the suite is a condition polled with a deadline — a DOM state
 * via `page.waitForFunction`, a request-log state via `until`. The suite never sleeps for
 * a duration and then hopes; a wait that times out fails with what it was waiting for.
 */

import type { Browser, BrowserContext, Page } from 'puppeteer-core';

export interface InstrumentedPageOptions {
  /**
   * Refuse every WebGL context this document asks for, before a single script of the app
   * runs.
   *
   * MapLibre needs a WebGL2 context to *exist*; a browser that will not hand one out — an
   * old machine, a blocklisted driver, a hardened profile — is still a browser this product
   * serves. Overriding `getContext` in the page is the in-page equivalent of launching
   * without `--enable-unsafe-swiftshader`, and deliberately so: both were run side by side
   * and produce the same `GPUInitializationError` and the same half-built map. Doing it
   * per page rather than per launch is what keeps it to the one scenario that means it.
   */
  readonly denyWebGl?: boolean;
  /** Origins besides the harness's that the page may reach (e.g. `http://127.0.0.1:<port>`). */
  readonly extraOrigins?: readonly string[];
  /** Install the clock-offset hook, so `setClockOffset` can move the page's time. */
  readonly warpClock?: boolean;
  /**
   * Exact URLs the page asks for that are served from somewhere else instead, e.g. the
   * third-party basemap style replaced by a local stand-in (`stand-in-basemap.ts`). The
   * substitute's origin must also be in `extraOrigins`; a rewritten request is not
   * recorded as blocked, because it never left the harness.
   */
  readonly rewrite?: Readonly<Record<string, string>>;
}

export interface InstrumentedPage {
  readonly page: Page;
  /** URLs of requests aborted for leaving the harness origin, in order. */
  readonly blocked: readonly string[];
  /** `console.error` texts, in order. */
  readonly consoleErrors: readonly string[];
  /** Uncaught exceptions and unhandled rejections in the page, in order. */
  readonly pageErrors: readonly string[];
  /** How many times the app constructed an `EventSource` in this document. */
  eventSourceCount(): Promise<number>;
  /**
   * Shift the page's `Date.now` and `performance.now` to `offsetMs` ahead of real time —
   * the world clock's offset. Only with `warpClock`; the offset only ever grows.
   */
  setClockOffset(offsetMs: number): Promise<void>;
  close(): Promise<void>;
}

/** Where the counting wrapper keeps its tally; a name no app code could collide with. */
const EVENT_SOURCE_COUNT_KEY = '__fireWatchE2eEventSourceCount';
/** Where the clock hook reads its offset from; set by `setClockOffset`. */
const CLOCK_OFFSET_KEY = '__fireWatchE2eClockOffsetMs';

export async function openInstrumentedPage(
  browser: Browser,
  originBase: string,
  storage: Readonly<Record<string, string>>,
  options: InstrumentedPageOptions = {},
): Promise<InstrumentedPage> {
  const context: BrowserContext = await browser.createBrowserContext();
  const page = await context.newPage();
  const blocked: string[] = [];
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  const reachable = new Set([originBase, ...(options.extraOrigins ?? [])]);

  await page.setRequestInterception(true);
  page.on('request', (request) => {
    const substitute = options.rewrite?.[request.url()];
    if (substitute !== undefined) {
      void request.continue({ url: substitute });
      return;
    }
    const url = new URL(request.url());
    // `data:`/`blob:` never leave the process; only network schemes are gated.
    const network = url.protocol === 'http:' || url.protocol === 'https:';
    if (!network || reachable.has(url.origin)) {
      void request.continue();
      return;
    }
    blocked.push(url.href);
    void request.abort('blockedbyclient');
  });
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('pageerror', (error: unknown) => {
    pageErrors.push(error instanceof Error ? error.message : String(error));
  });

  if (options.denyWebGl === true) {
    await page.evaluateOnNewDocument(() => {
      // Read through `Reflect` so it is a value being copied, not a method being torn off
      // its object — the same call, and the delegation below re-supplies the receiver.
      const native = Reflect.get(HTMLCanvasElement.prototype, 'getContext') as (
        this: HTMLCanvasElement,
        contextId: string,
        contextOptions?: unknown,
      ) => unknown;
      const refused = new Set(['webgl', 'webgl2', 'experimental-webgl']);
      function denied(
        this: HTMLCanvasElement,
        contextId: string,
        contextOptions?: unknown,
      ): unknown {
        // `null` is what a real refusal looks like to the caller; every other context —
        // `2d`, `bitmaprenderer` — is delegated untouched, so nothing else is affected.
        if (refused.has(contextId)) return null;
        return native.call(this, contextId, contextOptions);
      }
      HTMLCanvasElement.prototype.getContext =
        denied as unknown as typeof HTMLCanvasElement.prototype.getContext;
    });
  }

  if (options.warpClock === true) {
    await page.evaluateOnNewDocument((offsetKey: string) => {
      const holder = window as unknown as Record<string, unknown>;
      holder[offsetKey] = 0;
      const offset = (): number => {
        const value = holder[offsetKey];
        return typeof value === 'number' ? value : 0;
      };
      const nativeDateNow = Date.now.bind(Date);
      const nativePerformanceNow = performance.now.bind(performance);
      Date.now = () => nativeDateNow() + offset();
      performance.now = () => nativePerformanceNow() + offset();
    }, CLOCK_OFFSET_KEY);
  }

  await page.evaluateOnNewDocument((entries: readonly (readonly [string, string])[]) => {
    for (const [key, value] of entries) localStorage.setItem(key, value);
  }, Object.entries(storage));

  await page.evaluateOnNewDocument((countKey: string) => {
    const Native = window.EventSource;
    let count = 0;
    class CountingEventSource extends Native {
      constructor(url: string | URL, init?: EventSourceInit) {
        count += 1;
        super(url, init);
      }
    }
    Object.defineProperty(window, 'EventSource', { value: CountingEventSource, writable: true });
    Object.defineProperty(window, countKey, { get: () => count });
  }, EVENT_SOURCE_COUNT_KEY);

  return {
    page,
    blocked,
    consoleErrors,
    pageErrors,
    eventSourceCount: () =>
      page.evaluate((countKey: string) => {
        const value: unknown = (window as unknown as Record<string, unknown>)[countKey];
        return typeof value === 'number' ? value : 0;
      }, EVENT_SOURCE_COUNT_KEY),
    setClockOffset: async (offsetMs) => {
      if (options.warpClock !== true) throw new Error('e2e: page opened without warpClock');
      await page.evaluate(
        (offsetKey: string, value: number) => {
          (window as unknown as Record<string, unknown>)[offsetKey] = value;
        },
        CLOCK_OFFSET_KEY,
        offsetMs,
      );
    },
    close: () => context.close(),
  };
}

export interface UntilOptions {
  readonly timeoutMs: number;
  /** Named in the failure, so a timeout says what never happened. */
  readonly what: string;
  readonly intervalMs?: number;
}

/**
 * Poll `probe` until it answers something other than `null`/`undefined`/`false`, or
 * fail with `what` after `timeoutMs`. The answer is returned so a probe can both wait
 * for and hand back the thing it found.
 *
 * The deadline bounds the probe too, not only the gaps between probes. A probe is
 * usually a CDP round trip (`page.evaluate`), and one the renderer never answers — a
 * busy or wedged SwiftShader frame — would otherwise hold the loop until puppeteer's
 * own protocol timeout, long past `timeoutMs`, while the test runner idles. So every
 * probe races the time left (never less than {@link PROBE_GRACE_MS}, so the last probe
 * before the deadline still gets a fair chance to answer); one still pending then fails
 * the wait with `what`, and whatever it settles to later is discarded.
 *
 * A timeout says how the wait went — how many probes answered and the longest stretch
 * between two of them — because a gap far beyond `intervalMs` is the host stalling this
 * process or the page, not the product being late. With a synchronous probe (a log read)
 * such a gap can only be this process not running: its timers overdue by minutes. The
 * CPU time and major page faults it reports across the wait tell which — little CPU and
 * many faults is a process being paged back in from swap, not one busy elsewhere.
 */
export async function until<T>(
  probe: () => T | Promise<T>,
  options: UntilOptions,
): Promise<Exclude<T, null | undefined | false>> {
  const interval = options.intervalMs ?? 100;
  const startedAt = Date.now();
  const deadline = startedAt + options.timeoutMs;
  let probes = 0;
  let lastAnswerAt = startedAt;
  let longestGapMs = 0;
  const cpuAtStart = process.cpuUsage();
  const faultsAtStart = process.resourceUsage().majorPageFault;
  const timedOut = (detail: string): Error => {
    const cpu = process.cpuUsage(cpuAtStart);
    return new Error(
      `e2e: timed out after ${options.timeoutMs} ms waiting for ${options.what}${detail} ` +
        `[${probes} probes answered in ${Date.now() - startedAt} ms, ` +
        `longest gap between answers ${longestGapMs} ms; this process used ` +
        `${Math.round((cpu.user + cpu.system) / 1000)} ms CPU and took ` +
        `${process.resourceUsage().majorPageFault - faultsAtStart} major page faults]`,
    );
  };
  for (;;) {
    const value = await withinDeadline(probe, Math.max(deadline, Date.now() + PROBE_GRACE_MS));
    if (value === PROBE_PENDING) throw timedOut(' (the last probe never answered)');
    const now = Date.now();
    probes += 1;
    longestGapMs = Math.max(longestGapMs, now - lastAnswerAt);
    lastAnswerAt = now;
    if (value !== null && value !== undefined && value !== false) {
      return value as Exclude<T, null | undefined | false>;
    }
    if (now >= deadline) throw timedOut('');
    await new Promise<void>((resolve) => setTimeout(resolve, Math.min(interval, deadline - now)));
  }
}

/** The least time any one probe is given, even when the wait's deadline is nearer. */
const PROBE_GRACE_MS = 5_000;

const PROBE_PENDING: unique symbol = Symbol('probe pending at deadline');

/** One probe, or {@link PROBE_PENDING} if it has not settled by `deadline`. */
async function withinDeadline<T>(
  probe: () => T | Promise<T>,
  deadline: number,
): Promise<T | typeof PROBE_PENDING> {
  const pending = Promise.resolve().then(probe);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expiry = new Promise<typeof PROBE_PENDING>((resolve) => {
    timer = setTimeout(() => resolve(PROBE_PENDING), Math.max(0, deadline - Date.now()));
  });
  try {
    return await Promise.race([pending, expiry]);
  } finally {
    clearTimeout(timer);
    // A probe abandoned at the deadline may still reject (the page closing under it);
    // that late rejection is not this wait's failure and must not surface as unhandled.
    pending.catch(() => undefined);
  }
}
