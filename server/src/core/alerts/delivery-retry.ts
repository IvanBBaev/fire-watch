/**
 * What a failed delivery attempt does to its outbox row — retry later, or stop (migration
 * 033; ADR-004 D1, D6; `delivery_params` v2).
 *
 * A failed attempt is one that reached the point of trying and did not deliver: a
 * transient provider error, an adapter that threw, a template that would not render.
 * The *n*-th one either schedules the row's next claim after an exponentially growing,
 * jittered wait ({@link retryDelayMs}), or — once `n` reaches `maxAttempts` — closes the
 * row `failed` with a `retry_exhausted:` error, which is the terminal record of the
 * delivery on the row itself.
 *
 * What is *not* a failed attempt is decided by the gateway, not here: a cool-off release
 * waiting for its second approver, a lease too short to start a send and a claim abandoned
 * because a port was unreachable all release the row without spending a retry.
 *
 * Pure: the clock and the random draw are parameters, so a test — or a replay — gets the
 * same schedule for the same inputs. `Math.random()` is banned in the core; the gateway
 * passes one in.
 */

import type { DeliveryRetryParams } from '../config/delivery-params.js';

/** The `last_error` prefix of a row closed because it ran out of attempts. */
export const RETRY_EXHAUSTED_PREFIX = 'retry_exhausted';

/** The `last_error` prefix of an attempt whose template threw while rendering. */
export const RENDER_FAILED_PREFIX = 'render_failed';

export type RetryDecision =
  | {
      readonly action: 'retry';
      /** The row's failed attempts, this one included. */
      readonly attempts: number;
      /** Epoch ms: the row may not be claimed before this. */
      readonly notBefore: number;
    }
  | {
      readonly action: 'give_up';
      readonly attempts: number;
      /** `retry_exhausted:<the last error>`, for `last_error`. */
      readonly error: string;
    };

/** Throws unless the schedule can produce a finite, positive wait and at least one try. */
export function assertRetryParams(params: DeliveryRetryParams): void {
  const { maxAttempts, baseDelaySeconds, maxDelaySeconds, jitterRatio } = params;
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1) {
    throw new RangeError(`maxAttempts must be a positive integer, got ${String(maxAttempts)}`);
  }
  if (!Number.isFinite(baseDelaySeconds) || baseDelaySeconds <= 0) {
    throw new RangeError(`baseDelaySeconds must be positive, got ${String(baseDelaySeconds)}`);
  }
  if (!Number.isFinite(maxDelaySeconds) || maxDelaySeconds < baseDelaySeconds) {
    throw new RangeError(
      `maxDelaySeconds (${String(maxDelaySeconds)}) must be at least baseDelaySeconds ` +
        `(${String(baseDelaySeconds)})`,
    );
  }
  if (!Number.isFinite(jitterRatio) || jitterRatio < 0 || jitterRatio > 1) {
    throw new RangeError(`jitterRatio must lie in [0, 1], got ${String(jitterRatio)}`);
  }
}

/**
 * The wait after the `attempt`-th failed attempt (1-based), in ms:
 * `nominal × (1 − jitterRatio × (1 − random))`, where
 * `nominal = min(base × 2^(attempt−1), max)`. `random` is a draw in [0, 1): 0 gives the
 * shortest wait the jitter allows, and the wait never exceeds `nominal`.
 */
export function retryDelayMs(attempt: number, params: DeliveryRetryParams, random: number): number {
  if (!Number.isSafeInteger(attempt) || attempt < 1) {
    throw new RangeError(`attempt must be a positive integer, got ${String(attempt)}`);
  }
  if (!Number.isFinite(random) || random < 0 || random >= 1) {
    throw new RangeError(`random must be a draw in [0, 1), got ${String(random)}`);
  }
  // Capped before the power can overflow: 2^1023 is finite, 2^1024 is not.
  const doublings = Math.min(attempt - 1, 1023);
  const nominalSeconds = Math.min(params.baseDelaySeconds * 2 ** doublings, params.maxDelaySeconds);
  const factor = 1 - params.jitterRatio * (1 - random);
  return Math.round(nominalSeconds * factor * 1000);
}

/**
 * The row had `previousAttempts` failed attempts before this one failed with `error` at
 * `now`. Retry it after the backoff, or give up.
 */
export function afterFailedAttempt(input: {
  readonly previousAttempts: number;
  readonly error: string;
  readonly now: number;
  readonly random: number;
  readonly params: DeliveryRetryParams;
}): RetryDecision {
  const { previousAttempts, error, now, random, params } = input;
  if (!Number.isSafeInteger(previousAttempts) || previousAttempts < 0) {
    throw new RangeError(
      `previousAttempts must be a non-negative integer, got ${String(previousAttempts)}`,
    );
  }
  if (!Number.isFinite(now)) throw new RangeError(`now must be a finite epoch, got ${String(now)}`);
  const attempts = previousAttempts + 1;
  if (attempts >= params.maxAttempts) {
    return { action: 'give_up', attempts, error: `${RETRY_EXHAUSTED_PREFIX}:${error}` };
  }
  return { action: 'retry', attempts, notBefore: now + retryDelayMs(attempts, params, random) };
}
