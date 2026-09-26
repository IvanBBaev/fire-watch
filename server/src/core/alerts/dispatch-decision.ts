/**
 * May this claimed row be handed to a provider at all — ADR-004 D2, D6, A1.1, A1.4, A1.9.
 *
 * The gateway is the only sender (D2), which makes it the only place several unrelated
 * rules land: a queue deadline, a liveness re-check, an accountability rule about humans.
 * They are unrelated in origin and ordered on purpose here, and the order is the design:
 *
 *   1. **The deadline first**, because an expired row must close whatever else is wrong
 *      with it. A row that is both too old and unaccountable closes `ttl_expired`, not
 *      `failed` — the send stopped being wanted before anyone could have fixed the
 *      accountability, and closing it as an accountability failure would page an operator
 *      about a queue problem. (`expired_unapproved` never comes from here: an
 *      `awaiting_approval` row is never claimed. It is the sweeper's status, below.)
 *   2. **Liveness second** (A1.9), because `cancelled_erasure` is evidence. A deleted
 *      account's row has to record that the send was *stopped*, and any earlier close
 *      would lose that fact behind a less specific status.
 *   3. **Channel agreement third** (TASKS H5). A live subscription on a different channel
 *      than the row — the subscription was re-pointed, or the decision side bound the
 *      wrong one — would hand one channel's payload to another channel's adapter with an
 *      endpoint of the wrong kind. The row closes `failed` with {@link
 *      CHANNEL_MISMATCH_REASON} and is never sent; nothing about it heals by waiting.
 *   4. **Accountability last** (A1.1, A1.4), because it is the only one that can still
 *      change: a second approver may yet arrive, and the cool-off elapses on its own.
 *
 * **This is the pre-render gate.** D7's never-send lint is not here, and not by
 * oversight: it reads rendered copy, so it can only run after the template renderer, and
 * the gateway applies it there. Splitting the two keeps this function free of the
 * template subsystem and makes "may we send" answerable from the row alone.
 *
 * Budgets, the circuit breaker and the kill switch (D5, H4) are also absent. They gate
 * *claiming* — a row that must not go out today should never reach a worker — and a
 * second enforcement point here would be a second place for the cutoff to disagree with
 * `budget_seq`, which A1.12 stores precisely so it cannot.
 */

import { isDeliverable } from './outbox.js';
import type { DeliveryParams } from '../config/delivery-params.js';
import type { ClaimedOutboxRow } from '../ports/alert-dispatch-queue.js';
import type { OutboxStatus } from '../ports/alert-outbox-store.js';
import type { ResolvedRecipient } from '../ports/recipient-resolver.js';

/** `last_error` for a row whose subscription is on another channel; counted by the gateway. */
export const CHANNEL_MISMATCH_REASON = 'channel_mismatch';

export interface DispatchInput {
  readonly row: ClaimedOutboxRow;
  /** Epoch milliseconds. A parameter, never a clock read — replay claims and closes alike. */
  readonly now: number;
  /** A1.9's re-check, resolved immediately before this call and not at claim time. */
  readonly recipient: ResolvedRecipient;
  readonly params: DeliveryParams;
}

export type DispatchVerdict =
  | {
      readonly action: 'send';
      /**
       * Seconds of life left, not the channel's configured TTL. A push decided 25 minutes
       * ago must reach the provider with 300 s on it, or the provider will happily hold it
       * past the half-hour D6 says a fire alert stops being fresh at.
       */
      readonly ttlSeconds: number;
      /** Epoch ms the row stops being sendable — useful to log next to the outcome. */
      readonly deadlineAt: number;
    }
  | {
      /** Terminal. The row is settled with this status and never claimed again. */
      readonly action: 'close';
      readonly status: OutboxStatus;
      readonly reason: string;
    }
  | {
      /**
       * Not now. The claim is released, the row keeps its status, and a later worker
       * re-reads it. Termination is guaranteed by the deadline in rule 1 — a row that is
       * released forever is released only until it expires.
       */
      readonly action: 'release';
      readonly reason: string;
    };

/**
 * D6's two deadlines, resolved to one instant. The shorter wins: a `push` row lives 1800 s
 * even though the queue would keep it for six hours, and a `telegram` row lives the six
 * hours because no shorter promise is enforceable against that provider.
 */
export function deliveryDeadline(row: ClaimedOutboxRow, params: DeliveryParams): number {
  const channelTtl = params.channelTtlSeconds[row.channel];
  const seconds = Math.min(channelTtl, params.queueExpirySeconds);
  return row.decidedAt + seconds * 1000;
}

export function dispatchVerdict(input: DispatchInput): DispatchVerdict {
  const { row, now, recipient, params } = input;
  // The clock is checked before the row: every branch below is arithmetic on `now`, so a
  // `NaN` would not raise, it would silently make every comparison false and send an
  // expired alert with a `NaN` TTL.
  if (!Number.isFinite(now)) {
    throw new RangeError(`now must be a finite epoch, got ${String(now)}`);
  }
  if (row.status !== 'claimed') {
    // The queue hands out claimed rows and nothing else. Anything here is a caller that
    // read the queue instead of claiming it — the exact bug D2's port split prevents.
    throw new TypeError(`row ${row.id} is ${row.status}, not claimed`);
  }

  const deadlineAt = deliveryDeadline(row, params);
  if (now >= deadlineAt) {
    return {
      action: 'close',
      status: 'ttl_expired',
      reason: `decided ${String(Math.round((now - row.decidedAt) / 1000))}s ago; ${row.channel} deadline is ${String(Math.round((deadlineAt - row.decidedAt) / 1000))}s`,
    };
  }

  if (!recipient.live) {
    return { action: 'close', status: 'cancelled_erasure', reason: recipient.reason };
  }

  if (recipient.channel !== row.channel) {
    return {
      action: 'close',
      status: 'failed',
      reason: `${CHANNEL_MISMATCH_REASON}: row is ${row.channel}, subscription is ${recipient.channel}`,
    };
  }

  const verdict = isDeliverable(row);
  if (!verdict.deliverable) {
    // Only the cool-off heals by itself. The rest are a row that was written wrong or
    // approved wrong; releasing them would spin the worker until the deadline and settle
    // on `ttl_expired`, which says nothing about the accountability failure that was the
    // actual reason nobody was told about a fire.
    if (verdict.reason === 'cooloff_not_served') {
      return { action: 'release', reason: verdict.reason };
    }
    return { action: 'close', status: 'failed', reason: verdict.reason };
  }

  return { action: 'send', ttlSeconds: Math.ceil((deadlineAt - now) / 1000), deadlineAt };
}

/**
 * The approval-queue sweeper's predicate (A1.12) — the one deadline this module owns that
 * the dispatch path never sees, because an `awaiting_approval` row is never claimed.
 *
 * It is here rather than in the sweeper so that both deadlines are read from the same
 * config in the same file: an approval window that silently outlived the queue expiry
 * would produce approvals granted for rows that had already died.
 *
 * Note the asymmetry, which is a consequence of D6 rather than a choice made here: this
 * predicate is channel-blind and uses the six-hour queue expiry, while dispatch closes on
 * the *shorter* per-channel deadline. A `push` row therefore has a real approval window
 * of 1800 s, not six hours — and A1.4's 900 s solo cool-off consumes half of it. A solo
 * approval submitted after the thirtieth minute is already dead; it will not be caught
 * here, it will close `ttl_expired` at the first claim. Both outcomes page under A1.12,
 * so nothing is lost silently, but an operator racing a push approval has half an hour
 * and should be told so rather than discovering it.
 */
export function hasExpiredUnapproved(
  row: Pick<ClaimedOutboxRow, 'status' | 'decidedAt'>,
  now: number,
  params: DeliveryParams,
): boolean {
  if (row.status !== 'awaiting_approval') {
    return false;
  }
  return now >= row.decidedAt + params.queueExpirySeconds * 1000;
}
