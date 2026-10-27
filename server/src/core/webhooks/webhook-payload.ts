/**
 * The webhook body Fire Watch signs (TASKS V2-G2; `fire-watch.webhook.v1` in contracts).
 *
 * Built from three things the channel adapter already holds: the rendered alert the other
 * channels send (title, body, mandatory footer, deep link), a handful of facts about the
 * event as of the send, and the `api` surface of the credits registry — the same credits
 * the public API carries (`attributionFor`), because a webhook is the API delivered.
 *
 * **Severity** is the event's score bucket, never the raw score: the score is an internal
 * number whose scale is a founder decision, and the bucket is what every public surface
 * already shows. **Hazard** is fixed to `wildfire`. Both are founder decisions to confirm.
 *
 * The serialisation is plain `JSON.stringify` of an object built in a fixed key order: the
 * signature covers the exact bytes sent, so a receiver never needs to reproduce the
 * serialisation — only to hash what it received.
 */

import {
  WEBHOOK_HAZARD,
  WEBHOOK_PAYLOAD_VERSION,
  scoreBucket,
  type WebhookAlertPayload,
  type WebhookPingPayload,
} from '@fire-watch/contracts';

import { attributionFor } from '../snapshot/snapshot-builder.js';
import { isoFromEpochMs, type EpochMs } from '../ports/clock.js';
import type { RenderedAlert } from '../ports/alert-channel.js';

/** What the store reads about the outbox row and its event for one alert delivery. */
export interface WebhookAlertFacts {
  readonly alertType: string;
  readonly decidedAtMs: EpochMs;
  readonly event: {
    readonly publicId: string;
    readonly score: number;
    readonly status: string;
    readonly startedAtMs: EpochMs;
    readonly lastDetectionAtMs: EpochMs;
  };
}

export interface WebhookAlertInput {
  readonly deliveryId: string;
  readonly sentAtMs: EpochMs;
  readonly locale: string;
  readonly rendered: RenderedAlert;
  readonly facts: WebhookAlertFacts;
}

export function buildWebhookAlertPayload(input: WebhookAlertInput): WebhookAlertPayload {
  const { facts, rendered } = input;
  return {
    version: WEBHOOK_PAYLOAD_VERSION,
    type: 'alert',
    delivery_id: input.deliveryId,
    sent_at: isoFromEpochMs(input.sentAtMs),
    alert: {
      type: facts.alertType,
      decided_at: isoFromEpochMs(facts.decidedAtMs),
      locale: input.locale,
      title: rendered.title,
      body: rendered.body,
      footer: rendered.footer,
    },
    event: {
      id: facts.event.publicId,
      permalink: rendered.url,
      hazard: WEBHOOK_HAZARD,
      severity: scoreBucket(facts.event.score),
      status: facts.event.status,
      started_at: isoFromEpochMs(facts.event.startedAtMs),
      last_detection_at: isoFromEpochMs(facts.event.lastDetectionAtMs),
    },
    attribution: attributionFor(input.sentAtMs),
  };
}

export function buildWebhookPingPayload(input: {
  readonly deliveryId: string;
  readonly endpointId: string;
  readonly sentAtMs: EpochMs;
}): WebhookPingPayload {
  return {
    version: WEBHOOK_PAYLOAD_VERSION,
    type: 'ping',
    delivery_id: input.deliveryId,
    sent_at: isoFromEpochMs(input.sentAtMs),
    endpoint_id: input.endpointId,
    attribution: attributionFor(input.sentAtMs),
  };
}

/** The bytes signed and sent. */
export function serializeWebhookPayload(payload: WebhookAlertPayload | WebhookPingPayload): string {
  return JSON.stringify(payload);
}
