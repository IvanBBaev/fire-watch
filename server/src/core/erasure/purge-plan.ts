/**
 * The retention purge planner (TASKS I4): which rows past their retention the purge job
 * deletes this run, and which targets are not armed.
 *
 * **Six retentions are armed; the ledger's stays null, on purpose.** Founder decision
 * 2026-10-30 (`docs/decisions/founder-2026-10-30/thresholds-ops.md`, I4) set the six
 * operational retentions by data minimisation: each row is kept as long as an operational
 * question can still need it, and no longer. They are provisional, sit at or above their
 * floors, and move only by PR. The erasure ledger's lifetime is an accountability question
 * for the founder and counsel, so it stays null — reported `armed: false`, deleting
 * nothing — until counsel answers. The planner holds every armed value to its floor.
 *
 * **`alert_digest_log` (migration 018) is purged only around its watermark.** Its newest
 * spent window per account *is* the digest watermark, so a plain age cutoff would reset it
 * and re-owe yesterday's window. Migration 019's `purge_alert_digest_log` therefore never
 * deletes a row of an account's newest spent window (or of any later one), whatever its
 * age; older rows go once they pass the retention, and the table is still erased with the
 * account (`erasure-plan.ts`).
 *
 * **Floors are what the system itself needs, not policy.** A ledger row must outlive the
 * erasure horizon, because it is what a restore from inside the backup window replays; a
 * link request must outlive the issue-rate window, because the rate limit counts it. A
 * retention below its floor is refused outright rather than clamped — a silently raised
 * number is a number nobody chose.
 */

import { AUTH_POLICY } from '../auth/auth-policy.js';
import { DELIVERY_PARAMS } from '../config/delivery-params.js';
import { WEBHOOK_PARAMS } from '../config/webhook-params.js';
import { isoFromEpochMs, type EpochMs } from '../ports/clock.js';
import { ERASURE_HORIZON } from './erasure-horizon.js';

const DAY_MS = 86_400_000;

export const PURGE_TARGETS = [
  'erasure_ledger',
  'expired_link_requests',
  'ended_sessions',
  'account_tombstones',
  'alert_decision_log',
  'alert_digest_log',
  'webhook_deliveries',
] as const;

export type PurgeTarget = (typeof PURGE_TARGETS)[number];

/** Retention in whole days per target, measured from the target's anchor; null = unarmed. */
export type PurgeRetention = Readonly<Record<PurgeTarget, number | null>>;

export const PURGE_RETENTION: PurgeRetention = {
  // Open, still an owner action: an accountability record whose lifetime counsel decides.
  erasure_ledger: null,
  // 30 days: the proposal in docs/legal/ropa.md §3.2. 05 §5.4.1's 15-minute TTL ends the
  // request's use; a month leaves room for an abuse review of sign-in mail, far above the
  // 1 h issue-window floor.
  expired_link_requests: 30,
  // 30 days: the proposal in docs/legal/ropa.md §3.3, one more 05 §5.4.1 sliding expiry,
  // so a "was that me?" question about a session that just ended can still be answered.
  ended_sessions: 30,
  // 30 days: the erasure horizon. The scrubbed row outlives every request in flight and
  // every restore the backup window can replay.
  account_tombstones: ERASURE_HORIZON.horizonDays,
  // 400 days: one whole fire season plus the start of the next, so "why no alert?" (TASKS
  // H7) about last season stays answerable at the post-season review.
  alert_decision_log: 400,
  // 90 days: a digest decision matters for a few cycles. The watermark is protected
  // structurally by the function, not by this number.
  alert_digest_log: 90,
  // `webhook_params_v1.deliveryLogRetentionDays` (30 days, TASKS V2-G2): the owner's
  // debugging aid, long after the retry schedule has given up.
  webhook_deliveries: WEBHOOK_PARAMS.values.deliveryLogRetentionDays,
};

export interface PurgeTargetSpec {
  /** The column the retention is measured from, as the adapter names it. */
  readonly anchor: string;
  /** Smallest retention the system can tolerate, in milliseconds. */
  readonly floorMs: number;
  readonly floorReason: string;
}

export const PURGE_TARGET_SPECS: Readonly<Record<PurgeTarget, PurgeTargetSpec>> = {
  erasure_ledger: {
    anchor: 'erased_at',
    floorMs: ERASURE_HORIZON.horizonDays * DAY_MS,
    floorReason: 'a restore inside the erasure horizon replays the ledger',
  },
  expired_link_requests: {
    anchor: 'expires_at',
    floorMs: AUTH_POLICY.linkIssueWindowMs,
    floorReason: 'the per-address issue limit counts requests inside its window',
  },
  ended_sessions: {
    anchor: 'coalesce(revoked_at, expires_at)',
    floorMs: 0,
    floorReason: 'an ended session authenticates nothing',
  },
  account_tombstones: {
    anchor: 'deleted_at',
    floorMs: 0,
    floorReason: 'the tombstone only has to outlive requests already in flight at erasure',
  },
  alert_decision_log: {
    anchor: 'decided_at',
    floorMs: 0,
    floorReason:
      'nothing in the system reads an old decision back; how long an explanation stays answerable is policy, not a floor',
  },
  alert_digest_log: {
    anchor: 'decided_at',
    floorMs: 0,
    floorReason:
      'the pass reads back only the newest spent window per account, which the purge function never deletes',
  },
  webhook_deliveries: {
    anchor: 'attempted_at',
    floorMs: DELIVERY_PARAMS.values.queueExpirySeconds * 1000,
    floorReason:
      'the newest attempt of a delivery is its retry schedule until the outbox row expires',
  },
};

export type PurgeStep =
  | { readonly target: PurgeTarget; readonly armed: false }
  | {
      readonly target: PurgeTarget;
      readonly armed: true;
      readonly retentionDays: number;
      /** Rows whose anchor is strictly before this instant are deleted. */
      readonly cutoffIso: string;
    };

export class PurgeRetentionError extends Error {
  constructor(target: PurgeTarget, detail: string) {
    super(`purge retention for ${target} refused: ${detail}`);
    this.name = 'PurgeRetentionError';
  }
}

/** One step per target, in {@link PURGE_TARGETS} order. Throws on a retention below its floor. */
export function planPurge(
  at: EpochMs,
  retention: PurgeRetention = PURGE_RETENTION,
): readonly PurgeStep[] {
  return PURGE_TARGETS.map((target): PurgeStep => {
    const days = retention[target];
    if (days === null) return { target, armed: false };
    if (!Number.isInteger(days) || days < 0) {
      throw new PurgeRetentionError(target, 'must be a whole, non-negative number of days');
    }
    const spec = PURGE_TARGET_SPECS[target];
    const retentionMs = days * DAY_MS;
    if (retentionMs < spec.floorMs) {
      throw new PurgeRetentionError(target, `below its floor (${spec.floorReason})`);
    }
    return {
      target,
      armed: true,
      retentionDays: days,
      cutoffIso: isoFromEpochMs(at - retentionMs),
    };
  });
}

export interface PurgeStepReport {
  readonly armed: boolean;
  readonly cutoff?: string;
  readonly deleted?: number;
  /** True when the per-run row cap was reached and more rows are due. */
  readonly more?: boolean;
}

export interface PurgeReport {
  readonly at: string;
  readonly targets: Readonly<Record<PurgeTarget, PurgeStepReport>>;
}

export interface PurgeExecutor {
  /** Deletes up to `limit` rows of `target` anchored before `cutoffIso`; resolves the count. */
  purge(target: PurgeTarget, cutoffIso: string, limit: number): Promise<number>;
}

export const PURGE_ROW_LIMIT = 1_000;

/** Runs a plan against an executor, target by target, and reports every target. */
export async function runPurge(
  at: EpochMs,
  executor: PurgeExecutor,
  retention: PurgeRetention = PURGE_RETENTION,
  limit: number = PURGE_ROW_LIMIT,
): Promise<PurgeReport> {
  const steps = planPurge(at, retention);
  const targets = {} as Record<PurgeTarget, PurgeStepReport>;
  for (const step of steps) {
    if (!step.armed) {
      targets[step.target] = { armed: false };
      continue;
    }
    const deleted = await executor.purge(step.target, step.cutoffIso, limit);
    targets[step.target] = { armed: true, cutoff: step.cutoffIso, deleted, more: deleted >= limit };
  }
  return { at: isoFromEpochMs(at), targets };
}
