/**
 * The owner's test ping (TASKS V2-G2; `POST /api/v1/webhooks/:id/test`; docs/WEBHOOKS.md).
 *
 * A signed `ping` payload sent once, now, through the same transport the alert channel
 * uses (SSRF guard, signature, no redirects). It is not an alert: it carries no event, it
 * is not queued, and nobody but the endpoint's owner can trigger it, for their own
 * endpoint, so it does not pass through the notification gateway. dep-cruiser pins what
 * this file may take from the alert channels to the transport alone
 * (`webhook-pinger-reuses-transport-only`).
 *
 * The ping is how an endpoint is **confirmed**: a 2xx confirms the endpoint's subscription
 * (alerts route only to confirmed subscriptions) and re-enables an endpoint that was
 * auto-disabled. Any other result is logged and changes nothing — a failed test does not
 * count towards auto-disable, and is never retried.
 */

import { randomUUID } from 'node:crypto';

import type {
  WebhookAttemptOutcome,
  WebhookDeliveryStore,
  WebhookSecretSealer,
} from '../../core/ports/webhook-store.js';
import {
  buildWebhookPingPayload,
  serializeWebhookPayload,
} from '../../core/webhooks/webhook-payload.js';
import type { WebhookTransport } from '../alerts/channels/webhook/webhook-transport.js';

export interface WebhookPingResult {
  readonly deliveryId: string;
  readonly outcome: Exclude<WebhookAttemptOutcome, 'retry'>;
  readonly statusCode: number | null;
  readonly error: string | null;
  readonly durationMs: number;
  /** True when this ping confirmed (and, if needed, re-enabled) the endpoint. */
  readonly confirmed: boolean;
}

export interface WebhookPinger {
  /** Null when the account owns no endpoint by that id. */
  ping(accountId: string, endpointId: string): Promise<WebhookPingResult | null>;
}

export interface WebhookPingerOptions {
  readonly store: WebhookDeliveryStore;
  readonly sealer: WebhookSecretSealer;
  readonly transport: WebhookTransport;
  readonly now: () => number;
  readonly newId?: () => string;
}

export function createWebhookPinger(options: WebhookPingerOptions): WebhookPinger {
  const newId = options.newId ?? (() => randomUUID());

  return {
    async ping(accountId, endpointId) {
      const target = await options.store.loadTarget(endpointId);
      if (target === null || target.accountId !== accountId) return null;

      const secret = options.sealer.open(target.endpointId, target.sealed);
      const deliveryId = newId();
      const sentAtMs = options.now();
      const body = serializeWebhookPayload(
        buildWebhookPingPayload({ deliveryId, endpointId: target.endpointId, sentAtMs }),
      );
      const sent = await options.transport.send({ url: target.url, secret, body, deliveryId });

      const outcome: WebhookPingResult['outcome'] =
        sent.class === 'delivered'
          ? 'delivered'
          : sent.class === 'gone'
            ? 'gone'
            : sent.class === 'refused'
              ? 'refused'
              : 'failed';
      const confirmed = outcome === 'delivered';
      await options.store.recordAttempt(
        {
          endpointId: target.endpointId,
          accountId: target.accountId,
          kind: 'ping',
          outboxId: null,
          deliveryId,
          attempt: 1,
          attemptedAtMs: sentAtMs,
          durationMs: sent.durationMs,
          outcome,
          statusCode: sent.statusCode,
          error: sent.error,
          nextAttemptAtMs: null,
        },
        confirmed ? { kind: 'success', confirm: true } : { kind: 'none' },
      );
      return {
        deliveryId,
        outcome,
        statusCode: sent.statusCode,
        error: sent.error,
        durationMs: sent.durationMs,
        confirmed,
      };
    },
  };
}
