/**
 * Who a claimed row is actually for — ADR-004 A1.9 and D8.
 *
 * A1.9's belt-and-braces rule: the gateway re-checks zone and channel-subscription
 * liveness **immediately before each provider call**, because at-least-once dispatch plus
 * a six-hour queue lets a retry outlive the deletion transaction that was supposed to
 * cancel it. That is why this is a port and not a column on the claimed row — a value
 * read at claim time is exactly the stale answer the rule exists to reject.
 *
 * It resolves the endpoint at the same moment, and only then: the outbox stores a
 * subscription id, never an endpoint, so a pseudonymized row cannot be replayed into a
 * send. One lookup does both jobs because they have to be one lookup — a liveness check
 * and an endpoint read that could disagree would put the send on the wrong side of the
 * race the rule was written for.
 */

import type { SubscriptionDisposition } from './alert-channel.js';
import type { AlertChannel } from './alert-outbox-store.js';

export type ResolvedRecipient =
  | {
      /** The zone and the subscription both still exist and are confirmed. */
      readonly live: true;
      /** Provider-specific handle. Opaque above the channel adapter. */
      readonly endpoint: string;
      /**
       * The channel the subscription is on. The gateway closes a row whose own channel
       * differs (`channel_mismatch`) rather than hand one channel's payload to another's
       * adapter. The row's locale is not here: it is stored on the row (migration 015).
       */
      readonly channel: AlertChannel;
      /** IANA zone — a digest is rendered in the recipient's day, not ours. */
      readonly timeZone: string;
    }
  | {
      readonly live: false;
      /** Why, for `last_error`: the zone is gone, the subscription is gone or unconfirmed. */
      readonly reason: string;
    };

export interface RecipientResolver {
  resolve(row: {
    readonly watchZoneId: string;
    readonly channelSubscriptionId: string | null;
  }): Promise<ResolvedRecipient>;
  /**
   * Act on what the provider said about the endpoint (D6: "dead tokens pruned on
   * permanent provider errors; web-push `pushsubscriptionchange` + 410 handling per 08").
   *
   * On the same port as {@link resolve} because it is the same question asked in the
   * other direction — who is reachable — and because the alternative, a second port over
   * the same table, would let the gateway prune a subscription it had not resolved.
   * `keep` exists in the vocabulary so that every provider outcome names a
   * disposition and none can be forgotten by omission; the gateway resolves it without a
   * call, because a no-op is not worth a round trip.
   */
  applyDisposition(
    channelSubscriptionId: string,
    disposition: SubscriptionDisposition,
  ): Promise<void>;
}
