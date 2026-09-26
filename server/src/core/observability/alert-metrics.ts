/**
 * A1.12's deferral instrumentation - the three series and the two pages that keep a
 * held-back mass-notification from being a silent one.
 *
 *   > **Deferrals are visible, never silent.** Added to D9's instrumentation:
 *   > `fw_alert_sends_deferred_total{reason}` (rows entering `awaiting_approval`),
 *   > `fw_alert_approval_pending_seconds` (age of the oldest awaiting row), and
 *   > `fw_alert_sends_dropped_total{reason}` with
 *   > `reason in {expired_unapproved, ttl_expired}` for approvals landing after the 6 h
 *   > queue expiry or the 1800 s push TTL. **Pages:** oldest awaiting row > 30 min (a
 *   > mass-notification decision is waiting on a human); any `sends_dropped` increment (an
 *   > approval that arrived too late is an incident, not a log line).
 *
 * **This is the first metrics module in the repo, so it sets a shape.** There is no
 * registry client anywhere in `server/src` yet, and there must not be one in `core`: a
 * Prometheus registry is a process-global with I/O, and this package is pure. What core
 * can own is the part that is policy rather than plumbing - what the series are called,
 * which label values are legal, and the arithmetic that turns a sample into a page. An
 * exporter adapter, when it lands, reads these declarations; it does not restate them.
 * The names are declared as data for the same reason the configs are: a metric name
 * spelled twice is a dashboard that goes blank on the day someone fixes the typo.
 *
 * The paging deadline is not here either - it is `approvalPendingPageMs` in
 * `alert_budgets_v1`, next to the B ceiling whose consequence it measures, so that a
 * threshold change is a config diff under D5's PR rule rather than a constant edited in a
 * metrics file.
 *
 * **What is deliberately *not* here.** D9's correctness metrics (DAR, FER, FLR, PCR, PLB)
 * live under `core/qa/` with their own versioned parameters; D6's
 * `fw_notification_queue_oldest_seconds` is calibrated by `delivery_params_v1` and belongs
 * with the dispatch path. This module is A1.12's three series and nothing else - the ones
 * that exist because a decision was made and *not* acted on.
 */

import { ALERT_BUDGETS, clampToShipped, type AlertBudgetParams } from '../config/alert-budgets.js';
import type { OutboxRowDraft } from '../ports/alert-outbox-store.js';

export interface MetricDescriptor {
  /** The exported series name. Fully spelled out, never assembled from parts. */
  readonly name: string;
  readonly kind: 'counter' | 'gauge';
  readonly help: string;
  readonly labels: readonly string[];
}

/**
 * Why a row is waiting for a human.
 *
 * A1.12 labels the counter `{reason}` and never enumerates the values, unlike
 * `sends_dropped` where it fixes the set. These two are the only ways a row can reach
 * `awaiting_approval` in the pipeline as built: the B cut defers rank > B
 * (`budget-cutoff.ts`), and a manual broadcast is written awaiting its approver
 * (`outbox.ts` `manualOutboxRow`, A1.1/A1.4). They are enumerated here rather than left
 * open so that a third route into `awaiting_approval` has to be named before it can be
 * counted - an unlabelled deferral is the silent deferral this metric exists to prevent.
 */
export const ALERT_DEFERRAL_REASONS = ['over_budget_b', 'manual_approval'] as const;
export type AlertDeferralReason = (typeof ALERT_DEFERRAL_REASONS)[number];

/**
 * The deferral reason an outbox row is written under, or `null` when it is not deferred.
 *
 * "Rows entering `awaiting_approval`" is A1.12's definition, so the status decides whether
 * a row counts and the trigger decides which reason: a manual row waits for its second
 * human (A1.1/A1.4), every other awaiting row was cut by budget B. A decision's `defer`
 * outcome (quiet hours, digest floor — H7's decision log) is not one of these: it writes
 * no outbox row at all, and it is not waiting for a human.
 */
export function alertDeferralReasonFor(
  row: Pick<OutboxRowDraft, 'status' | 'triggerType'>,
): AlertDeferralReason | null {
  if (row.status !== 'awaiting_approval') return null;
  return row.triggerType === 'manual' ? 'manual_approval' : 'over_budget_b';
}

/** A1.12's fixed set: "reason in {expired_unapproved, ttl_expired}". */
export const ALERT_DROP_REASONS = ['expired_unapproved', 'ttl_expired'] as const;
export type AlertDropReason = (typeof ALERT_DROP_REASONS)[number];

/**
 * The drop reason an outbox status is, if it is one. The two A1.12 reasons are outbox
 * statuses of the same spelling (`OUTBOX_STATUSES`), so a row closed under either is a
 * drop and every other status is not.
 */
export function alertDropReasonFor(status: string): AlertDropReason | null {
  return (ALERT_DROP_REASONS as readonly string[]).includes(status)
    ? (status as AlertDropReason)
    : null;
}

export const ALERT_SENDS_DEFERRED_TOTAL: MetricDescriptor = {
  name: 'fw_alert_sends_deferred_total',
  kind: 'counter',
  help: 'Outbox rows entering awaiting_approval, by why they are waiting for a human.',
  labels: ['reason'],
};

export const ALERT_APPROVAL_PENDING_SECONDS: MetricDescriptor = {
  name: 'fw_alert_approval_pending_seconds',
  kind: 'gauge',
  help: 'Age in seconds of the oldest outbox row still awaiting approval; 0 when none is.',
  labels: [],
};

export const ALERT_SENDS_DROPPED_TOTAL: MetricDescriptor = {
  name: 'fw_alert_sends_dropped_total',
  kind: 'counter',
  help: 'Sends that died before going out, by whether the approval or the send window ran out.',
  labels: ['reason'],
};

export const ALERT_DEFERRAL_METRICS: readonly MetricDescriptor[] = [
  ALERT_SENDS_DEFERRED_TOTAL,
  ALERT_APPROVAL_PENDING_SECONDS,
  ALERT_SENDS_DROPPED_TOTAL,
];

/**
 * The gauge, from the oldest awaiting row's `decided_at`.
 *
 * Rounded down to whole seconds, and floored at zero: a `decided_at` in the future is
 * clock skew between the decider and the reporter, and a negative age would make the
 * threshold comparison below read as "no backlog" at exactly the moment the clocks are
 * untrustworthy. A non-finite `now` throws, because every branch here is arithmetic on it
 * and a `NaN` gauge would quietly never page.
 */
export function approvalPendingSeconds(
  oldestAwaitingDecidedAt: number | null,
  now: number,
): number {
  if (!Number.isFinite(now)) {
    throw new RangeError(`now must be a finite epoch, got ${String(now)}`);
  }
  if (oldestAwaitingDecidedAt === null) {
    return 0;
  }
  if (!Number.isFinite(oldestAwaitingDecidedAt)) {
    throw new RangeError(
      `oldestAwaitingDecidedAt must be a finite epoch or null, got ${String(oldestAwaitingDecidedAt)}`,
    );
  }
  return Math.max(0, Math.floor((now - oldestAwaitingDecidedAt) / 1000));
}

export interface AlertDeferralSample {
  /** Epoch ms the sample was taken. A parameter, never a clock read. */
  readonly now: number;
  /** `decided_at` of the oldest `awaiting_approval` row, or `null` if there is none. */
  readonly oldestAwaitingDecidedAt: number | null;
  /**
   * How much each `fw_alert_sends_dropped_total` series moved since the previous sample.
   * A1.12 pages on *any* increment, so this is a delta and not a total: a counter read
   * that is merely large says an incident happened once, a delta says it is happening now.
   */
  readonly droppedSinceLastSample: Readonly<Record<AlertDropReason, number>>;
}

export type AlertPageRule = 'approval_pending' | 'sends_dropped';

export interface AlertPage {
  readonly rule: AlertPageRule;
  /** The series the on-call person should look at first. */
  readonly metric: string;
  /** One line, for the page body. Never parsed. */
  readonly detail: string;
}

/**
 * A1.12's two pages, evaluated against one sample.
 *
 * Both are incidents in the strict sense - a human is already late, or a send that a
 * human authorised has died - so this returns every rule that fires rather than the worst
 * one. They are different failures with different fixes: one needs an approval, the other
 * needs a post-mortem.
 */
export function alertDeferralPages(
  sample: AlertDeferralSample,
  params: AlertBudgetParams = ALERT_BUDGETS.values,
): readonly AlertPage[] {
  const budgets = clampToShipped(params);
  const pages: AlertPage[] = [];

  const pendingSeconds = approvalPendingSeconds(sample.oldestAwaitingDecidedAt, sample.now);
  const thresholdSeconds = Math.floor(budgets.approvalPendingPageMs / 1000);
  if (pendingSeconds > thresholdSeconds) {
    pages.push({
      rule: 'approval_pending',
      metric: ALERT_APPROVAL_PENDING_SECONDS.name,
      detail:
        `oldest awaiting_approval row is ${String(pendingSeconds)}s old (threshold ` +
        `${String(thresholdSeconds)}s); a mass-notification decision is waiting on a human`,
    });
  }

  const dropped = ALERT_DROP_REASONS.map((reason) => {
    const delta = sample.droppedSinceLastSample[reason];
    if (!Number.isInteger(delta) || delta < 0) {
      throw new RangeError(
        `droppedSinceLastSample.${reason} must be a non-negative integer, got ${String(delta)}`,
      );
    }
    return { reason, delta };
  }).filter((entry) => entry.delta > 0);

  if (dropped.length > 0) {
    pages.push({
      rule: 'sends_dropped',
      metric: ALERT_SENDS_DROPPED_TOTAL.name,
      detail: dropped
        .map((entry) => `${String(entry.delta)} ${entry.reason}`)
        .join(', ')
        .concat('; an approval that arrived too late is an incident, not a log line'),
    });
  }

  return pages;
}
