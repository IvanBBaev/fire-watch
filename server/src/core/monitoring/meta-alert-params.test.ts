import { describe, expect, it } from 'vitest';

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

  it('arms only the documented threshold: queue age pages above 600 s (GATES L-8)', () => {
    expect(OUTBOX_QUEUE_PAGE_SECONDS).toBe(600);
    const armed = META_ALERT_KEYS.filter((key) => META_ALERT_RULES[key].pageAbove !== null);
    expect(armed).toEqual(['outbox_queue_oldest_seconds']);
    expect(META_ALERT_RULES.outbox_queue_oldest_seconds.pageAbove).toBe(600);
  });

  it('documents every unarmed rule, and no armed one', () => {
    // An unarmed threshold is an open decision; one without a reason is a silent one.
    for (const key of META_ALERT_KEYS) {
      const unarmed = META_ALERT_RULES[key].pageAbove === null;
      expect(UNARMED_REASONS[key] !== undefined, key).toBe(unarmed);
    }
  });
});
