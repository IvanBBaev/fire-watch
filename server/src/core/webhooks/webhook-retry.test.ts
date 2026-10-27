import { describe, expect, it } from 'vitest';

import { DELIVERY_PARAMS } from '../config/delivery-params.js';
import { WEBHOOK_PARAMS } from '../config/webhook-params.js';
import {
  backoffDelayMs,
  classifyWebhookAttempt,
  nextAttemptDue,
  shouldAutoDisable,
  worstCaseRetrySpanMs,
} from './webhook-retry.js';

const PARAMS = WEBHOOK_PARAMS.values;

describe('classifyWebhookAttempt', () => {
  it('maps HTTP outcomes to delivered, retry, reject and gone', () => {
    expect(classifyWebhookAttempt(200)).toBe('delivered');
    expect(classifyWebhookAttempt(204)).toBe('delivered');
    expect(classifyWebhookAttempt(410)).toBe('gone');
    for (const status of [null, 408, 429, 500, 502, 503, 599]) {
      expect(classifyWebhookAttempt(status), String(status)).toBe('retry');
    }
    for (const status of [301, 302, 400, 401, 403, 404, 413]) {
      expect(classifyWebhookAttempt(status), String(status)).toBe('reject');
    }
  });
});

describe('backoffDelayMs', () => {
  it('doubles the ceiling per attempt up to the maximum, with full jitter', () => {
    const top = () => 0.999_999;
    expect(backoffDelayMs(1, PARAMS, top)).toBe(Math.floor(0.999_999 * 60_000));
    expect(backoffDelayMs(2, PARAMS, top)).toBe(Math.floor(0.999_999 * 120_000));
    expect(backoffDelayMs(20, PARAMS, top)).toBe(Math.floor(0.999_999 * PARAMS.backoffMaxMs));
    expect(backoffDelayMs(3, PARAMS, () => 0)).toBe(0);
    expect(backoffDelayMs(3, PARAMS, () => 0.5)).toBe(120_000);
  });

  it('treats an out-of-range random as zero and refuses a bad attempt number', () => {
    expect(backoffDelayMs(1, PARAMS, () => 1)).toBe(0);
    expect(backoffDelayMs(1, PARAMS, () => Number.NaN)).toBe(0);
    expect(() => backoffDelayMs(0, PARAMS, () => 0)).toThrow(RangeError);
    expect(() => backoffDelayMs(1.5, PARAMS, () => 0)).toThrow(RangeError);
  });
});

describe('the shipped schedule', () => {
  it('finishes every retry before the outbox row expires', () => {
    expect(worstCaseRetrySpanMs(PARAMS)).toBeLessThan(
      DELIVERY_PARAMS.values.queueExpirySeconds * 1000,
    );
  });

  it('sums the un-jittered waits between attempts', () => {
    // 1 + 2 + 4 + 8 + 16 minutes between six attempts.
    expect(worstCaseRetrySpanMs(PARAMS)).toBe(31 * 60_000);
    expect(worstCaseRetrySpanMs({ ...PARAMS, maxAttempts: 1 })).toBe(0);
  });
});

describe('nextAttemptDue', () => {
  it('starts a delivery with attempt 1', () => {
    expect(nextAttemptDue(null, 0, PARAMS)).toEqual({ kind: 'attempt', attempt: 1 });
  });

  it('waits until the scheduled time, then makes the next attempt', () => {
    const previous = { attempt: 2, nextAttemptAt: 5_000 };
    expect(nextAttemptDue(previous, 4_999, PARAMS)).toEqual({ kind: 'wait', untilMs: 5_000 });
    expect(nextAttemptDue(previous, 5_000, PARAMS)).toEqual({ kind: 'attempt', attempt: 3 });
  });

  it('is exhausted at the cap or when the last attempt scheduled none', () => {
    expect(nextAttemptDue({ attempt: PARAMS.maxAttempts, nextAttemptAt: 0 }, 1, PARAMS)).toEqual({
      kind: 'exhausted',
    });
    expect(nextAttemptDue({ attempt: 1, nextAttemptAt: null }, 1, PARAMS)).toEqual({
      kind: 'exhausted',
    });
  });
});

describe('shouldAutoDisable', () => {
  it('disables at the configured count of failures in a row', () => {
    const n = PARAMS.disableAfterConsecutiveFailures;
    expect(shouldAutoDisable(n - 1, PARAMS)).toBe(false);
    expect(shouldAutoDisable(n, PARAMS)).toBe(true);
  });
});
