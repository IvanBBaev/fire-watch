/**
 * Enqueue outbox drafts and count the ones that entered `awaiting_approval` (A1.12;
 * TASKS C5).
 *
 * A1.12: "Deferrals are visible, never silent" — `fw_alert_sends_deferred_total{reason}`
 * counts *rows entering* `awaiting_approval`. Entering is the word that matters: a draft
 * the A1.11 key already holds is a redelivery of a decision taken before, and counting it
 * again would make a rolled-back-and-retried batch look like a second mass-notification.
 * {@link EnqueueResult} only says how many of a call's drafts were new, so the awaiting
 * drafts are enqueued in calls of their own, one per reason, and each call's `inserted` is
 * exactly that reason's entering rows. Everything else keeps going through one call, in the
 * order it was handed in, so a batch with nothing deferred enqueues exactly as it did
 * before this existed.
 *
 * Every write path into the outbox goes through here, so that a new route into
 * `awaiting_approval` is counted the day it is written. Today that is the evaluation cycle
 * alone, which writes every row `pending` while D5's budget B is unarmed — the counter is
 * produced, at zero, until B or the manual broadcast is armed.
 */

import {
  ALERT_DEFERRAL_REASONS,
  alertDeferralReasonFor,
  type AlertDeferralReason,
} from '../observability/alert-metrics.js';
import type { AlertOutboxStore, OutboxRowDraft } from '../ports/alert-outbox-store.js';

export interface CountedEnqueueResult {
  /** Rows the database did not already hold, deferred ones included. */
  readonly inserted: number;
  readonly alreadyDecided: number;
  /** Newly inserted `awaiting_approval` rows, by reason; every reason present, zeros too. */
  readonly deferred: Readonly<Record<AlertDeferralReason, number>>;
}

export function noDeferrals(): Record<AlertDeferralReason, number> {
  return Object.fromEntries(ALERT_DEFERRAL_REASONS.map((reason) => [reason, 0])) as Record<
    AlertDeferralReason,
    number
  >;
}

export async function enqueueCountingDeferrals(
  outbox: Pick<AlertOutboxStore, 'enqueue'>,
  drafts: readonly OutboxRowDraft[],
): Promise<CountedEnqueueResult> {
  const released: OutboxRowDraft[] = [];
  const awaiting = new Map<AlertDeferralReason, OutboxRowDraft[]>();
  for (const draft of drafts) {
    const reason = alertDeferralReasonFor(draft);
    if (reason === null) {
      released.push(draft);
      continue;
    }
    const held = awaiting.get(reason);
    if (held === undefined) awaiting.set(reason, [draft]);
    else held.push(draft);
  }

  let inserted = 0;
  let alreadyDecided = 0;
  const deferred = noDeferrals();
  if (released.length > 0) {
    const result = await outbox.enqueue(released);
    inserted += result.inserted;
    alreadyDecided += result.alreadyDecided;
  }
  for (const reason of ALERT_DEFERRAL_REASONS) {
    const rows = awaiting.get(reason);
    if (rows === undefined) continue;
    const result = await outbox.enqueue(rows);
    inserted += result.inserted;
    alreadyDecided += result.alreadyDecided;
    deferred[reason] += result.inserted;
  }
  return { inserted, alreadyDecided, deferred };
}
