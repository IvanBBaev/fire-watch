/**
 * ADR-004 D6's per-channel send rates, as bucket parameters.
 *
 * These sit with the adapters rather than in `core/config/delivery-params.ts` because
 * they are not policy about the alert — a TTL or a queue expiry changes what the user
 * experiences and is versioned for replay — but facts about three providers' ceilings,
 * chosen below each one's published limit so that our own pacing, not the provider's
 * 429, is what normally meters a burst (04-sre §5 "channel realities"):
 *
 *   - **web push 300/s.** Push services are effectively unmetered per sender; the number
 *     bounds our outbound concurrency and the fan-out cost of one hot zone, not a quota.
 *   - **Telegram 25/s.** Bot API: ~30 messages/s overall, 1/s per chat, and a 429 with
 *     `retry_after` that must be honoured exactly. 25 leaves headroom for the per-chat
 *     rule and for a second process (a migration, a manual send) sharing the token.
 *   - **email 12/s.** SES starts at 14/s in production and 1/s in the sandbox; 12 is
 *     below the production default so the first day out of the sandbox does not begin
 *     with throttling errors (GATES L-6 is the quota raise).
 *
 * The queue is processed one row at a time by the gateway, so a bucket that says "wait
 * 40 ms" is a 40 ms wait; the wait ceiling in {@link RATE_LIMIT_MAX_WAIT_MS} is what
 * keeps a starved channel from stalling every other channel's rows behind it.
 */

import type { AlertChannel } from '../../../core/ports/alert-outbox-store.js';

export interface ChannelRate {
  readonly ratePerSecond: number;
  readonly burst: number;
}

export const CHANNEL_RATES: Readonly<Record<AlertChannel, ChannelRate>> = {
  push: { ratePerSecond: 300, burst: 300 },
  telegram: { ratePerSecond: 25, burst: 25 },
  email: { ratePerSecond: 12, burst: 12 },
};

/**
 * Longest a rate-limited wrapper will hold a row waiting for a token before it releases
 * the row as `transient` and lets the gateway move on.
 *
 * Two seconds is one queue tick at the busiest rate and well inside D6's 60 s dispatch
 * SLO; a row that cannot get a token in that time is behind a burst the bucket was sized
 * to exclude, and holding the gateway for it would delay the push rows queued behind it
 * — which is the one ordering D6 forbids (push has the shortest TTL).
 */
export const RATE_LIMIT_MAX_WAIT_MS = 2_000;
