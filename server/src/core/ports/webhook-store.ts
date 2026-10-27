/**
 * The ports of the signed-webhook channel (TASKS V2-G2; migration 035; docs/WEBHOOKS.md).
 *
 * Three concerns, three ports:
 *
 *   * {@link WebhookSecretSealer} — the per-endpoint signing secret is sealed at rest and
 *     opened before each send. Encrypted rather than hashed, because the server has to
 *     recompute the HMAC on every delivery and so needs the plaintext back.
 *   * {@link WebhookEndpointStore} — the owner's registry: create, list, remove, rotate.
 *     Every method takes the account id, and an endpoint the account does not own reads
 *     exactly like one that does not exist.
 *   * {@link WebhookDeliveryStore} — what the channel and the test ping need at send time:
 *     the endpoint, the previous attempt of this delivery (the retry schedule lives in the
 *     delivery log), the event facts for the payload, and the write that records an
 *     attempt together with its effect on the endpoint (reset, count, disable, confirm).
 *
 * Plus {@link HostResolver}, so the SSRF guard can check every address a name resolves to
 * before a request is made, and tests can answer without DNS.
 */

import type { WebhookAlertFacts } from '../webhooks/webhook-payload.js';
import type { PreviousAttempt } from '../webhooks/webhook-retry.js';
import type { EpochMs } from './clock.js';
import type { SealedSecret } from './staff-stores.js';

export type { SealedSecret } from './staff-stores.js';

export interface WebhookSecretSealer {
  /** Seals `secret` for the endpoint `endpointId`; the seal is bound to that id. */
  seal(endpointId: string, secret: string): SealedSecret;
  /** Opens a seal made for `endpointId`; throws on a wrong id, key or tampered bytes. */
  open(endpointId: string, sealed: SealedSecret): string;
}

export interface HostResolver {
  /** Every A and AAAA address the host resolves to; rejects when it resolves to none. */
  resolve(host: string): Promise<readonly string[]>;
}

/** Why an endpoint stopped receiving alerts. */
export type WebhookDisabledReason = 'consecutive_failures' | 'gone';

/** One endpoint as its owner sees it. The secret is never part of it. */
export interface WebhookEndpointView {
  readonly id: string;
  readonly url: string;
  readonly createdAtMs: EpochMs;
  readonly secretRotatedAtMs: EpochMs;
  /** True once a test ping was answered with a 2xx; alerts route only to confirmed endpoints. */
  readonly confirmed: boolean;
  readonly disabledAtMs: EpochMs | null;
  readonly disabledReason: WebhookDisabledReason | null;
  readonly consecutiveFailures: number;
  readonly lastSuccessAtMs: EpochMs | null;
  readonly lastFailureAtMs: EpochMs | null;
}

export interface NewWebhookEndpoint {
  readonly id: string;
  readonly accountId: string;
  /** Already validated and normalised (`validateWebhookUrl`). */
  readonly url: string;
  readonly sealed: SealedSecret;
  readonly atMs: EpochMs;
}

export interface WebhookEndpointStore {
  /**
   * Inserts the endpoint and its unconfirmed `channel_subscriptions` row in one
   * transaction, under a per-account lock, unless the account already holds `limit`
   * endpoints. False when the cap refused it.
   */
  create(endpoint: NewWebhookEndpoint, limit: number): Promise<boolean>;
  list(accountId: string): Promise<readonly WebhookEndpointView[]>;
  get(accountId: string, endpointId: string): Promise<WebhookEndpointView | null>;
  /**
   * Revokes the subscription and deletes the endpoint (its log cascades). The subscription
   * row stays, revoked, because queued outbox rows still reference it. False when the
   * account owns no endpoint by that id.
   */
  remove(accountId: string, endpointId: string, atMs: EpochMs): Promise<boolean>;
  /** Replaces the sealed secret. False when the account owns no endpoint by that id. */
  rotateSecret(
    accountId: string,
    endpointId: string,
    sealed: SealedSecret,
    atMs: EpochMs,
  ): Promise<boolean>;
}

/** The endpoint as a send needs it. */
export interface WebhookDeliveryTarget {
  readonly endpointId: string;
  readonly accountId: string;
  readonly url: string;
  readonly sealed: SealedSecret;
  readonly disabled: boolean;
}

/**
 * How an attempt ended, as the log records it. `retry`: a further attempt is scheduled;
 * `failed`: none will be (rejected, or the attempt cap reached); `gone`: the receiver
 * answered 410; `refused`: the SSRF guard stopped it before the network.
 */
export type WebhookAttemptOutcome = 'delivered' | 'retry' | 'failed' | 'gone' | 'refused';

export interface WebhookAttemptRecord {
  readonly endpointId: string;
  readonly accountId: string;
  readonly kind: 'alert' | 'ping';
  /** The alert outbox id (decimal text) for an alert; null for a ping. */
  readonly outboxId: string | null;
  readonly deliveryId: string;
  readonly attempt: number;
  readonly attemptedAtMs: EpochMs;
  readonly durationMs: number;
  readonly outcome: WebhookAttemptOutcome;
  readonly statusCode: number | null;
  /** Our own redacted description; never the receiver's body. */
  readonly error: string | null;
  readonly nextAttemptAtMs: EpochMs | null;
}

/** What an attempt does to its endpoint, decided by the caller from the outcome. */
export type WebhookEndpointEffect =
  /** A success: reset the failure count; a ping also confirms and re-enables. */
  | { readonly kind: 'success'; readonly confirm: boolean }
  /**
   * A failure counted towards auto-disable: the count is incremented and, when it reaches
   * `disableAfter`, the endpoint is disabled and its subscription revoked in the same write.
   */
  | { readonly kind: 'failure'; readonly disableAfter: number }
  /** Disable now and revoke the subscription. */
  | { readonly kind: 'disable'; readonly reason: WebhookDisabledReason }
  /** Logged only (a failed test ping does not count against the endpoint). */
  | { readonly kind: 'none' };

export interface WebhookDeliveryStore {
  loadTarget(endpointId: string): Promise<WebhookDeliveryTarget | null>;
  lastAttempt(endpointId: string, deliveryId: string): Promise<PreviousAttempt | null>;
  /** The outbox row's alert facts and its event's; null when either is gone. */
  alertFacts(outboxId: string): Promise<WebhookAlertFacts | null>;
  /**
   * Logs the attempt and applies `effect` in one transaction. Answers whether the endpoint
   * is disabled after the write.
   */
  recordAttempt(
    record: WebhookAttemptRecord,
    effect: WebhookEndpointEffect,
  ): Promise<{ readonly disabled: boolean }>;
}
