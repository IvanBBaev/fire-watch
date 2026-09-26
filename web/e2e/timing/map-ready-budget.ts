/**
 * CI-12's timing half as data: what "map-ready ≤ 6 s on 4G / ≤ 15 s on 3G" (08 §5.5.2,
 * IMPLEMENTATION-PLAN WP4 DoD, ADR-005) is measured against, in one table the gate reads
 * and nothing else restates. A changed budget, profile or device is a diff to this file.
 *
 * **The metric.** `fw:map-ready` (`web/src/map/map-controller.ts`): the first MapLibre
 * `idle` frame rendered after a non-empty snapshot reached the fire source — style loaded,
 * every requested basemap tile in, the fire layer painted. That is 08 §5.5.2's definition
 * ("basemap tiles + fire layer painted"), read as `startTime`, i.e. milliseconds since the
 * navigation's time origin in the page's own clock. Cold cache, first visit.
 *
 * **The networks.** Chrome DevTools' request-level presets, copied here byte for byte
 * (`puppeteer-core` `PredefinedNetworkConditions`, itself aligned with DevTools'
 * `NetworkManager.ts`; a unit test fails if they drift apart):
 *
 *   * 4G = **"Fast 4G"**: 9 Mbit/s × 0.9 down, 1.5 Mbit/s × 0.9 up, 60 ms × 2.75 = 165 ms
 *     per request. 08 §5.5.2's "good 4G" is 9 Mbit/s — the same link.
 *   * 3G = **"Fast 3G"** (DevTools and Lighthouse also call it "Slow 4G"): 1.6 Mbit/s × 0.9
 *     down, 750 kbit/s × 0.9 up, 150 ms × 3.75 = 562.5 ms per request. 08 §5.5.2's "rural 3G"
 *     is 1.6 Mbit/s at 300 ms RTT; CDP applies latency once per request rather than per
 *     round trip, which is what the × 3.75 compensates for, and 562.5 ms is above 300 ms, so
 *     the gate errs on the slow side. DevTools' "Slow 3G" (400 kbit/s, 2 s) is a different,
 *     much worse link than the one the budget was written for, and is not used.
 *
 *   The multipliers are DevTools' own: CDP throttles whole requests, not packets, so raw
 *   link numbers would understate a real link's slow start and per-packet RTT.
 *
 * **The device.** 08 §5.5.2's reference is a €150-class Android. Emulated as Lighthouse
 * emulates its mobile reference: a 412 × 823 CSS-px viewport at DPR 1.75 with touch, and a
 * CPU slowed 4× relative to a fast desktop. "Relative to a fast desktop" is the part a
 * loaded or slow host breaks, so the slowdown is *calibrated* per run rather than fixed:
 * a fixed JS workload is timed in the browser just before each run, and the throttle rate
 * is `targetBenchmarkMs / measured`, clamped to `[1, maxRate]`. On an idle fast host that is
 * ≈ 4×; on a host already slowed 2× by other work it is ≈ 2×, so the page sees the same
 * effective CPU either way. A host slower than the reference device itself cannot be
 * slowed *down* to it (rate would fall below 1): that run is discarded as unrepresentative
 * and retried, and a gate that cannot collect enough representative runs fails as
 * inconclusive rather than passing on numbers from the wrong device.
 *
 * **The basemap.** The shipped basemap is a third party (OpenFreeMap) until WP5's own
 * tiles (G1), and a gate must not depend on the network. The harness stands one in: a
 * style with one raster source whose tiles are valid 256 px PNGs padded to a fixed weight,
 * so the viewport's tiles weigh what 08 §5.5.2 says one viewport of real tiles weighs
 * ("≈ 300–600 KB"). Bytes on the wire are represented; vector-tile parse cost is not.
 * When G1 lands, the stand-in becomes a fixture of real tiles and this note changes.
 *
 * **The verdict.** The median of `runs` representative runs per profile, against the
 * budget. The median rather than the mean because one run disturbed by another process is
 * an outlier, not a signal; the minimum and maximum are reported alongside it.
 */

export interface NetworkProfile {
  /** DevTools' name for the preset, so the report and a DevTools session agree. */
  readonly preset: 'Fast 4G' | 'Fast 3G';
  /** Bytes per second. */
  readonly download: number;
  /** Bytes per second. */
  readonly upload: number;
  /** Milliseconds added to every request. */
  readonly latency: number;
}

export interface MapReadyBudget {
  /** The network 08 §5.5.2 names. */
  readonly id: '4g' | '3g';
  readonly network: NetworkProfile;
  /** Map-ready budget, milliseconds from navigation start (08 §5.5.2). */
  readonly budgetMs: number;
}

export const MAP_READY_BUDGETS: readonly MapReadyBudget[] = [
  {
    id: '4g',
    network: {
      preset: 'Fast 4G',
      download: ((9 * 1000 * 1000) / 8) * 0.9,
      upload: ((1.5 * 1000 * 1000) / 8) * 0.9,
      latency: 60 * 2.75,
    },
    budgetMs: 6_000,
  },
  {
    id: '3g',
    network: {
      preset: 'Fast 3G',
      download: ((1.6 * 1000 * 1000) / 8) * 0.9,
      upload: ((750 * 1000) / 8) * 0.9,
      latency: 150 * 3.75,
    },
    budgetMs: 15_000,
  },
];

/** Lighthouse's mobile reference screen (moto g power): CSS px, DPR, touch. */
export const REFERENCE_VIEWPORT = {
  width: 412,
  height: 823,
  deviceScaleFactor: 1.75,
  isMobile: true,
  hasTouch: true,
} as const;

export const CPU_CALIBRATION = {
  /** Lighthouse's mobile slowdown, relative to the host below when that host is idle. */
  referenceSlowdown: 4,
  /**
   * The calibration workload's time (`map-ready.timing.ts` `benchmark`) on a fast desktop
   * host: measured at 26.5–30 ms, median ≈ 27.5 ms, on an Apple M5 (10 cores) in
   * chrome-headless-shell on 2026-09-25 — with a load average of ≈ 10 from other work, so
   * rounded down to 25 ms as the idle figure. The reference device runs it in
   * `referenceSlowdown` × this = 100 ms. A change to the workload is a change to this.
   */
  fastHostBenchmarkMs: 25,
  /** A rate above this means the host itself is suspect, not fast; it is clamped. */
  maxRate: 8,
  /** Samples per calibration; their median is the host's speed at that moment. */
  samples: 5,
} as const;

/** What the reference device takes for the calibration workload. */
export const TARGET_BENCHMARK_MS =
  CPU_CALIBRATION.referenceSlowdown * CPU_CALIBRATION.fastHostBenchmarkMs;

export const MAP_READY_RUNS = {
  /** Representative runs per profile whose median is the verdict. Odd, so it is one run. */
  runs: 5,
  /** Attempts per profile before the gate gives up as inconclusive. */
  maxAttempts: 12,
  /**
   * How long one run may take before it counts as "never ready", as a multiple of the
   * budget. Generous on purpose: a run slower than its budget is a finding to report with
   * its number, and only a map that never gets ready at all should end on this deadline.
   */
  deadlineBudgetMultiple: 4,
} as const;

/** The stand-in basemap (see the module comment). */
export const STAND_IN_BASEMAP = {
  /** Bytes per raster tile, PNG padding included. */
  tileBytes: 24 * 1024,
  tileSize: 256,
  /** A tile beyond this zoom is never requested; the reference view opens at z5.8. */
  maxzoom: 14,
} as const;
