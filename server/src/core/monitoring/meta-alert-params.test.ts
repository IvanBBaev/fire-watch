import { describe, expect, it } from 'vitest';

import { ALERT_BUDGETS } from '../config/alert-budgets.js';
import {
  META_ALERT_KEYS,
  META_ALERT_RULES,
  OUTBOX_QUEUE_PAGE_SECONDS,
  UNARMED_REASONS,
} from './meta-alert-params.js';

describe('META_ALERT_RULES', () => {
  it('has exactly one rule per reading key', () => {
    expect(Object.keys(META_ALERT_RULES).sort()).toEqual([...META_ALERT_KEYS].sort());
  });

  it('arms all eight keys with the values signed on 2026-10-30 (J1, R5-SRE-8)', () => {
    expect(OUTBOX_QUEUE_PAGE_SECONDS).toBe(600);
    const pageAbove = Object.fromEntries(
      META_ALERT_KEYS.map((key) => [key, META_ALERT_RULES[key].pageAbove]),
    );
    expect(pageAbove).toEqual({
      outbox_queue_oldest_seconds: 600,
      outbox_pending_rows: 6_000,
      outbox_claimed_rows: 200,
      outbox_claimed_oldest_seconds: 600,
      outbox_awaiting_approval_oldest_seconds: 1_800,
      identity_pending_batches: 24,
      identity_oldest_pending_seconds: 600,
      canary_round_trip_seconds: 600,
    });
    for (const key of META_ALERT_KEYS) {
      const rule = META_ALERT_RULES[key];
      expect(rule.clearAtOrBelow, key).toBe(rule.pageAbove);
      expect([rule.pageAfter, rule.clearAfter], key).toEqual([2, 2]);
    }
  });

  it('reads the approval deadline from alert_budgets, so the two pages agree', () => {
    expect(META_ALERT_RULES.outbox_awaiting_approval_oldest_seconds.pageAbove).toBe(
      ALERT_BUDGETS.values.approvalPendingPageMs / 1000,
    );
  });

  it('documents every unarmed rule, and no armed one', () => {
    // An unarmed threshold is an open decision; one without a reason is a silent one.
    for (const key of META_ALERT_KEYS) {
      const unarmed = META_ALERT_RULES[key].pageAbove === null;
      expect(UNARMED_REASONS[key] !== undefined, key).toBe(unarmed);
    }
  });
});
