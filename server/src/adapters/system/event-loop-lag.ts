/**
 * Event-loop lag, as the demotion controller wants it (ADR-003 A1.1 trigger 2): the p99
 * of the loop's delay over the interval since the previous reading, in milliseconds.
 *
 * Built on `perf_hooks.monitorEventLoopDelay`, which runs a libuv timer at `resolution`
 * and records the elapsed time between its firings. That elapsed time *includes* the
 * resolution itself — an idle loop reads as `resolution`, not zero — so the sampler
 * subtracts it and reports the excess, which is the lag. Each reading resets the
 * histogram, so the p99 is of the window between two calls and a stall an hour ago
 * cannot keep this reading above the threshold.
 */

import { monitorEventLoopDelay } from 'node:perf_hooks';

/**
 * Fine enough that a 200 ms stall is unmistakable, coarse enough that the timer itself
 * costs nothing. Node's default is 10 ms.
 */
export const DEFAULT_RESOLUTION_MS = 20;

const NS_PER_MS = 1_000_000;

export interface EventLoopLagSampler {
  /**
   * The p99 lag since the previous call, in ms — or `null` when the histogram recorded
   * nothing in that time (the first call, or a call sooner than one resolution).
   */
  sampleP99Ms(): number | null;
  /** Stops the underlying timer. The sampler answers `null` from then on. */
  stop(): void;
}

/**
 * The slice of `perf_hooks.IntervalHistogram` the sampler reads — named so a test can
 * hand in a histogram whose recordings it chooses, instead of trying to make a real
 * libuv timer fire on cue on a host it does not control.
 */
export interface LoopDelayHistogram {
  readonly count: number;
  /** In nanoseconds, as `IntervalHistogram` reports it. */
  percentile(percentile: number): number;
  enable(): boolean;
  disable(): boolean;
  reset(): void;
}

export type LoopDelayMonitor = (options: { resolution: number }) => LoopDelayHistogram;

export function createEventLoopLagSampler(
  resolutionMs = DEFAULT_RESOLUTION_MS,
  monitor: LoopDelayMonitor = monitorEventLoopDelay,
): EventLoopLagSampler {
  const histogram = monitor({ resolution: resolutionMs });
  histogram.enable();

  return {
    sampleP99Ms() {
      if (histogram.count === 0) return null;
      const p99Ms = histogram.percentile(99) / NS_PER_MS;
      histogram.reset();
      return Math.max(0, p99Ms - resolutionMs);
    },
    stop() {
      histogram.disable();
      histogram.reset();
    },
  };
}
