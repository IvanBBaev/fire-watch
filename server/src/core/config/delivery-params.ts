/**
 * `delivery_params_v1` — the two clocks the notification gateway runs against (ADR-004
 * D6; ADR-002 D5 config-as-data).
 *
 * D6 names four numbers: three token-bucket rates and two deadlines. Only the deadlines
 * are here. The buckets are a property of the *provider* — SES's quota, Telegram's
 * 25/s — and belong with the channel adapters that own a provider connection (H5); the
 * deadlines are a property of the *decision*, computed from `decided_at` alone, and the
 * dispatch decision has to be able to reach them without knowing which adapter will
 * eventually take the row.
 *
 * Versioned for the same reason every other config here is: a replay of last September
 * has to expire the rows last September expired. A deadline edited in place would make
 * an archived `ttl_expired` row unreproducible — the row would sit inside a window it
 * was closed outside of, and nothing in the record would say the window had moved.
 *
 * v2 (migration 033): {@link DeliveryRetryParams} — failed attempts back off and stop.
 */

import { defineConfig, type VersionedConfig } from './versioned-config.js';
import type { AlertChannel } from '../ports/alert-outbox-store.js';

export interface DeliveryParams {
  /**
   * Per-channel delivery TTL in seconds. D6 sets 1800 s for web push — "a fire alert
   * older than 30 min must not land as if fresh" — and the number is passed *to the
   * provider* as well as enforced here, because a push service holds a message for the
   * TTL and delivers it when the device next appears.
   *
   * Telegram and email have no equivalent knob: the provider delivers when it can and
   * there is no way to tell it to stop trying. Their entry is therefore the queue
   * expiry itself, which is the honest statement that nothing shorter is enforceable.
   */
  readonly channelTtlSeconds: Readonly<Record<AlertChannel, number>>;
  /**
   * D6's queue expiry. An undelivered decision dies after this long — "they are visible
   * in the app anyway", which is the whole argument: the alert is a notification of
   * something the user can still go and read, so a six-hour-old push is noise about a
   * fire whose situation has since changed.
   */
  readonly queueExpirySeconds: number;
  /**
   * D6's dispatch SLO, decision → provider ack, p95. Not enforced — it is the target the
   * `fw_notification_queue_oldest_seconds` alert is calibrated against, and it lives here
   * so the metric and the promise cannot drift apart.
   */
  readonly dispatchSloP95Seconds: number;
  /** D6: the queue-age alert pages here. */
  readonly queueAgePageSeconds: number;
  /** How a failed delivery attempt is retried, and when it stops being retried. */
  readonly retry: DeliveryRetryParams;
}

/**
 * The retry schedule of one outbox row (migration 033, `core/alerts/delivery-retry.ts`).
 *
 * The *n*-th failed attempt waits `min(baseDelaySeconds × 2^(n−1), maxDelaySeconds)`,
 * of which the last `jitterRatio` is drawn at random, before the row may be claimed again.
 * The jitter is what keeps a provider outage from ending in a thundering herd: every row
 * that failed in the same cycle would otherwise come back in the same cycle.
 *
 * **Founder review — none of these four numbers is stated by ADR-004 or 05.** D6 gives
 * deadlines, not a retry policy. The shipped values are chosen to fit inside them:
 *
 *   * `baseDelaySeconds` 20 — two dispatch intervals (10 s), so the first retry is not the
 *     very next cycle against a provider that just failed.
 *   * `maxDelaySeconds` 600 — D6's queue-age page: no single wait outlasts the alert that
 *     would tell an operator the queue is stuck.
 *   * `maxAttempts` 6 — five waits of nominally 20 + 40 + 80 + 160 + 320 s (310–620 s with
 *     jitter), so a row that keeps failing is closed `failed` about ten minutes after its
 *     first failure, well inside push's 1800 s deadline. A provider outage longer than
 *     that loses the push rows it spans, which is D6's own trade: "they are visible in the
 *     app anyway".
 *   * `jitterRatio` 0.5 — "equal jitter": every wait is at least half its nominal length.
 */
export interface DeliveryRetryParams {
  /** Failed attempts after which the row is closed `failed` (`retry_exhausted:…`). */
  readonly maxAttempts: number;
  readonly baseDelaySeconds: number;
  readonly maxDelaySeconds: number;
  /** The randomized share of each wait, in [0, 1]. */
  readonly jitterRatio: number;
}

export const DELIVERY_PARAMS: VersionedConfig<DeliveryParams> = defineConfig(
  'delivery_params',
  'delivery_params_v2',
  {
    channelTtlSeconds: {
      push: 1800,
      telegram: 21_600,
      email: 21_600,
      // V2-G2: a webhook retries on its own schedule (`webhook_params_v1`) inside this.
      webhook: 21_600,
    },
    queueExpirySeconds: 21_600,
    dispatchSloP95Seconds: 60,
    queueAgePageSeconds: 600,
    retry: {
      maxAttempts: 6,
      baseDelaySeconds: 20,
      maxDelaySeconds: 600,
      jitterRatio: 0.5,
    },
  },
);
