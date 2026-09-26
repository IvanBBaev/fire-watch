/**
 * A channel that renders everything and sends nothing.
 *
 * Until H5 brings the three real providers this is the only implementation of
 * {@link AlertChannelAdapter} in the tree, and it exists for three reasons that outlive
 * that gap:
 *
 *   - **The boundary needs a target.** `only-the-gateway-sends` forbids importing
 *     `adapters/alerts/channels/` from anywhere but the gateway and the wiring file. A
 *     rule with nothing behind it is a rule nobody has tested, and CI cannot prove a
 *     violation fails until there is something to violate it with.
 *   - **A8's shadow mode needs exactly this.** The nightly diff report answers "what you
 *     would have received", which is a full dispatch — claim, resolve, render, lint —
 *     with the provider call replaced. Not a stub of the send: everything *except* the
 *     send.
 *   - **The local loop needs somewhere for alerts to go.** A developer with no VAPID
 *     keys, no bot token and no SES sandbox still has to be able to run the gateway.
 *
 * It records what it was given so a caller can assert on it, and it is deliberately not
 * called a mock: a mock lives in a test file and this ships, because shadow mode is a
 * product feature (A8) and not a test fixture.
 */

import type {
  AlertChannelAdapter,
  DeliveryOutcome,
  OutboundMessage,
} from '../../../core/ports/alert-channel.js';
import type { AlertChannel } from '../../../core/ports/alert-outbox-store.js';

export interface SinkChannel extends AlertChannelAdapter {
  /** Everything handed to {@link AlertChannelAdapter.deliver}, in call order. */
  readonly delivered: readonly OutboundMessage[];
  /** Forget the record. For a long-running shadow process, not for tests. */
  clear(): void;
}

export interface SinkChannelOptions {
  /**
   * Which channel this stands in for. A sink that claimed to be every channel would let
   * the gateway's per-channel routing pass with no routing at all, and D6's TTLs differ
   * per channel — a `push` row and an `email` row must not take the same path by
   * accident.
   */
  readonly channel: AlertChannel;
  /**
   * The clock, injected. The sink reports a provider ack, and a real ack timestamp is
   * what the D9 dispatch-latency metric is measured against; reading `Date.now()` here
   * would make a replayed shadow run produce a different latency every time.
   */
  readonly now: () => number;
  /**
   * Cap on retained messages. A shadow run over a busy August would otherwise hold every
   * alert of the day in memory; the oldest are dropped.
   */
  readonly retain?: number;
}

const DEFAULT_RETAIN = 1000;

export function createSinkChannel(options: SinkChannelOptions): SinkChannel {
  const retain = options.retain ?? DEFAULT_RETAIN;
  if (!Number.isInteger(retain) || retain < 1) {
    throw new RangeError(`retain must be a positive integer, got ${String(retain)}`);
  }
  const delivered: OutboundMessage[] = [];

  return {
    channel: options.channel,
    delivered,
    clear(): void {
      delivered.length = 0;
    },
    deliver(message: OutboundMessage): Promise<DeliveryOutcome> {
      if (message.channel !== options.channel) {
        // The gateway routes by channel; a mismatch here means it routed wrong, and a
        // sink that quietly accepted it would hide the one bug it is positioned to catch.
        //
        // Rejected rather than thrown: the method is declared as returning a promise, so a
        // synchronous throw would slip past a caller that only wrote `.catch(...)`.
        return Promise.reject(
          new TypeError(
            `sink for ${options.channel} received a message routed to ${message.channel}`,
          ),
        );
      }
      delivered.push(message);
      if (delivered.length > retain) {
        delivered.shift();
      }
      return Promise.resolve({ kind: 'delivered', providerAckAt: options.now() });
    },
  };
}
