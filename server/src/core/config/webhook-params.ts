/**
 * `webhook_params_v1` — every number the signed-webhook channel runs against (TASKS V2-G2;
 * ADR-002 D5 config-as-data; docs/WEBHOOKS.md).
 *
 * All of these are **founder decisions awaiting review**: the values below are defensible
 * defaults chosen to match what established webhook senders do (a few seconds of timeout,
 * hours of retry, a cap on endpoints), not numbers anyone has measured against Fire Watch
 * traffic. They are versioned like every other config so that a delivery log row can be
 * read against the rules it ran under.
 *
 * The retry window has a hard ceiling no value here can lift: an alert outbox row expires
 * at `delivery_params_v1.queueExpirySeconds` (6 h) after its decision, and a webhook retry
 * is a re-claim of that row. `maxAttempts` × the backoff schedule is chosen to finish
 * inside it; the unit test pins that.
 */

import { defineConfig, type VersionedConfig } from './versioned-config.js';

export interface WebhookParams {
  /** One HTTP attempt, connect to last byte. A receiver should acknowledge first and work later. */
  readonly timeoutMs: number;
  /** Attempts per delivery (the first included) before the delivery is given up as failed. */
  readonly maxAttempts: number;
  /** The first retry waits up to this long; each later one doubles, before jitter. */
  readonly backoffBaseMs: number;
  /** No single wait is longer than this, before jitter. */
  readonly backoffMaxMs: number;
  /**
   * Failed attempts in a row — across deliveries, alerts and pings alike — after which the
   * endpoint is disabled and its subscription revoked. A success resets the count.
   */
  readonly disableAfterConsecutiveFailures: number;
  /**
   * The proposed delivery-log retention. Not armed here: arming is setting
   * `PURGE_RETENTION.webhook_deliveries` (`core/erasure/purge-plan.ts`) to this number,
   * which, like every retention there, waits for ratification.
   */
  readonly deliveryLogRetentionDays: number;
  /** Live endpoints one account may register. */
  readonly maxEndpointsPerAccount: number;
  /** The replay window the integrator page tells receivers to enforce, in seconds. */
  readonly replayWindowSeconds: number;
  /** The only destination ports accepted. 443 alone keeps the SSRF surface to TLS listeners. */
  readonly allowedPorts: readonly number[];
  /** The URL length cap. */
  readonly maxUrlLength: number;
  /** Random bytes per signing secret (encoded base64url, so 32 bytes → 43 characters). */
  readonly secretBytes: number;
}

export const WEBHOOK_PARAMS: VersionedConfig<WebhookParams> = defineConfig(
  'webhook_params',
  'webhook_params_v1',
  {
    timeoutMs: 5_000,
    maxAttempts: 6,
    backoffBaseMs: 60_000,
    backoffMaxMs: 3_600_000,
    disableAfterConsecutiveFailures: 20,
    deliveryLogRetentionDays: 30,
    maxEndpointsPerAccount: 5,
    replayWindowSeconds: 300,
    allowedPorts: [443],
    maxUrlLength: 2_048,
    secretBytes: 32,
  },
);
