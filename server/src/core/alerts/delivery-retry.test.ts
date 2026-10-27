import { describe, expect, it } from 'vitest';

import { DELIVERY_PARAMS, type DeliveryRetryParams } from '../config/delivery-params.js';
import {
  afterFailedAttempt,
  assertRetryParams,
  RETRY_EXHAUSTED_PREFIX,
  retryDelayMs,
} from './delivery-retry.js';

const RETRY = DELIVERY_PARAMS.values.retry;
const NOW = Date.UTC(2026, 9, 27, 12, 0, 0);

describe('retryDelayMs', () => {
  it('doubles from the base, up to the cap, when there is no jitter', () => {
    const noJitter: DeliveryRetryParams = { ...RETRY, jitterRatio: 0 };
    expect([1, 2, 3, 4, 5, 6, 7].map((n) => retryDelayMs(n, noJitter, 0))).toEqual([
      20_000, 40_000, 80_000, 160_000, 320_000, 600_000, 600_000,
    ]);
  });

  it('keeps every jittered wait between (1 - jitterRatio) and 1 times the nominal one', () => {
    expect(retryDelayMs(3, RETRY, 0)).toBe(40_000);
    expect(retryDelayMs(3, RETRY, 0.5)).toBe(60_000);
    expect(retryDelayMs(3, RETRY, 0.999_999)).toBeLessThanOrEqual(80_000);
    expect(retryDelayMs(3, RETRY, 0.999_999)).toBeGreaterThan(79_000);
  });

  it('is deterministic in its inputs', () => {
    expect(retryDelayMs(4, RETRY, 0.37)).toBe(retryDelayMs(4, RETRY, 0.37));
  });

  it('stays finite for an absurd attempt count', () => {
    expect(retryDelayMs(10_000, RETRY, 0.5)).toBe(450_000);
  });

  it('refuses an attempt below 1 and a draw outside [0, 1)', () => {
    expect(() => retryDelayMs(0, RETRY, 0.5)).toThrow(RangeError);
    expect(() => retryDelayMs(1, RETRY, 1)).toThrow(RangeError);
    expect(() => retryDelayMs(1, RETRY, -0.1)).toThrow(RangeError);
    expect(() => retryDelayMs(1, RETRY, Number.NaN)).toThrow(RangeError);
  });
});

describe('afterFailedAttempt', () => {
  it('retries after the backoff until the last allowed attempt, then gives up', () => {
    const decisions = [0, 1, 2, 3, 4, 5].map((previousAttempts) =>
      afterFailedAttempt({
        previousAttempts,
        error: 'HTTP 503',
        now: NOW,
        random: 0,
        params: RETRY,
      }),
    );
    expect(decisions.slice(0, 5)).toEqual([
      { action: 'retry', attempts: 1, notBefore: NOW + 10_000 },
      { action: 'retry', attempts: 2, notBefore: NOW + 20_000 },
      { action: 'retry', attempts: 3, notBefore: NOW + 40_000 },
      { action: 'retry', attempts: 4, notBefore: NOW + 80_000 },
      { action: 'retry', attempts: 5, notBefore: NOW + 160_000 },
    ]);
    expect(decisions[5]).toEqual({
      action: 'give_up',
      attempts: RETRY.maxAttempts,
      error: `${RETRY_EXHAUSTED_PREFIX}:HTTP 503`,
    });
  });

  it('gives up on a row already past the cap (the cap was lowered under it)', () => {
    expect(
      afterFailedAttempt({ previousAttempts: 40, error: 'x', now: NOW, random: 0, params: RETRY })
        .action,
    ).toBe('give_up');
  });

  it('gives up on the first failure when only one attempt is allowed', () => {
    const once = { ...RETRY, maxAttempts: 1 };
    expect(
      afterFailedAttempt({ previousAttempts: 0, error: 'x', now: NOW, random: 0, params: once }),
    ).toEqual({ action: 'give_up', attempts: 1, error: `${RETRY_EXHAUSTED_PREFIX}:x` });
  });

  it('refuses a negative attempt count and a non-finite clock', () => {
    const input = { error: 'x', random: 0, params: RETRY };
    expect(() => afterFailedAttempt({ ...input, previousAttempts: -1, now: NOW })).toThrow(
      RangeError,
    );
    expect(() => afterFailedAttempt({ ...input, previousAttempts: 0, now: Number.NaN })).toThrow(
      RangeError,
    );
  });
});

describe('assertRetryParams', () => {
  it('accepts the shipped schedule', () => {
    expect(() => {
      assertRetryParams(RETRY);
    }).not.toThrow();
  });

  it.each<[string, Partial<DeliveryRetryParams>]>([
    ['no attempt at all', { maxAttempts: 0 }],
    ['a fractional attempt count', { maxAttempts: 2.5 }],
    ['a zero base', { baseDelaySeconds: 0 }],
    ['a cap below the base', { maxDelaySeconds: 10 }],
    ['jitter above 1', { jitterRatio: 1.5 }],
    ['negative jitter', { jitterRatio: -0.1 }],
  ])('refuses %s', (_name, override) => {
    expect(() => {
      assertRetryParams({ ...RETRY, ...override });
    }).toThrow(RangeError);
  });
});

describe('delivery_params_v2 retry schedule', () => {
  it('ships the numbers the founder reviews, and they fit inside D6', () => {
    expect(RETRY).toEqual({
      maxAttempts: 6,
      baseDelaySeconds: 20,
      maxDelaySeconds: 600,
      jitterRatio: 0.5,
    });
    // The longest a row can back off in total before it is closed: every wait at nominal.
    let longestMs = 0;
    for (let attempt = 1; attempt < RETRY.maxAttempts; attempt += 1) {
      longestMs += retryDelayMs(attempt, { ...RETRY, jitterRatio: 0 }, 0);
    }
    expect(longestMs / 1000).toBeLessThan(DELIVERY_PARAMS.values.channelTtlSeconds.push);
    expect(RETRY.maxDelaySeconds).toBeLessThanOrEqual(DELIVERY_PARAMS.values.queueAgePageSeconds);
  });
});
