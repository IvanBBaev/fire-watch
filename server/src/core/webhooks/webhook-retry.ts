/**
 * The webhook channel's retry and auto-disable rules (TASKS V2-G2): pure, so the schedule
 * a delivery log row shows can be recomputed from the row and `webhook_params_v1`.
 *
 * ## Where the retry runs
 *
 * Not in a loop of its own. A webhook delivery is an alert outbox row like any other; a
 * failed attempt reports `transient` to the gateway, which releases the row, and the
 * dispatch loop claims it again on its next tick. The channel adapter then asks
 * {@link nextAttemptDue} whether the backoff has elapsed and, if not, releases the row
 * again without touching the network. So the outbox, the gateway and the dispatch loop
 * stay exactly as they are; the schedule lives with the channel that owns it.
 *
 * ## The schedule
 *
 * Exponential with **full jitter** (wait = random × min(max, base × 2^(n−1))): receivers
 * that went down together do not come back to a synchronised thundering herd of retries.
 * The randomness is injected so a test can pin it.
 *
 * ## HTTP outcomes
 *
 * `2xx` is delivered. `410 Gone` is the receiver saying the endpoint is retired: disable
 * now. Other `4xx` (except `408` and `429`) mean this request will never be accepted —
 * retrying it is noise — so the delivery fails at once, though it still counts toward
 * auto-disable. `408`, `429`, `5xx`, timeouts and network errors are retried.
 */

import type { WebhookParams } from '../config/webhook-params.js';

export type WebhookAttemptClass = 'delivered' | 'retry' | 'reject' | 'gone';

/** How one attempt's result is treated. `status` is null for a timeout or network error. */
export function classifyWebhookAttempt(status: number | null): WebhookAttemptClass {
  if (status === null) return 'retry';
  if (status >= 200 && status < 300) return 'delivered';
  if (status === 410) return 'gone';
  if (status === 408 || status === 429 || status >= 500) return 'retry';
  return 'reject';
}

/**
 * The wait after the `attempt`-th failed attempt (1-based), in ms. `random` returns a value
 * in [0, 1).
 */
export function backoffDelayMs(
  attempt: number,
  params: Pick<WebhookParams, 'backoffBaseMs' | 'backoffMaxMs'>,
  random: () => number,
): number {
  if (!Number.isSafeInteger(attempt) || attempt < 1) {
    throw new RangeError('attempt is a positive integer');
  }
  const exponent = Math.min(attempt - 1, 30);
  const ceiling = Math.min(params.backoffMaxMs, params.backoffBaseMs * 2 ** exponent);
  const r = random();
  const unit = r >= 0 && r < 1 ? r : 0;
  return Math.floor(unit * ceiling);
}

/** The upper bound on the time from the first attempt to the last, before jitter. */
export function worstCaseRetrySpanMs(
  params: Pick<WebhookParams, 'backoffBaseMs' | 'backoffMaxMs' | 'maxAttempts'>,
): number {
  let total = 0;
  for (let attempt = 1; attempt < params.maxAttempts; attempt += 1) {
    total += Math.min(params.backoffMaxMs, params.backoffBaseMs * 2 ** Math.min(attempt - 1, 30));
  }
  return total;
}

export interface PreviousAttempt {
  /** 1-based number of the most recent attempt of this delivery. */
  readonly attempt: number;
  /** When the next attempt may run, or null when the last attempt left none to run. */
  readonly nextAttemptAt: number | null;
}

export type AttemptGate =
  | { readonly kind: 'attempt'; readonly attempt: number }
  | { readonly kind: 'wait'; readonly untilMs: number }
  | { readonly kind: 'exhausted' };

/** Whether a re-claimed delivery may make its next attempt now. */
export function nextAttemptDue(
  previous: PreviousAttempt | null,
  nowMs: number,
  params: Pick<WebhookParams, 'maxAttempts'>,
): AttemptGate {
  if (previous === null) return { kind: 'attempt', attempt: 1 };
  if (previous.attempt >= params.maxAttempts || previous.nextAttemptAt === null) {
    return { kind: 'exhausted' };
  }
  if (nowMs < previous.nextAttemptAt) return { kind: 'wait', untilMs: previous.nextAttemptAt };
  return { kind: 'attempt', attempt: previous.attempt + 1 };
}

/** Whether `consecutiveFailures` (after this attempt) disables the endpoint. */
export function shouldAutoDisable(
  consecutiveFailures: number,
  params: Pick<WebhookParams, 'disableAfterConsecutiveFailures'>,
): boolean {
  return consecutiveFailures >= params.disableAfterConsecutiveFailures;
}
