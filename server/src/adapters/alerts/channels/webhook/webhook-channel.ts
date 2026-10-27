/**
 * The `webhook` channel — a signed JSON POST to an endpoint the account registered (TASKS
 * V2-G2; docs/WEBHOOKS.md; migration 035).
 *
 * The subscription's `endpoint` is the `webhook_endpoints.id`, never the URL; the adapter
 * loads the URL and the sealed secret at send time, so a rotated secret or a removed
 * endpoint takes effect on the next attempt of a queued alert.
 *
 * **Retries live here, not in the gateway.** A failed attempt is logged in
 * `webhook_deliveries` with its `next_attempt_at` (exponential backoff, full jitter) and
 * reported `transient`, so the gateway releases the row. When the dispatch loop claims it
 * again before that time, {@link nextAttemptDue} says `wait` and the adapter releases it
 * again without touching the network. The outbox's 6 h expiry is the outer bound.
 *
 *   | attempt result                         | log outcome | endpoint effect      | gateway outcome     |
 *   |----------------------------------------|-------------|----------------------|---------------------|
 *   | 2xx                                    | delivered   | failures reset       | delivered           |
 *   | 408, 429, 5xx, timeout, DNS, network   | retry       | failure counted      | transient           |
 *   | … on the last allowed attempt          | failed      | failure counted      | permanent · keep    |
 *   | other 4xx                              | failed      | failure counted      | permanent · keep    |
 *   | 410 Gone                               | gone        | disabled now         | permanent · prune   |
 *   | SSRF guard refused the address         | refused     | failure counted      | permanent · keep    |
 *
 * A failure that reaches `disableAfterConsecutiveFailures` disables the endpoint and
 * revokes its subscription in the same write (the store's job); the alert in hand is then
 * closed `permanent · keep` instead of being retried into a disabled endpoint.
 *
 * A delivery whose newest log row is `delivered` (a crash between the log write and the
 * outbox settle) is reported delivered again without a second POST.
 *
 * Not logged, because no request was made: a backoff still running, an exhausted delivery
 * being re-claimed, an endpoint that is gone or disabled, an outbox row whose event is
 * gone, and a secret this process cannot open (a key-configuration fault, so `transient`,
 * like Telegram's own-token 401).
 */

import type {
  AlertChannelAdapter,
  DeliveryOutcome,
  OutboundMessage,
} from '../../../../core/ports/alert-channel.js';
import type {
  WebhookAttemptOutcome,
  WebhookDeliveryStore,
  WebhookEndpointEffect,
  WebhookSecretSealer,
} from '../../../../core/ports/webhook-store.js';
import type { WebhookParams } from '../../../../core/config/webhook-params.js';
import {
  buildWebhookAlertPayload,
  serializeWebhookPayload,
} from '../../../../core/webhooks/webhook-payload.js';
import { backoffDelayMs, nextAttemptDue } from '../../../../core/webhooks/webhook-retry.js';
import type { WebhookSendClass, WebhookTransport } from './webhook-transport.js';

export interface WebhookChannelOptions {
  readonly store: WebhookDeliveryStore;
  readonly sealer: WebhookSecretSealer;
  readonly transport: WebhookTransport;
  readonly params: WebhookParams;
  readonly now: () => number;
  /** The jitter source, in [0, 1). */
  readonly random?: () => number;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function createWebhookChannel(options: WebhookChannelOptions): AlertChannelAdapter {
  const random = options.random ?? Math.random;
  const { params, store } = options;

  return {
    channel: 'webhook',
    async deliver(message: OutboundMessage): Promise<DeliveryOutcome> {
      if (message.channel !== 'webhook') {
        // Inside an `async` function this is a rejection, not a synchronous throw.
        throw new TypeError(`webhook channel received a message routed to ${message.channel}`);
      }
      if (!UUID_RE.test(message.endpoint)) {
        return {
          kind: 'permanent',
          error: 'webhook endpoint unusable: not an endpoint id',
          subscription: 'prune',
        };
      }

      const target = await store.loadTarget(message.endpoint);
      if (target === null) {
        return {
          kind: 'permanent',
          error: 'webhook endpoint is no longer registered',
          subscription: 'prune',
        };
      }
      if (target.disabled) {
        return { kind: 'permanent', error: 'webhook endpoint is disabled', subscription: 'keep' };
      }

      const deliveryId = message.outboxId;
      const now = options.now();
      const previous = await store.lastAttempt(target.endpointId, deliveryId);
      if (previous?.delivered === true) {
        // Re-claimed after a crash between the log write and the settle: already sent.
        return { kind: 'delivered', providerAckAt: now };
      }
      const gate = nextAttemptDue(previous, now, params);
      if (gate.kind === 'wait') {
        return {
          kind: 'transient',
          error: `webhook retry not due for ${String(gate.untilMs - now)} ms`,
        };
      }
      if (gate.kind === 'exhausted') {
        return {
          kind: 'permanent',
          error: 'webhook delivery has no attempts left',
          subscription: 'keep',
        };
      }

      const facts = await store.alertFacts(message.outboxId);
      if (facts === null) {
        return {
          kind: 'permanent',
          error: 'webhook alert facts are gone (outbox row or event)',
          subscription: 'keep',
        };
      }

      let secret: string;
      try {
        secret = options.sealer.open(target.endpointId, target.sealed);
      } catch {
        // The sealer's own messages are literals, but nothing here needs them.
        return { kind: 'transient', error: 'webhook signing secret could not be opened' };
      }

      const body = serializeWebhookPayload(
        buildWebhookAlertPayload({
          deliveryId,
          sentAtMs: now,
          locale: message.locale,
          rendered: message.rendered,
          facts,
        }),
      );
      const sent = await options.transport.send({ url: target.url, secret, body, deliveryId });

      const lastAllowed = gate.attempt >= params.maxAttempts;
      const decision = decide(sent.class, lastAllowed);
      const nextAttemptAtMs =
        decision.outcome === 'retry' ? now + backoffDelayMs(gate.attempt, params, random) : null;
      const effect: WebhookEndpointEffect =
        decision.outcome === 'delivered'
          ? { kind: 'success', confirm: false }
          : decision.outcome === 'gone'
            ? { kind: 'disable', reason: 'gone' }
            : { kind: 'failure', disableAfter: params.disableAfterConsecutiveFailures };

      const { disabled } = await store.recordAttempt(
        {
          endpointId: target.endpointId,
          accountId: target.accountId,
          kind: 'alert',
          outboxId: message.outboxId,
          deliveryId,
          attempt: gate.attempt,
          attemptedAtMs: now,
          durationMs: sent.durationMs,
          outcome: decision.outcome,
          statusCode: sent.statusCode,
          error: sent.error,
          nextAttemptAtMs,
        },
        effect,
      );

      const error = sent.error ?? 'webhook attempt failed';
      switch (decision.outcome) {
        case 'delivered':
          return { kind: 'delivered', providerAckAt: options.now() };
        case 'gone':
          return { kind: 'permanent', error, subscription: 'prune' };
        case 'retry':
          return disabled
            ? {
                kind: 'permanent',
                error: `${error}; endpoint disabled after consecutive failures`,
                subscription: 'keep',
              }
            : { kind: 'transient', error };
        case 'failed':
        case 'refused':
          return { kind: 'permanent', error, subscription: 'keep' };
      }
    },
  };
}

function decide(
  sendClass: WebhookSendClass,
  lastAllowed: boolean,
): { readonly outcome: WebhookAttemptOutcome } {
  switch (sendClass) {
    case 'delivered':
      return { outcome: 'delivered' };
    case 'gone':
      return { outcome: 'gone' };
    case 'refused':
      return { outcome: 'refused' };
    case 'reject':
      return { outcome: 'failed' };
    case 'retry':
      return { outcome: lastAllowed ? 'failed' : 'retry' };
  }
}
