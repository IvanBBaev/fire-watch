import { describe, expect, it } from 'vitest';

import type { Clock } from '../ports.js';
import { createServerTimeTracker } from './server-time.js';

const HOUR_MS = 3_600_000;

/** A device clock whose wall-clock and monotonic readings the test controls separately. */
function deviceClock(
  epoch: number,
  monotonic = 0,
): Clock & { setEpoch(next: number): void; setMonotonic(next: number): void } {
  let epochNow = epoch;
  let monotonicNow = monotonic;
  return {
    epochNow: () => epochNow,
    monotonicNow: () => monotonicNow,
    setEpoch: (next) => {
      epochNow = next;
    },
    setMonotonic: (next) => {
      monotonicNow = next;
    },
  };
}

/** An HTTP `Date` header value for the given epoch ms (second resolution, like HTTP). */
function httpDate(epochMs: number): string {
  return new Date(epochMs).toUTCString();
}

const DEVICE_EPOCH = Date.parse('2026-08-09T10:00:00Z');

describe('createServerTimeTracker', () => {
  it('reads the device clock before the first sample — never invents an offset', () => {
    const tracker = createServerTimeTracker(deviceClock(DEVICE_EPOCH));
    expect(tracker.offsetMs()).toBe(0);
    expect(tracker.serverNow()).toBe(DEVICE_EPOCH);
  });

  it('uses the median of the collected samples', () => {
    const tracker = createServerTimeTracker(deviceClock(DEVICE_EPOCH));
    for (const offsetMs of [10_000, 50_000, 30_000, 20_000, 40_000]) {
      tracker.observe({ date: httpDate(DEVICE_EPOCH + offsetMs), age: null }, 0);
    }
    expect(tracker.offsetMs()).toBe(30_000);
    expect(tracker.serverNow()).toBe(DEVICE_EPOCH + 30_000);
  });

  it('averages the two middle samples while the count is even', () => {
    const tracker = createServerTimeTracker(deviceClock(DEVICE_EPOCH));
    tracker.observe({ date: httpDate(DEVICE_EPOCH + 10_000), age: null }, 0);
    tracker.observe({ date: httpDate(DEVICE_EPOCH + 20_000), age: null }, 0);
    expect(tracker.offsetMs()).toBe(15_000);
  });

  it('keeps only the last 5 samples', () => {
    const tracker = createServerTimeTracker(deviceClock(DEVICE_EPOCH));
    // First sample is a huge outlier; five later samples must push it out entirely.
    tracker.observe({ date: httpDate(DEVICE_EPOCH + 12 * HOUR_MS), age: null }, 0);
    for (const offsetMs of [10_000, 10_000, 10_000, 10_000, 10_000]) {
      tracker.observe({ date: httpDate(DEVICE_EPOCH + offsetMs), age: null }, 0);
    }
    expect(tracker.offsetMs()).toBe(10_000);
  });

  it('reports the device clock while the estimate is within 2 s of it (Date deadband)', () => {
    const tracker = createServerTimeTracker(deviceClock(DEVICE_EPOCH));
    for (const offsetMs of [-1_000, 0, 1_000, -1_000, 1_000]) {
      tracker.observe({ date: httpDate(DEVICE_EPOCH + offsetMs), age: null }, 0);
    }
    expect(tracker.offsetMs()).toBe(0);
    expect(tracker.serverNow()).toBe(DEVICE_EPOCH);
  });

  it('adds the cache Age back onto the stored Date (CDN HIT case)', () => {
    const tracker = createServerTimeTracker(deviceClock(DEVICE_EPOCH));
    // The origin stamped Date 120 s ago; the edge served it with Age: 120. Server "now"
    // is Date + Age = device now, so the offset must land in the deadband, not at -120 s.
    tracker.observe({ date: httpDate(DEVICE_EPOCH - 120_000), age: '120' }, 0);
    expect(tracker.offsetMs()).toBe(0);
  });

  it('adds half the measured rtt to the server time', () => {
    const tracker = createServerTimeTracker(deviceClock(DEVICE_EPOCH));
    tracker.observe({ date: httpDate(DEVICE_EPOCH + 10_000), age: null }, 10_000);
    expect(tracker.offsetMs()).toBe(15_000);
  });

  it.each([
    ['+6h', 6 * HOUR_MS],
    ['-6h', -6 * HOUR_MS],
  ])(
    'lands serverNow() on server truth with a %s device-clock skew (ADR-003 A1.6)',
    (_label, skewMs) => {
      const serverTruth = Date.parse('2026-08-09T12:00:00Z');
      const clock = deviceClock(serverTruth + skewMs);
      const tracker = createServerTimeTracker(clock);

      for (let i = 0; i < 5; i += 1) {
        tracker.observe({ date: httpDate(serverTruth), age: null }, 0);
      }

      // Date headers carry second resolution; anything under that is exact enough.
      expect(Math.abs(tracker.serverNow() - serverTruth)).toBeLessThan(1_000);
      expect(Math.abs(tracker.offsetMs() + skewMs)).toBeLessThan(1_000);
    },
  );

  it('holds the previous anchors when Date is missing or unparseable', () => {
    const tracker = createServerTimeTracker(deviceClock(DEVICE_EPOCH));
    tracker.observe({ date: httpDate(DEVICE_EPOCH + 10_000), age: null }, 0);
    expect(tracker.offsetMs()).toBe(10_000);

    tracker.observe({ date: null, age: '30' }, 0);
    tracker.observe({ date: 'not-a-date', age: null }, 0);
    expect(tracker.offsetMs()).toBe(10_000);
  });

  it.each(['soon', '-5', '12abc', '1.5', ''])(
    'ignores a garbage Age (%j) instead of poisoning the sample',
    (age) => {
      const tracker = createServerTimeTracker(deviceClock(DEVICE_EPOCH));
      tracker.observe({ date: httpDate(DEVICE_EPOCH + 10_000), age }, 0);
      expect(tracker.offsetMs()).toBe(10_000);
    },
  );

  it('anchors each sample to the monotonic instant it was observed at', () => {
    const clock = deviceClock(DEVICE_EPOCH, 1_000);
    const tracker = createServerTimeTracker(clock);
    tracker.observe({ date: httpDate(DEVICE_EPOCH + 10_000), age: null }, 0);

    // 2 s of monotonic time have passed since the sample: server "now" is 2 s later.
    clock.setMonotonic(3_000);
    expect(tracker.serverNow()).toBe(DEVICE_EPOCH + 12_000);
  });

  it('follows monotonic time between samples, not the device wall clock', () => {
    const clock = deviceClock(DEVICE_EPOCH);
    const tracker = createServerTimeTracker(clock);
    tracker.observe({ date: httpDate(DEVICE_EPOCH + 10_000), age: null }, 0);
    expect(tracker.serverNow()).toBe(DEVICE_EPOCH + 10_000);

    // Elapsed monotonic time advances server "now" one-for-one.
    clock.setMonotonic(5_000);
    expect(tracker.serverNow()).toBe(DEVICE_EPOCH + 15_000);

    // A wall-clock jump on its own (NTP step, manual change, sleep/resume) moves nothing:
    // the device clock contributes no absolute term once there is a sample.
    clock.setEpoch(DEVICE_EPOCH + 6 * HOUR_MS);
    expect(tracker.serverNow()).toBe(DEVICE_EPOCH + 15_000);
    expect(tracker.offsetMs()).toBe(15_000 - 6 * HOUR_MS);
  });

  it('keeps serverNow() on the anchors through a 6 h device skew introduced mid-run', () => {
    const serverTruth = Date.parse('2026-08-09T12:00:00Z');
    const clock = deviceClock(serverTruth, 100_000);
    const tracker = createServerTimeTracker(clock);
    for (let i = 0; i < 3; i += 1) {
      tracker.observe({ date: httpDate(serverTruth), age: null }, 0);
    }

    // The device clock is set 6 h ahead between samples; two more honest samples arrive.
    clock.setEpoch(serverTruth + 6 * HOUR_MS);
    clock.setMonotonic(160_000);
    for (let i = 0; i < 2; i += 1) {
      tracker.observe({ date: httpDate(serverTruth + 60_000), age: null }, 0);
    }

    expect(Math.abs(tracker.serverNow() - (serverTruth + 60_000))).toBeLessThan(1_000);
  });
});
