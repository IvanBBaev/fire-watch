import { describe, expect, it } from 'vitest';

import { createTokenBucket } from './token-bucket.js';

function manualClock(start = 1_758_200_000_000) {
  let now = start;
  return {
    now: () => now,
    advance(ms: number): void {
      now += ms;
    },
  };
}

describe('createTokenBucket', () => {
  it('rejects a rate or burst that could never pace anything', () => {
    const clock = manualClock();
    expect(() => createTokenBucket({ ratePerSecond: 0, now: clock.now })).toThrow(RangeError);
    expect(() => createTokenBucket({ ratePerSecond: -5, now: clock.now })).toThrow(RangeError);
    expect(() => createTokenBucket({ ratePerSecond: Number.NaN, now: clock.now })).toThrow(
      RangeError,
    );
    expect(() => createTokenBucket({ ratePerSecond: 10, burst: 0, now: clock.now })).toThrow(
      RangeError,
    );
    expect(() => createTokenBucket({ ratePerSecond: 10, burst: 1.5, now: clock.now })).toThrow(
      RangeError,
    );
  });

  it('starts full and allows a burst of exactly `burst` sends before pacing', () => {
    const clock = manualClock();
    const bucket = createTokenBucket({ ratePerSecond: 25, burst: 25, now: clock.now });

    for (let i = 0; i < 25; i += 1) {
      expect(bucket.take()).toEqual({ ok: true });
    }
    const denied = bucket.take();
    expect(denied.ok).toBe(false);
    // 25/s is 40 ms per token; the bucket is empty so a full token is 40 ms away.
    expect(denied).toEqual({ ok: false, waitMs: 40 });
  });

  it('defaults burst to one second of tokens', () => {
    const clock = manualClock();
    expect(createTokenBucket({ ratePerSecond: 300, now: clock.now }).burst).toBe(300);
    expect(createTokenBucket({ ratePerSecond: 12, now: clock.now }).burst).toBe(12);
    // A sub-1/s rate still gets one token of capacity, or it could never send at all.
    expect(createTokenBucket({ ratePerSecond: 0.5, now: clock.now }).burst).toBe(1);
  });

  it('refills fractionally and the promised wait is exactly enough', () => {
    const clock = manualClock();
    const bucket = createTokenBucket({ ratePerSecond: 10, burst: 1, now: clock.now });

    expect(bucket.take()).toEqual({ ok: true });
    clock.advance(30); // 0.3 of a token
    const denied = bucket.take();
    expect(denied).toEqual({ ok: false, waitMs: 70 });
    clock.advance(69);
    expect(bucket.take().ok).toBe(false);
    clock.advance(1);
    expect(bucket.take()).toEqual({ ok: true });
  });

  it('never promises a zero wait, because a zero wait is a spin', () => {
    const clock = manualClock();
    const bucket = createTokenBucket({ ratePerSecond: 1000, burst: 1, now: clock.now });
    expect(bucket.take()).toEqual({ ok: true });
    // 1000/s is 1 ms per token, and 0.999 of it has refilled — ceil gives 1, not 0.
    const denied = bucket.take();
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.waitMs).toBeGreaterThanOrEqual(1);
  });

  it('caps the refill at burst: an idle hour does not bank an hour of sends', () => {
    const clock = manualClock();
    const bucket = createTokenBucket({ ratePerSecond: 12, burst: 12, now: clock.now });
    clock.advance(3_600_000);
    expect(bucket.level()).toBe(12);
    for (let i = 0; i < 12; i += 1) expect(bucket.take().ok).toBe(true);
    expect(bucket.take().ok).toBe(false);
  });

  it('sustains the configured rate over a long run', () => {
    const clock = manualClock();
    const bucket = createTokenBucket({ ratePerSecond: 25, burst: 25, now: clock.now });
    let sent = 0;
    // Try every millisecond for ten seconds: 25 burst + 25/s × 10 s. The last token of
    // the run lands on the boundary, and a millisecond of fractional refill either side
    // of it is float noise, not a pacing bug — hence the one-token tolerance.
    for (let ms = 0; ms < 10_000; ms += 1) {
      if (bucket.take().ok) sent += 1;
      clock.advance(1);
    }
    expect(sent).toBeGreaterThanOrEqual(25 + 249);
    expect(sent).toBeLessThanOrEqual(25 + 250);
  });

  it('ignores a clock that went backwards rather than refunding tokens', () => {
    let now = 1_758_200_000_000;
    const bucket = createTokenBucket({ ratePerSecond: 10, burst: 2, now: () => now });
    expect(bucket.take().ok).toBe(true);
    expect(bucket.take().ok).toBe(true);
    now -= 5_000;
    expect(bucket.take().ok).toBe(false);
    expect(bucket.level()).toBe(0);
  });
});
