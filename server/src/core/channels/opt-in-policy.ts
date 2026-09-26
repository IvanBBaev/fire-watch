/**
 * The double-opt-in policy for alert channels, as pure functions (TASKS I3; ADR-004 D6,
 * D8 as amended by A16; 05 §5.5.3; migration 012).
 *
 * **The state machine.** A confirmation — the pending-verification record 05 §5.5.3 names
 * — is issued `pending` and ends in exactly one of:
 *
 *   * `confirmed` — its token was presented, once, before it expired; the subscription it
 *     names (or, for Telegram, the one the `/start` created) becomes dispatchable;
 *   * `expired` — its time ran out unconsumed. Not a column: a function of `at`;
 *   * `superseded` — a newer confirmation was issued for the same endpoint;
 *   * `revoked` — the channel was unlinked while the confirmation was still open.
 *
 * Every ending is terminal. The token is single-use (the store's conditional write is the
 * guard), hashed at rest (the store never sees it), and time-bounded (`expiresAt`).
 * **A channel is never dispatchable until confirmed**: the recipient resolver answers
 * `live: false` for a subscription whose `confirmed_at` is null.
 *
 * **What is stated, and what ships unarmed.** 05 §5.5.3 gives the email numbers — pending
 * records expire in 48 h, verification mails ≤ 3/address/day. It gives no TTL or re-send
 * limit for a Telegram deep link, and no confirmation mechanism for push beyond "enable on
 * this device" (07 P15). Those are `null` below, and a channel whose values are null is
 * **unarmed**: {@link decideConfirmationIssue} refuses every issuance for it, so the
 * missing decision fails closed instead of being guessed. They are founder decisions.
 */

import type { OptInChannel } from '../ports/channel-opt-in-store.js';
import type { EpochMs } from '../ports/clock.js';

export type { OptInChannel };

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

export interface ChannelOptInRule {
  /** How long a pending confirmation stays usable. Null: unarmed. */
  readonly pendingTtlMs: number | null;
  /** Issuances allowed per window, per address (email) or per account (Telegram). Null: unarmed. */
  readonly issuesPerWindow: number | null;
  readonly issueWindowMs: number;
}

export const CHANNEL_OPT_IN_POLICY: Readonly<Record<OptInChannel, ChannelOptInRule>> = {
  email: {
    /** "Pending-verification records expire in 48 h" (05 §5.5.3). */
    pendingTtlMs: 48 * HOUR_MS,
    /** "Verification mails ≤ 3/address/day" (05 §5.5.3). */
    issuesPerWindow: 3,
    issueWindowMs: DAY_MS,
  },
  /** Deep-link TTL and re-send limit: not stated anywhere. Founder decision. */
  telegram: { pendingTtlMs: null, issuesPerWindow: null, issueWindowMs: DAY_MS },
  /** The push confirmation mechanism itself is open (07 P15). Founder decision. */
  push: { pendingTtlMs: null, issuesPerWindow: null, issueWindowMs: DAY_MS },
};

/** Armed means every value the rule needs is set; one null keeps the channel closed. */
export function isChannelArmed(rule: ChannelOptInRule): boolean {
  return rule.pendingTtlMs !== null && rule.issuesPerWindow !== null;
}

// ── Issuance ─────────────────────────────────────────────────────────────────────────

export type ConfirmationIssueDecision =
  | { readonly allowed: true; readonly expiresAt: EpochMs }
  | { readonly allowed: false; readonly reason: 'unarmed' }
  | {
      readonly allowed: false;
      readonly reason: 'rate_limited';
      readonly retryAfterSeconds: number;
    };

/**
 * Whether a confirmation may be issued now. `recentIssuedAt` is every issuance in the
 * rule's window for the same key (the store's query bounds it); the one past the limit is
 * refused and told when the oldest leaves the window.
 */
export function decideConfirmationIssue(
  rule: ChannelOptInRule,
  recentIssuedAt: readonly EpochMs[],
  at: EpochMs,
): ConfirmationIssueDecision {
  if (rule.pendingTtlMs === null || rule.issuesPerWindow === null) {
    return { allowed: false, reason: 'unarmed' };
  }
  const windowStart = at - rule.issueWindowMs;
  const inWindow = recentIssuedAt.filter((issued) => issued > windowStart && issued <= at);
  if (inWindow.length < rule.issuesPerWindow) {
    return { allowed: true, expiresAt: at + rule.pendingTtlMs };
  }
  const freeAt = Math.min(...inWindow) + rule.issueWindowMs;
  return {
    allowed: false,
    reason: 'rate_limited',
    retryAfterSeconds: Math.max(1, Math.ceil((freeAt - at) / 1000)),
  };
}

// ── State ────────────────────────────────────────────────────────────────────────────

/** A confirmation, as the policy needs to see it. */
export interface ConfirmationRecord {
  readonly channel: OptInChannel;
  readonly expiresAt: EpochMs;
  readonly consumedAt: EpochMs | null;
  readonly supersededAt: EpochMs | null;
  readonly revokedAt: EpochMs | null;
}

export type ConfirmationState = 'pending' | 'confirmed' | 'expired' | 'superseded' | 'revoked';

/**
 * The state at `at`. The recorded endings win over expiry: a token consumed an hour before
 * it would have expired stays `confirmed` forever.
 */
export function confirmationState(record: ConfirmationRecord, at: EpochMs): ConfirmationState {
  if (record.consumedAt !== null) return 'confirmed';
  if (record.revokedAt !== null) return 'revoked';
  if (record.supersededAt !== null) return 'superseded';
  if (at >= record.expiresAt) return 'expired';
  return 'pending';
}

export type ConfirmationRefusal =
  'unknown' | 'used' | 'revoked' | 'superseded' | 'expired' | 'wrong_channel' | 'account_deleted';

/**
 * Whether a presented token may be consumed for `channel`. Ordered so the reason is one a
 * person can act on: a used token is "used" even after it has also expired. A token for a
 * different channel is "unknown" to the caller in effect, but named separately so a
 * post-mortem can tell a mis-wired route from a guessed token.
 */
export function evaluateConfirmation(
  record: (ConfirmationRecord & { readonly accountDeleted: boolean }) | null,
  channel: OptInChannel,
  at: EpochMs,
): ConfirmationRefusal | null {
  if (record === null) return 'unknown';
  if (record.channel !== channel) return 'wrong_channel';
  if (record.accountDeleted) return 'account_deleted';
  const state = confirmationState(record, at);
  if (state === 'confirmed') return 'used';
  if (state === 'pending') return null;
  return state;
}

/**
 * Dispatchability as the resolver reads it, stated once in the core: confirmed and not
 * revoked. The pg resolver implements the same rule in SQL (`confirmed_at` and
 * `revoked_at` of `channel_subscriptions`).
 */
export function isSubscriptionDispatchable(subscription: {
  readonly confirmedAt: EpochMs | null;
  readonly revokedAt: EpochMs | null;
}): boolean {
  return subscription.confirmedAt !== null && subscription.revokedAt === null;
}
