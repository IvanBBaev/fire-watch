import { describe, expect, it } from 'vitest';

import {
  ALERT_APPROVAL_PENDING_SECONDS,
  ALERT_DEFERRAL_METRICS,
  ALERT_DEFERRAL_REASONS,
  ALERT_DROP_REASONS,
  ALERT_SENDS_DEFERRED_TOTAL,
  ALERT_SENDS_DROPPED_TOTAL,
  alertDeferralPages,
  alertDeferralReasonFor,
  alertDropReasonFor,
  approvalPendingSeconds,
  type AlertDeferralSample,
} from './alert-metrics.js';
import { ALERT_BUDGETS, type AlertBudgetParams } from '../config/alert-budgets.js';
import { OUTBOX_STATUSES } from '../ports/alert-outbox-store.js';

const NOW = Date.UTC(2026, 7, 14, 12, 0, 0);

function budgets(patch: Partial<AlertBudgetParams>): AlertBudgetParams {
  return { ...ALERT_BUDGETS.values, ...patch };
}

function sample(patch: Partial<AlertDeferralSample> = {}): AlertDeferralSample {
  return {
    now: NOW,
    oldestAwaitingDecidedAt: null,
    droppedSinceLastSample: { expired_unapproved: 0, ttl_expired: 0 },
    ...patch,
  };
}

describe('the three series A1.12 names', () => {
  it('spells each name out in full, exactly as the dashboard queries it', () => {
    // Assembled names are how a dashboard goes blank on the day someone fixes a typo.
    expect(ALERT_SENDS_DEFERRED_TOTAL.name).toBe('fw_alert_sends_deferred_total');
    expect(ALERT_APPROVAL_PENDING_SECONDS.name).toBe('fw_alert_approval_pending_seconds');
    expect(ALERT_SENDS_DROPPED_TOTAL.name).toBe('fw_alert_sends_dropped_total');
  });

  it('labels the two counters by reason and leaves the gauge unlabelled', () => {
    expect(ALERT_SENDS_DEFERRED_TOTAL).toMatchObject({ kind: 'counter', labels: ['reason'] });
    expect(ALERT_SENDS_DROPPED_TOTAL).toMatchObject({ kind: 'counter', labels: ['reason'] });
    expect(ALERT_APPROVAL_PENDING_SECONDS).toMatchObject({ kind: 'gauge', labels: [] });
  });

  it('exports the three of them together and no fourth', () => {
    expect(ALERT_DEFERRAL_METRICS.map((metric) => metric.name)).toEqual([
      'fw_alert_sends_deferred_total',
      'fw_alert_approval_pending_seconds',
      'fw_alert_sends_dropped_total',
    ]);
  });

  it('enumerates both label sets, so a third route into awaiting_approval must be named', () => {
    expect(ALERT_DEFERRAL_REASONS).toEqual(['over_budget_b', 'manual_approval']);
    expect(ALERT_DROP_REASONS).toEqual(['expired_unapproved', 'ttl_expired']);
  });
});

describe('approvalPendingSeconds', () => {
  it('is zero when nothing is awaiting a human', () => {
    expect(approvalPendingSeconds(null, NOW)).toBe(0);
  });

  it('rounds the age down to whole seconds', () => {
    expect(approvalPendingSeconds(NOW - 90_500, NOW)).toBe(90);
  });

  it('floors clock skew at zero rather than reporting a negative backlog', () => {
    // A decided_at in the future is skew between the decider and the reporter. A negative
    // age would read as "no backlog" at exactly the moment the clocks are untrustworthy.
    expect(approvalPendingSeconds(NOW + 5_000, NOW)).toBe(0);
  });

  it('throws on a non-finite input instead of publishing a NaN gauge', () => {
    // A NaN gauge compares false against the threshold, i.e. it quietly never pages.
    expect(() => approvalPendingSeconds(NOW, Number.NaN)).toThrow(RangeError);
    expect(() => approvalPendingSeconds(Number.NaN, NOW)).toThrow(RangeError);
    expect(() => approvalPendingSeconds(Number.POSITIVE_INFINITY, NOW)).toThrow(RangeError);
  });
});

describe('alertDeferralPages', () => {
  it('pages for nothing when no one is waiting and nothing died', () => {
    expect(alertDeferralPages(sample())).toEqual([]);
  });

  it('leaves a backlog sitting exactly on the 30-minute deadline alone', () => {
    expect(alertDeferralPages(sample({ oldestAwaitingDecidedAt: NOW - 1_800_000 }))).toEqual([]);
  });

  it('pages one second past the deadline', () => {
    const [page, ...rest] = alertDeferralPages(
      sample({ oldestAwaitingDecidedAt: NOW - 1_801_000 }),
    );

    expect(rest).toEqual([]);
    expect(page).toMatchObject({
      rule: 'approval_pending',
      metric: 'fw_alert_approval_pending_seconds',
    });
    expect(page?.detail).toContain('1801s');
    expect(page?.detail).toContain('1800s');
  });

  it('pages on any drop at all, because one late approval is an incident', () => {
    const [page, ...rest] = alertDeferralPages(
      sample({ droppedSinceLastSample: { expired_unapproved: 0, ttl_expired: 1 } }),
    );

    expect(rest).toEqual([]);
    expect(page).toMatchObject({ rule: 'sends_dropped', metric: 'fw_alert_sends_dropped_total' });
    expect(page?.detail).toContain('1 ttl_expired');
    expect(page?.detail).not.toContain('expired_unapproved');
  });

  it('names every reason that moved, in one page', () => {
    const [page] = alertDeferralPages(
      sample({ droppedSinceLastSample: { expired_unapproved: 3, ttl_expired: 2 } }),
    );

    expect(page?.detail).toContain('3 expired_unapproved');
    expect(page?.detail).toContain('2 ttl_expired');
  });

  it('returns both rules when both fire, because they need different fixes', () => {
    // One needs an approval, the other needs a post-mortem. Reporting only the worse of
    // the two would lose the one nobody is looking at.
    expect(
      alertDeferralPages(
        sample({
          oldestAwaitingDecidedAt: NOW - 3_600_000,
          droppedSinceLastSample: { expired_unapproved: 1, ttl_expired: 0 },
        }),
      ).map((page) => page.rule),
    ).toEqual(['approval_pending', 'sends_dropped']);
  });

  it('rejects a drop delta that is negative or fractional', () => {
    expect(() =>
      alertDeferralPages(
        sample({ droppedSinceLastSample: { expired_unapproved: -1, ttl_expired: 0 } }),
      ),
    ).toThrow(RangeError);
    expect(() =>
      alertDeferralPages(
        sample({ droppedSinceLastSample: { expired_unapproved: 0, ttl_expired: 0.5 } }),
      ),
    ).toThrow(RangeError);
  });
});

describe('the deadline is not a runtime knob either', () => {
  it('ignores a caller who claims a later deadline than the one in git', () => {
    expect(
      alertDeferralPages(
        sample({ oldestAwaitingDecidedAt: NOW - 1_801_000 }),
        budgets({ approvalPendingPageMs: 3_600_000 }),
      ),
    ).toHaveLength(1);
  });

  it('honours a caller who pages sooner', () => {
    expect(
      alertDeferralPages(
        sample({ oldestAwaitingDecidedAt: NOW - 61_000 }),
        budgets({ approvalPendingPageMs: 60_000 }),
      ),
    ).toHaveLength(1);
  });
});

describe('alertDropReasonFor', () => {
  it('maps the two dropping outbox statuses and nothing else', () => {
    expect(alertDropReasonFor('ttl_expired')).toBe('ttl_expired');
    expect(alertDropReasonFor('expired_unapproved')).toBe('expired_unapproved');
    for (const status of ['sent', 'failed', 'pending', 'awaiting_approval', 'cancelled', '']) {
      expect(alertDropReasonFor(status)).toBeNull();
    }
  });
});

describe('alertDeferralReasonFor', () => {
  it('counts only rows entering awaiting_approval, a manual one as manual_approval', () => {
    expect(alertDeferralReasonFor({ status: 'awaiting_approval', triggerType: 'new_fire' })).toBe(
      'over_budget_b',
    );
    expect(alertDeferralReasonFor({ status: 'awaiting_approval', triggerType: 'manual' })).toBe(
      'manual_approval',
    );
    for (const status of OUTBOX_STATUSES.filter((s) => s !== 'awaiting_approval')) {
      expect(alertDeferralReasonFor({ status, triggerType: 'new_fire' })).toBeNull();
      expect(alertDeferralReasonFor({ status, triggerType: 'manual' })).toBeNull();
    }
  });
});
