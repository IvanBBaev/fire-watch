/**
 * A token bucket with an injected clock — the pacing primitive behind ADR-004 D6's
 * per-channel send rates.
 *
 * Nothing here knows what a token is spent on. The bucket answers one question, "may I
 * send now, and if not, how long until I may?", and leaves what to do with a "no" to
 * {@link createRateLimitedChannel}, which is the only caller. It is a separate module so
 * that the arithmetic — fractional refill, a burst ceiling, a wait that is never
 * shorter than the refill it is waiting for — can be pinned by a test that never sleeps.
 *
 * Deliberately not a pause/backoff store: a provider's `Retry-After` is a fact about the
 * provider (and for web push about one push-service *host*, 04-sre §5), so it lives in
 * the adapter that heard it, not in the bucket that meters our own output.
 */

export interface TokenBucketOptions {
  /** Sustained rate. D6: web push 300/s, Telegram 25/s, email 12/s. */
  readonly ratePerSecond: number;
  /**
   * Capacity, in tokens. A bucket that starts full can burst this many sends before the
   * rate applies, which is what makes a batch of 50 rows for one channel go out at once
   * rather than 50 evenly spaced calls. Defaults to one second's worth.
   */
  readonly burst?: number;
  /** Epoch milliseconds, injected — see `core/ports/clock.ts` for why. */
  readonly now: () => number;
}

export type TakeResult =
  | { readonly ok: true }
  /** No token now; `waitMs` is how long until one has refilled (never 0). */
  | { readonly ok: false; readonly waitMs: number };

export interface TokenBucket {
  readonly ratePerSecond: number;
  readonly burst: number;
  /** Spend one token if one is available. Never waits. */
  take(): TakeResult;
  /** Tokens currently available, fractional. For the metrics line, not for decisions. */
  level(): number;
}

export function createTokenBucket(options: TokenBucketOptions): TokenBucket {
  const { ratePerSecond, now } = options;
  if (!Number.isFinite(ratePerSecond) || ratePerSecond <= 0) {
    throw new RangeError(`ratePerSecond must be a positive number, got ${String(ratePerSecond)}`);
  }
  const burst = options.burst ?? Math.max(1, Math.floor(ratePerSecond));
  if (!Number.isInteger(burst) || burst < 1) {
    throw new RangeError(`burst must be a positive integer, got ${String(burst)}`);
  }
  const msPerToken = 1000 / ratePerSecond;

  let tokens = burst;
  let lastRefillAt = now();

  function refill(at: number): void {
    if (at <= lastRefillAt) return;
    tokens = Math.min(burst, tokens + (at - lastRefillAt) / msPerToken);
    lastRefillAt = at;
  }

  return {
    ratePerSecond,
    burst,
    take(): TakeResult {
      refill(now());
      if (tokens >= 1) {
        tokens -= 1;
        return { ok: true };
      }
      // Ceil, and at least 1 ms: a caller that sleeps for the returned wait must find a
      // token when it comes back, and a 0 ms wait would spin instead of pacing.
      const waitMs = Math.max(1, Math.ceil((1 - tokens) * msPerToken));
      return { ok: false, waitMs };
    },
    level(): number {
      refill(now());
      return tokens;
    },
  };
}
