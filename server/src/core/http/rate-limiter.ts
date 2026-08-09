/**
 * A fixed-window rate limiter, pure enough to test without a server.
 *
 * The health endpoints are unauthenticated (OPERATIONS §2.2 rule 6) because anything that
 * needs a credential is a thing that can page us for the credential having expired. The
 * price of that is that anyone can call them, and `/api/health/freshness` costs a database
 * round trip — so the limit is what keeps a curious script from turning a public probe into
 * a way to hold a connection from the pool.
 *
 * Fixed window rather than a token bucket or a sliding log: the burst it lets through at a
 * window edge is at most twice the limit, and defending an endpoint that must answer in
 * 500 ms against something that has to hold per-caller history is a worse trade than
 * defending it against a doubled burst.
 *
 * Time arrives as a parameter, never from a clock. Eviction is bounded, because the key is
 * a client address and the set of client addresses is chosen by strangers.
 */

export interface RateLimiterOptions {
  /** Requests allowed per window, per key. */
  readonly limit: number;
  readonly windowMs: number;
  /**
   * How many keys may be tracked at once. On overflow the whole table is dropped, which
   * resets everyone's window: the alternative is an LRU whose bookkeeping costs more than
   * the check it protects, and the failure mode of forgetting is a brief over-admission,
   * not unbounded memory on a 2 GB box.
   */
  readonly maxKeys?: number;
}

export interface RateLimitDecision {
  readonly allowed: boolean;
  /** Requests left in the current window after this one. Never negative. */
  readonly remaining: number;
  /** Whole seconds until the window resets; what a `Retry-After` header should say. */
  readonly retryAfterSeconds: number;
}

export interface RateLimiter {
  check(key: string, now: number): RateLimitDecision;
}

export const DEFAULT_MAX_KEYS = 10_000;

interface Window {
  startedAt: number;
  count: number;
}

export function createRateLimiter(options: RateLimiterOptions): RateLimiter {
  const { limit, windowMs } = options;
  const maxKeys = options.maxKeys ?? DEFAULT_MAX_KEYS;

  if (!Number.isInteger(limit) || limit < 1) {
    throw new RangeError(`rate limit must be a positive integer, got ${String(limit)}`);
  }
  if (!Number.isInteger(windowMs) || windowMs < 1) {
    throw new RangeError(`rate limit window must be a positive integer, got ${String(windowMs)}`);
  }

  const windows = new Map<string, Window>();

  return {
    check(key: string, now: number): RateLimitDecision {
      const existing = windows.get(key);
      const window =
        existing === undefined || now - existing.startedAt >= windowMs
          ? { startedAt: now, count: 0 }
          : existing;

      if (existing === undefined && windows.size >= maxKeys) {
        windows.clear();
      }
      window.count += 1;
      windows.set(key, window);

      const elapsed = now - window.startedAt;
      return {
        allowed: window.count <= limit,
        remaining: Math.max(0, limit - window.count),
        // Rounded up: a `Retry-After: 0` invites an immediate retry that is still refused.
        retryAfterSeconds: Math.max(1, Math.ceil((windowMs - elapsed) / 1000)),
      };
    },
  };
}
