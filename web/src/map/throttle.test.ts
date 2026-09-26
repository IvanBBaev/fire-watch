import { describe, expect, it } from 'vitest';

import type { FrameScheduler } from './throttle.js';
import { DEFAULT_FLUSH_INTERVAL_MS, createFrameThrottle } from './throttle.js';

class FakeScheduler implements FrameScheduler {
  private nextHandle = 0;
  readonly pending = new Map<number, () => void>();
  scheduleCalls = 0;
  cancelCalls = 0;

  schedule(callback: () => void): unknown {
    this.scheduleCalls += 1;
    const handle = ++this.nextHandle;
    this.pending.set(handle, callback);
    return handle;
  }

  cancel(handle: unknown): void {
    this.cancelCalls += 1;
    this.pending.delete(handle as number);
  }

  /** Fire every currently pending frame, like one rAF tick. */
  fireFrame(): void {
    const callbacks = [...this.pending.values()];
    this.pending.clear();
    for (const callback of callbacks) callback();
  }
}

class FakeClock {
  now = 0;
  readonly monotonicNow = (): number => this.now;
}

function setup(intervalMs?: number) {
  const scheduler = new FakeScheduler();
  const clock = new FakeClock();
  let flushes = 0;
  const throttle = createFrameThrottle({
    clock,
    scheduler,
    callback: () => {
      flushes += 1;
    },
    ...(intervalMs === undefined ? {} : { intervalMs }),
  });
  return { scheduler, clock, throttle, flushes: () => flushes };
}

describe('createFrameThrottle', () => {
  it('never flushes synchronously — the flush waits for a frame (rAF alignment)', () => {
    const { scheduler, throttle, flushes } = setup();
    throttle.request();
    expect(flushes()).toBe(0);
    scheduler.fireFrame();
    expect(flushes()).toBe(1);
  });

  it('coalesces a burst of requests into a single flush', () => {
    const { scheduler, throttle, flushes } = setup();
    for (let i = 0; i < 50; i += 1) throttle.request();
    scheduler.fireFrame();
    expect(flushes()).toBe(1);
  });

  it('delivers at most one flush per interval under a continuous request stream', () => {
    const { scheduler, clock, throttle, flushes } = setup();
    // Requests every 100 ms for 3 s, a frame fired at every step (like 10 fps rAF).
    for (let t = 0; t <= 3_000; t += 100) {
      clock.now = t;
      throttle.request();
      scheduler.fireFrame();
    }
    // Flushes at t=0, 1000, 2000, 3000 — one per DEFAULT_FLUSH_INTERVAL_MS.
    expect(flushes()).toBe(1 + 3_000 / DEFAULT_FLUSH_INTERVAL_MS);
  });

  it('delivers the trailing call after the cooldown, without a new request', () => {
    const { scheduler, clock, throttle, flushes } = setup();
    throttle.request();
    scheduler.fireFrame(); // leading flush at t=0
    expect(flushes()).toBe(1);

    clock.now = 200;
    throttle.request(); // inside the cooldown — must not flush yet
    scheduler.fireFrame();
    expect(flushes()).toBe(1);

    // No further request()s: the pending flush keeps re-arming frame by frame …
    for (const t of [400, 700, 999]) {
      clock.now = t;
      scheduler.fireFrame();
      expect(flushes()).toBe(1);
    }
    // … and lands on the first frame past the interval.
    clock.now = 1_000;
    scheduler.fireFrame();
    expect(flushes()).toBe(2);
  });

  it('goes idle after a flush — no self-rescheduling without a request', () => {
    const { scheduler, throttle } = setup();
    throttle.request();
    scheduler.fireFrame();
    expect(scheduler.pending.size).toBe(0);
  });

  it('respects a custom interval', () => {
    const { scheduler, clock, throttle, flushes } = setup(500);
    throttle.request();
    scheduler.fireFrame(); // flush at t=0
    clock.now = 250;
    throttle.request();
    scheduler.fireFrame(); // cooling down
    expect(flushes()).toBe(1);
    clock.now = 500;
    scheduler.fireFrame();
    expect(flushes()).toBe(2);
  });

  it('dispose cancels the pending frame and drops later requests', () => {
    const { scheduler, throttle, flushes } = setup();
    throttle.request();
    throttle.dispose();
    expect(scheduler.cancelCalls).toBe(1);
    expect(scheduler.pending.size).toBe(0);

    throttle.request();
    scheduler.fireFrame();
    expect(flushes()).toBe(0);
  });

  it('dispose is safe to call twice and mid-cooldown', () => {
    const { scheduler, clock, throttle, flushes } = setup();
    throttle.request();
    scheduler.fireFrame();
    clock.now = 300;
    throttle.request(); // pending trailing flush
    throttle.dispose();
    throttle.dispose();
    clock.now = 2_000;
    scheduler.fireFrame();
    expect(flushes()).toBe(1); // only the pre-dispose flush
  });

  it('a request made during the flush schedules the next cycle', () => {
    const scheduler = new FakeScheduler();
    const clock = new FakeClock();
    let flushes = 0;
    const throttle = createFrameThrottle({
      clock,
      scheduler,
      callback: () => {
        flushes += 1;
        if (flushes === 1) throttle.request(); // re-entrant: data changed mid-flush
      },
    });

    throttle.request();
    scheduler.fireFrame(); // flush 1; re-entrant request re-armed a frame
    expect(scheduler.pending.size).toBe(1);

    clock.now = DEFAULT_FLUSH_INTERVAL_MS;
    scheduler.fireFrame();
    expect(flushes).toBe(2);
  });
});
