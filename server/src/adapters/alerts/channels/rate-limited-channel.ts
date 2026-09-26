/**
 * Wraps a channel adapter in a token bucket — D6's "per-channel token buckets".
 *
 * The bucket is a decorator rather than something each provider adapter does for itself
 * so that the three adapters stay about their provider's wire protocol and nothing else,
 * and so that the pacing rule is written and tested once. The wrapper is itself an
 * {@link AlertChannelAdapter}: the gateway cannot tell a paced channel from a raw one,
 * which is the point — pacing is not a property of the gateway's routing.
 *
 * A dry bucket is handled in two ways depending on how dry:
 *
 *   - a short wait (≤ `maxWaitMs`) is slept through via the {@link Sleeper} port, and
 *     the send proceeds — this is the normal shape of a burst;
 *   - a longer wait releases the row as `transient` with the wait in the error text, and
 *     the gateway moves on. The gateway dispatches sequentially, so a single starved
 *     channel must never hold the rows of another behind it.
 *
 * Shutdown mid-wait resolves `transient` too: the row goes back to the queue unsent and
 * the next process claims it, which is the outbox's whole reason for existing (H1).
 */

import type {
  AlertChannelAdapter,
  DeliveryOutcome,
  OutboundMessage,
} from '../../../core/ports/alert-channel.js';
import type { Sleeper } from '../../../core/ports/sleeper.js';
import type { TokenBucket } from './token-bucket.js';

export interface RateLimitedChannelOptions {
  readonly inner: AlertChannelAdapter;
  readonly bucket: TokenBucket;
  readonly sleeper: Sleeper;
  /** Waits longer than this are not slept through; the row is released instead. */
  readonly maxWaitMs: number;
  /** Process shutdown. An aborted wait releases the row rather than sending late. */
  readonly signal?: AbortSignal;
}

export function createRateLimitedChannel(options: RateLimitedChannelOptions): AlertChannelAdapter {
  const { inner, bucket, sleeper, maxWaitMs } = options;
  if (!Number.isFinite(maxWaitMs) || maxWaitMs < 0) {
    throw new RangeError(`maxWaitMs must be a non-negative number, got ${String(maxWaitMs)}`);
  }
  const signal = options.signal ?? new AbortController().signal;

  return {
    channel: inner.channel,
    async deliver(message: OutboundMessage): Promise<DeliveryOutcome> {
      // The loop exists because a sleep can end early (abort) or, with a shared clock,
      // wake to find the token taken by nobody — one retry per wake is cheap and correct;
      // an unbounded number is not, hence the ceiling on total time waited.
      let waitedMs = 0;
      for (;;) {
        const attempt = bucket.take();
        if (attempt.ok) break;
        if (signal.aborted) {
          return { kind: 'transient', error: `rate_limited:${inner.channel}: shutting down` };
        }
        if (waitedMs + attempt.waitMs > maxWaitMs) {
          return {
            kind: 'transient',
            error: `rate_limited:${inner.channel}: next token in ${String(attempt.waitMs)} ms`,
          };
        }
        await sleeper.sleep(attempt.waitMs, signal);
        waitedMs += attempt.waitMs;
      }
      return inner.deliver(message);
    },
  };
}
