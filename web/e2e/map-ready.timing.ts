/**
 * CI-12's timing half — map-ready ≤ 6 s on 4G and ≤ 15 s on 3G (docs/GATES.md CI-12,
 * docs/TASKS.md F8, review 08 §5.5.2).
 *
 * The built app (`web/dist`), served by the e2e harness origin with the shipped fixture as a
 * fresh snapshot, opened cold — a new browser context per run, so no HTTP cache, no service
 * worker, no storage beyond a returning reader's two keys — on the reference device under
 * the reference network, until the app marks `fw:map-ready`: basemap tiles in and the fire
 * layer painted. Every number this gate uses (profiles, budgets, device, run count, the
 * stand-in basemap's weight) is data in `timing/map-ready-budget.ts`, with why it is that
 * number; the arithmetic is `timing/map-ready-stats.ts`, unit-tested apart.
 *
 * One run:
 *   1. a fresh context and page at the reference viewport;
 *   2. **CPU calibration** on the blank page: the calibration workload is timed, and the CDP
 *      CPU throttle is set to what makes *this host, now* run it in the reference device's
 *      time. A host too slow to represent the device is skipped and retried, never counted;
 *   3. the workload is timed again under the throttle, and reported, so the log shows the
 *      device the page actually got;
 *   4. the network throttle (a DevTools preset) is applied, and the app is navigated to;
 *   5. the gate waits for the mark with a generous deadline (a multiple of the budget). A
 *      map that reports `fw:map-unavailable`, or never marks ready by the deadline, fails
 *      the gate at once with the page's failed requests and errors — that is a defect, not
 *      a slow run, and a slow run is only ever judged by the median;
 *   6. the mark must prove its own claim: the page opted in to the map-ready probe
 *      (`src/map/map-ready-probe.ts`), so the mark's detail says how many in-view fire
 *      events the frame should show and how many `fire-dot` actually rendered. A missing
 *      layer, an empty viewport or one unrendered in-view event fails the gate at once —
 *      a ready mark over a map without fires is a false reading, not a fast one.
 *
 * The verdict per profile is the median of the representative runs against the budget;
 * every run is printed. The mark's `startTime` is measured in the page's own clock from
 * navigation start, so the harness's own latency in noticing it does not count.
 */

import { fileURLToPath } from 'node:url';

import type { Browser, Page } from 'puppeteer-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { DEFAULT_CONFIG } from '../src/core/config.js';
import { LOCALE_STORAGE_KEY } from '../src/core/i18n/locale.js';
import {
  MAP_READY_PROBE_KEY,
  isMapReadyProbe,
  mapReadyProbeDefect,
} from '../src/map/map-ready-probe.js';
import { ONBOARDING_DONE_VALUE, ONBOARDING_STORAGE_KEY } from '../src/ui/logic/onboarding.js';
import { launchBrowser } from './harness/browser.js';
import { loadFixtureSnapshot } from './harness/fixture.js';
import { startOrigin } from './harness/origin.js';
import type { HarnessOrigin } from './harness/origin.js';
import { openInstrumentedPage, until } from './harness/page.js';
import { startStandInBasemap } from './harness/stand-in-basemap.js';
import type { StandInBasemap } from './harness/stand-in-basemap.js';
import {
  CPU_CALIBRATION,
  MAP_READY_BUDGETS,
  MAP_READY_RUNS,
  REFERENCE_VIEWPORT,
  STAND_IN_BASEMAP,
  TARGET_BENCHMARK_MS,
} from './timing/map-ready-budget.js';
import type { MapReadyBudget } from './timing/map-ready-budget.js';
import { calibrateCpu, formatReport, median, verdict } from './timing/map-ready-stats.js';
import type { TimingRun } from './timing/map-ready-stats.js';

const DIST_DIR = fileURLToPath(new URL('../dist/', import.meta.url));

const STORAGE: Readonly<Record<string, string>> = {
  [ONBOARDING_STORAGE_KEY]: ONBOARDING_DONE_VALUE,
  [LOCALE_STORAGE_KEY]: 'en',
};

const MAP_READY_MARK = 'fw:map-ready';
const MAP_UNAVAILABLE_MARK = 'fw:map-unavailable';
/** Reported beside map-ready, so a slow run shows where its time went. */
const REPORTED_MARKS = ['first-contentful-paint', 'fw:snapshot-applied', 'fw:map-idle'] as const;

/**
 * The median of `samples` timings of the calibration workload in `page`, in ms.
 *
 * The workload — integer hashing, allocation and a sort, the kinds of work a cold start
 * does in script — is fixed in size, so its duration is a reading of the CPU alone. It is
 * defined inside the evaluated function because that function is serialised into the page.
 * `fastHostBenchmarkMs` in the budget data is this workload's time on an idle fast host; a
 * change to the workload is a change to that number.
 */
async function benchmark(page: Page, samples: number): Promise<number> {
  const timings = await page.evaluate((count: number) => {
    const workload = (): number => {
      const values: number[] = [];
      let hash = 0;
      for (let index = 0; index < 150_000; index += 1) {
        hash = (Math.imul(hash, 31) + index) | 0;
        values.push(hash);
      }
      values.sort((a, b) => a - b);
      return values[0] ?? 0;
    };
    workload(); // warm-up: compile once, so every sample times the same code
    const out: number[] = [];
    for (let sample = 0; sample < count; sample += 1) {
      const start = performance.now();
      workload();
      out.push(performance.now() - start);
    }
    return out;
  }, samples);
  return median(timings);
}

let browser: Browser;
let origin: HarnessOrigin;
let basemap: StandInBasemap;

beforeAll(async () => {
  browser = await launchBrowser();
  origin = await startOrigin({
    distDir: DIST_DIR,
    fixture: await loadFixtureSnapshot(),
    advertiseStaticCopy: false,
    staleByMs: 0,
  });
  origin.setScenario('fresh');
  basemap = await startStandInBasemap(STAND_IN_BASEMAP);
});

afterAll(async () => {
  await browser?.close();
  await origin?.close();
  await basemap?.close();
});

type Attempt =
  | { readonly kind: 'run'; readonly run: TimingRun }
  | { readonly kind: 'skipped'; readonly reason: string };

async function attempt(budget: MapReadyBudget): Promise<Attempt> {
  const rewrite = Object.fromEntries(
    Object.values(DEFAULT_CONFIG.basemapStyleUrl).map((url) => [url, basemap.styleUrl]),
  );
  const instrumented = await openInstrumentedPage(browser, origin.baseUrl, STORAGE, {
    extraOrigins: [basemap.baseUrl],
    rewrite,
  });
  try {
    const { page } = instrumented;
    // What went wrong on the wire, for the failure message of a map that never gets ready.
    const failedRequests: string[] = [];
    page.on('requestfailed', (request) => {
      failedRequests.push(`${request.url()} ${request.failure()?.errorText ?? ''}`.trim());
    });
    page.on('response', (response) => {
      if (response.status() >= 400) failedRequests.push(`${response.url()} ${response.status()}`);
    });
    await page.setViewport(REFERENCE_VIEWPORT);

    const hostBenchmarkMs = await benchmark(page, CPU_CALIBRATION.samples);
    const cpu = calibrateCpu(hostBenchmarkMs, TARGET_BENCHMARK_MS, CPU_CALIBRATION.maxRate);
    if (!cpu.representative) return { kind: 'skipped', reason: cpu.reason };
    await page.emulateCPUThrottling(cpu.rate);
    const throttledBenchmarkMs = await benchmark(page, CPU_CALIBRATION.samples);

    // Opt in to the map-ready probe, so the mark carries evidence of painted fires.
    await page.evaluateOnNewDocument((key: string) => {
      (globalThis as unknown as Record<string, unknown>)[key] = true;
    }, MAP_READY_PROBE_KEY);

    const { preset: _preset, ...conditions } = budget.network;
    await page.emulateNetworkConditions(conditions);

    const deadlineMs = budget.budgetMs * MAP_READY_RUNS.deadlineBudgetMultiple;
    await page.goto(origin.baseUrl + '/', { waitUntil: 'domcontentloaded', timeout: deadlineMs });

    const outcome = await until(
      () =>
        page.evaluate(
          (ready: string, unavailable: string) => {
            if (performance.getEntriesByName(unavailable).length > 0) return 'unavailable';
            const entry = performance.getEntriesByName(ready)[0];
            return entry === undefined ? null : entry.startTime;
          },
          MAP_READY_MARK,
          MAP_UNAVAILABLE_MARK,
        ),
      { timeoutMs: deadlineMs, what: MAP_READY_MARK, intervalMs: 250 },
    ).catch((error: unknown) => {
      if (error instanceof Error && error.message.includes('timed out')) return 'never' as const;
      throw error;
    });
    // Neither is a slow run: it is a map that cannot get ready at all, so the gate stops
    // on the first one with what the page said, instead of spending N deadlines on it.
    if (outcome === 'unavailable' || outcome === 'never') {
      const what =
        outcome === 'unavailable'
          ? `the map never started (${MAP_UNAVAILABLE_MARK})`
          : `no ${MAP_READY_MARK} within ${deadlineMs} ms`;
      throw new Error(
        `map-ready ${budget.id}: ${what}\n` +
          `  failed requests: ${failedRequests.join(' | ') || 'none'}\n` +
          `  console errors: ${instrumented.consoleErrors.join(' | ') || 'none'}\n` +
          `  page errors: ${instrumented.pageErrors.join(' | ') || 'none'}`,
      );
    }

    // A ready mark over a frame without fires is not a fast run, it is a false one: the
    // budget covers "fire layer painted", so an unpainted layer fails the gate at once.
    const probe: unknown = await page.evaluate(
      (ready: string): unknown =>
        (performance.getEntriesByName(ready)[0] as PerformanceMark).detail,
      MAP_READY_MARK,
    );
    const defect = isMapReadyProbe(probe)
      ? mapReadyProbeDefect(probe)
      : `the ${MAP_READY_MARK} mark carries no probe (${JSON.stringify(probe)})`;
    if (defect !== null) {
      throw new Error(
        `map-ready ${budget.id}: marked ready at ${Math.round(outcome)} ms but ${defect}\n` +
          `  console errors: ${instrumented.consoleErrors.join(' | ') || 'none'}\n` +
          `  page errors: ${instrumented.pageErrors.join(' | ') || 'none'}`,
      );
    }

    const marks = await page.evaluate((names: readonly string[]) => {
      const out: Record<string, number | null> = {};
      for (const name of names)
        out[name] = performance.getEntriesByName(name)[0]?.startTime ?? null;
      return out;
    }, REPORTED_MARKS);

    return {
      kind: 'run',
      run: {
        mapReadyMs: outcome,
        cpuRate: cpu.rate,
        hostBenchmarkMs,
        marks: { ...marks, 'throttled bench': throttledBenchmarkMs },
      },
    };
  } finally {
    await instrumented.close();
  }
}

describe('CI-12 timing: map-ready on the reference device', () => {
  for (const budget of MAP_READY_BUDGETS) {
    it(`reaches map-ready within ${budget.budgetMs} ms on ${budget.network.preset} (median of ${MAP_READY_RUNS.runs})`, async () => {
      const runs: TimingRun[] = [];
      const skipped: string[] = [];
      const tilesBefore = basemap.tileRequests.length;
      for (
        let index = 0;
        index < MAP_READY_RUNS.maxAttempts && runs.length < MAP_READY_RUNS.runs;
        index += 1
      ) {
        const result = await attempt(budget);
        if (result.kind === 'run') runs.push(result.run);
        else skipped.push(result.reason);
      }
      if (runs.length < MAP_READY_RUNS.runs) {
        throw new Error(
          `map-ready ${budget.id}: inconclusive — ${runs.length} of ${MAP_READY_RUNS.runs} ` +
            `representative runs in ${MAP_READY_RUNS.maxAttempts} attempts; this host cannot ` +
            `stand in for the reference device:\n  ${skipped.join('\n  ')}`,
        );
      }

      const result = verdict(`${budget.id} (${budget.network.preset})`, budget.budgetMs, runs);
      console.log(formatReport(result, runs, skipped));

      // The basemap the budget includes was actually fetched, not skipped.
      expect(basemap.tileRequests.length).toBeGreaterThan(tilesBefore);
      expect(result.medianMs, formatReport(result, runs, skipped)).toBeLessThanOrEqual(
        budget.budgetMs,
      );
    });
  }
});
