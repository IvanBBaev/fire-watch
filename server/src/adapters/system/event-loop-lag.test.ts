import { monitorEventLoopDelay, type IntervalHistogram } from 'node:perf_hooks';

import { describe, expect, it } from 'vitest';

import {
  createEventLoopLagSampler,
  type LoopDelayHistogram,
  type LoopDelayMonitor,
} from './event-loop-lag.js';

const NS_PER_MS = 1_000_000;

/**
 * A histogram whose recordings the test writes. `monitorEventLoopDelay` records only
 * when its libuv timer fires, and how many times that happens inside a 30 ms window is
 * up to the OS scheduler: on a host at load average 150 the window can pass with no
 * firing at all, and the reading is `null`. The arithmetic the sampler adds on top —
 * subtract the resolution, reset per reading, go quiet when stopped — is what this file
 * pins, so it is pinned here against recordings that do not depend on the host.
 */
class ScriptedHistogram implements LoopDelayHistogram {
  private delaysNs: number[] = [];
  enabled = false;
  resets = 0;

  /** One timer firing, `delayMs` after the previous one (resolution included). */
  record(delayMs: number): void {
    if (this.enabled) this.delaysNs.push(delayMs * NS_PER_MS);
  }

  get count(): number {
    return this.delaysNs.length;
  }

  percentile(percentile: number): number {
    const sorted = [...this.delaysNs].sort((a, b) => a - b);
    const rank = Math.ceil((percentile / 100) * sorted.length) - 1;
    return sorted[Math.max(0, rank)] ?? 0;
  }

  enable(): boolean {
    const changed = !this.enabled;
    this.enabled = true;
    return changed;
  }

  disable(): boolean {
    const changed = this.enabled;
    this.enabled = false;
    return changed;
  }

  reset(): void {
    this.delaysNs = [];
    this.resets += 1;
  }
}

function scripted(): { histogram: ScriptedHistogram; monitor: LoopDelayMonitor; asked: number[] } {
  const histogram = new ScriptedHistogram();
  const asked: number[] = [];
  return {
    histogram,
    asked,
    monitor: ({ resolution }) => {
      asked.push(resolution);
      return histogram;
    },
  };
}

/** Holds the loop for `ms` — the one way to make lag on purpose. */
function block(ms: number): void {
  const until = performance.now() + ms;
  while (performance.now() < until) {
    // busy
  }
}

function idle(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

describe('createEventLoopLagSampler', () => {
  it('has nothing to report before the first resolution has elapsed', () => {
    const sampler = createEventLoopLagSampler(20);
    try {
      // No loop turn has happened since construction, so no timer can have fired.
      expect(sampler.sampleP99Ms()).toBeNull();
    } finally {
      sampler.stop();
    }
  });

  it('asks for the resolution it was given and starts recording at once', () => {
    const { histogram, monitor, asked } = scripted();
    const sampler = createEventLoopLagSampler(20, monitor);
    expect(asked).toEqual([20]);
    expect(histogram.enabled).toBe(true);
    sampler.stop();
  });

  it('sees a stall of the loop as lag of at least that length, then forgets it', () => {
    const { histogram, monitor } = scripted();
    const sampler = createEventLoopLagSampler(20, monitor);
    // An idle loop fires the timer every resolution; then one firing is held up by a
    // 150 ms stall — the timer that was due during it fires late by the whole stall.
    for (let i = 0; i < 5; i += 1) histogram.record(20);
    histogram.record(20 + 150);

    const stalled = sampler.sampleP99Ms();
    // The resolution is subtracted: the excess over the schedule is the lag.
    expect(stalled).toBe(150);

    // The next window saw only on-time firings: the stall is not carried forward.
    histogram.record(21);
    histogram.record(22);
    const after = sampler.sampleP99Ms();
    expect(after).toBe(2);
    expect(after).toBeLessThan(stalled ?? Number.POSITIVE_INFINITY);
    expect(histogram.resets).toBe(2);
    sampler.stop();
  });

  it('answers null for a window with no firing, without discarding what comes next', () => {
    const { histogram, monitor } = scripted();
    const sampler = createEventLoopLagSampler(20, monitor);
    expect(sampler.sampleP99Ms()).toBeNull();
    expect(histogram.resets).toBe(0);
    histogram.record(20 + 300);
    expect(sampler.sampleP99Ms()).toBe(300);
    sampler.stop();
  });

  it('never reports negative lag for a timer that fired a hair early', () => {
    const { histogram, monitor } = scripted();
    const sampler = createEventLoopLagSampler(20, monitor);
    histogram.record(19.5);
    expect(sampler.sampleP99Ms()).toBe(0);
    sampler.stop();
  });

  it('answers null once stopped, whatever was recorded before', () => {
    const { histogram, monitor } = scripted();
    const sampler = createEventLoopLagSampler(20, monitor);
    histogram.record(20 + 500);
    sampler.stop();
    expect(histogram.enabled).toBe(false);
    histogram.record(20 + 500);
    expect(sampler.sampleP99Ms()).toBeNull();
  });

  it('reads a real stall through the real perf_hooks histogram', async () => {
    // The one wall-clock test: it proves the default monitor is wired and in the units
    // the sampler assumes. Host load can only delay the timer further, so the lower
    // bound holds under any load. What load does change is *when* the timer fires, so
    // the test waits on the histogram's own count instead of assuming a firing lands
    // inside a fixed 30–60 ms window — the assumption that read `null` at load 150.
    let real: IntervalHistogram | undefined;
    const sampler = createEventLoopLagSampler(20, (options) => {
      real = monitorEventLoopDelay(options);
      return real;
    });
    const recorded = (): number => real?.count ?? 0;
    const untilRecorded = async (atLeast: number): Promise<void> => {
      for (let turn = 0; turn < 500 && recorded() < atLeast; turn += 1) await idle(20);
    };
    try {
      // The first firing only sets the baseline; a stall before it would go unseen.
      await untilRecorded(1);
      const before = recorded();
      expect(before).toBeGreaterThan(0);

      block(150);
      await untilRecorded(before + 1);
      const stalled = sampler.sampleP99Ms();
      expect(stalled).not.toBeNull();
      expect(stalled).toBeGreaterThanOrEqual(150 - 20);
    } finally {
      sampler.stop();
    }
  });
});
