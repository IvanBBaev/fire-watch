/**
 * What a provider adapter looks like from the core — ADR-004 D2.
 *
 * D2 makes the notification gateway the only code path that can reach one of these, and
 * a dependency-cruiser rule (`only-the-gateway-sends`) is what makes that true rather
 * than aspirational. The port is declared in core anyway, because the gateway's decision
 * about *what to do with an outcome* is domain logic — a permanent error prunes a
 * subscription, a 410 asks the client to re-prompt — and that logic must be testable
 * without a provider.
 *
 * The adapter is told the endpoint, never the recipient. It receives a resolved
 * {@link OutboundMessage} carrying already-rendered copy and an opaque subscription
 * handle; it has no access to the account, the zone, or the fire. A channel adapter that
 * could look up who it is writing to would be a second place where a `SELECT` could
 * widen, and D8's data-protection posture rests on there being exactly one.
 */

import type { LintableAlert } from '@fire-watch/contracts';

import type { AlertLocale } from '../alerts/templates/alert-copy.js';
import type { AlertChannel } from './alert-outbox-store.js';

/**
 * Copy as the template renderer produced it and the never-send lint cleared it (D7).
 * Three parts and not one string, because the parts have different obligations: the
 * footer's attribution, LANCE disclaimer and scope-of-service sentence are mandatory on
 * every alert, and a renderer that returned prose could not be checked for them.
 *
 * This is the **only** declaration of the type, and it lives here rather than in
 * `@fire-watch/contracts` because it is a delivery payload, not shared vocabulary: `url`
 * is a deep link a channel adapter follows, and no web code ever holds one. The contracts
 * package is imported verbatim by the browser bundle, so a server-only payload does not
 * belong in it.
 *
 * What *is* shared is the text the never-send lint reads, and that is
 * {@link LintableAlert}, which contracts owns because the web lints its own message
 * catalogs against the same rule list. Extending it rather than repeating its three
 * fields is what keeps the two from drifting: the dependency rules allow server →
 * contracts and never the reverse, so this is the one place the relationship can be
 * written down, and the compiler now proves that every alert we can deliver is an alert
 * the lint can read. `title` is narrowed from optional to required here — a channel may
 * ship copy without a title, but an alert we deliver always has one.
 */
export interface RenderedAlert extends LintableAlert {
  readonly title: string;
  /** Deep link into the app for the event, or `null` for channels that cannot carry one. */
  readonly url: string | null;
}

/** Everything an adapter needs and nothing it does not. */
export interface OutboundMessage {
  /** `alert_outbox.id` as decimal text — the correlation id in provider logs. */
  readonly outboxId: string;
  readonly channel: AlertChannel;
  /**
   * The provider-specific handle: a web-push subscription JSON, a Telegram chat id, an
   * email address. Opaque here on purpose — the shape is the adapter's business and
   * putting a union of three provider formats in core would make core know about three
   * providers.
   */
  readonly endpoint: string;
  readonly rendered: RenderedAlert;
  /**
   * The language `rendered` is in — the row's stored locale (migration 015). For a
   * provider field that declares it (an email's `Content-Language`), never for choosing
   * copy: the copy is already rendered.
   */
  readonly locale: AlertLocale;
  /** D6's per-channel TTL, in seconds, passed through to providers that honour one. */
  readonly ttlSeconds: number;
}

/**
 * What the gateway does with the subscription afterwards (D6: "dead tokens pruned on
 * permanent provider errors; web-push `pushsubscriptionchange` + 410 handling per 08").
 *
 * `reprompt` is not a louder `prune`. Both stop using the endpoint; only `reprompt` says
 * the user still wants alerts and the browser silently replaced their subscription, which
 * is a prompt in the UI rather than a silent unsubscribe.
 */
export const SUBSCRIPTION_DISPOSITIONS = ['keep', 'prune', 'reprompt'] as const;
export type SubscriptionDisposition = (typeof SUBSCRIPTION_DISPOSITIONS)[number];

export type DeliveryOutcome =
  | {
      readonly kind: 'delivered';
      /** Epoch milliseconds the provider acknowledged — `alert_outbox.provider_ack_at`. */
      readonly providerAckAt: number;
    }
  | {
      /** Worth another claim later: a timeout, a 5xx, a bucket that ran dry. */
      readonly kind: 'transient';
      readonly error: string;
    }
  | {
      /** This endpoint will never accept this message. */
      readonly kind: 'permanent';
      readonly error: string;
      readonly subscription: SubscriptionDisposition;
    };

export interface AlertChannelAdapter {
  readonly channel: AlertChannel;
  /**
   * Attempt one delivery. Implementations resolve with an outcome and reject only for
   * programmer error — a rejected promise is a bug in the adapter, not a failed send,
   * and the gateway treats the two differently.
   */
  deliver(message: OutboundMessage): Promise<DeliveryOutcome>;
}
