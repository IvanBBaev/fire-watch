import { describe, expect, it } from 'vitest';

import { createRateLimiter, DEFAULT_MAX_KEYS } from './rate-limiter.js';

const START = 1_000_000;
const WINDOW_MS = 60_000;

describe('createRateLimiter', () => {
  it('lets exactly the limit through and refuses the next one', () => {
    const limiter = createRateLimiter({ limit: 3, windowMs: WINDOW_MS });

    const decisions = [0, 1, 2, 3].map((n) => limiter.check('1.2.3.4', START + n));

    expect(decisions.map((d) => d.allowed)).toEqual([true, true, true, false]);
    expect(decisions.map((d) => d.remaining)).toEqual([2, 1, 0, 0]);
  });

  it('counts each caller separately, so one scanner cannot lock out the prober', () => {
    // UptimeRobot and Grafana share this endpoint with whoever found it. The external
    // probe going red because of somebody else's loop would be a false page.
    const limiter = createRateLimiter({ limit: 1, windowMs: WINDOW_MS });

    expect(limiter.check('scanner', START).allowed).toBe(true);
    expect(limiter.check('scanner', START).allowed).toBe(false);
    expect(limiter.check('uptimerobot', START).allowed).toBe(true);
  });

  it('forgets the window once it has elapsed', () => {
    const limiter = createRateLimiter({ limit: 1, windowMs: WINDOW_MS });

    expect(limiter.check('caller', START).allowed).toBe(true);
    expect(limiter.check('caller', START + WINDOW_MS - 1).allowed).toBe(false);
    expect(limiter.check('caller', START + WINDOW_MS).allowed).toBe(true);
  });

  it('reports the seconds left, rounded up so a retry is not immediately refused again', () => {
    const limiter = createRateLimiter({ limit: 1, windowMs: WINDOW_MS });

    limiter.check('caller', START);
    expect(limiter.check('caller', START + 30_000).retryAfterSeconds).toBe(30);
    // 999 ms left is one second to a `Retry-After`, never zero.
    expect(limiter.check('caller', START + 59_001).retryAfterSeconds).toBe(1);
  });

  it('keeps refusing for the rest of the window rather than resetting on each attempt', () => {
    // The bug this pins: restarting the window on a refused request would make a caller
    // hammering the endpoint the one caller who is never limited.
    const limiter = createRateLimiter({ limit: 2, windowMs: WINDOW_MS });

    limiter.check('caller', START);
    limiter.check('caller', START);
    for (let elapsed = 0; elapsed < WINDOW_MS; elapsed += 1_000) {
      expect(limiter.check('caller', START + elapsed).allowed).toBe(false);
    }
    expect(limiter.check('caller', START + WINDOW_MS).allowed).toBe(true);
  });

  it('drops the table rather than growing without bound', () => {
    // The key is a client address and the set of client addresses is chosen by strangers.
    // Over-admitting briefly is the accepted cost; unbounded memory on a 2 GB box is not.
    const limiter = createRateLimiter({ limit: 1, windowMs: WINDOW_MS, maxKeys: 4 });

    for (let n = 0; n < 4; n += 1) {
      expect(limiter.check(`caller-${String(n)}`, START).allowed).toBe(true);
    }
    expect(limiter.check('caller-0', START).allowed).toBe(false);

    // The fifth distinct key overflows the table, which resets everyone including caller-0.
    expect(limiter.check('caller-4', START).allowed).toBe(true);
    expect(limiter.check('caller-0', START).allowed).toBe(true);
  });

  it('has a bound even when nobody sets one', () => {
    expect(DEFAULT_MAX_KEYS).toBeGreaterThan(0);
    expect(Number.isInteger(DEFAULT_MAX_KEYS)).toBe(true);
  });

  it('actually enforces the default bound, not merely declares one', () => {
    // The test above would pass with the default mutated to Number.MAX_SAFE_INTEGER — a
    // bound in name only. So exercise it: fill the table to exactly the default, exhaust
    // one key, then let one more brand-new key overflow the table. The overflow must drop
    // everything, which is observable as the just-refused key being admitted again.
    const limiter = createRateLimiter({ limit: 1, windowMs: WINDOW_MS });

    for (let n = 0; n < DEFAULT_MAX_KEYS; n += 1) {
      limiter.check(`caller-${String(n)}`, START);
    }
    expect(limiter.check('caller-0', START).allowed).toBe(false);

    // The (DEFAULT_MAX_KEYS + 1)th distinct key resets everyone, including caller-0.
    expect(limiter.check('one-caller-too-many', START).allowed).toBe(true);
    expect(limiter.check('caller-0', START).allowed).toBe(true);
  });

  it('refuses a configuration that would admit everything or nothing', () => {
    expect(() => createRateLimiter({ limit: 0, windowMs: WINDOW_MS })).toThrow(RangeError);
    expect(() => createRateLimiter({ limit: 1.5, windowMs: WINDOW_MS })).toThrow(
      /positive integer/,
    );
    expect(() => createRateLimiter({ limit: 1, windowMs: 0 })).toThrow(/window/);
  });
});
