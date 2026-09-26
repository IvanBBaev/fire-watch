import { describe, expect, it } from 'vitest';

import type { EnqueueResult, OutboxRowDraft } from '../ports/alert-outbox-store.js';
import { enqueueCountingDeferrals, noDeferrals } from './outbox-enqueue.js';

const DECIDED = Date.UTC(2026, 8, 26, 12, 0, 0);

function draft(
  zone: string,
  patch: Partial<Pick<OutboxRowDraft, 'status' | 'triggerType'>> = {},
): OutboxRowDraft {
  return {
    watchZoneId: zone,
    fireEventId: '101',
    alertType: 'new_fire',
    alertSubkey: 'new',
    triggerType: 'new_fire',
    triggerRefSeq: '1',
    ruleVersion: 'alert_gating_v1',
    templateId: 'test.new_fire',
    templateParams: {},
    channel: 'push',
    channelSubscriptionId: `sub-${zone}`,
    locale: 'bg',
    priority: 1,
    budgetSeq: null,
    status: 'pending',
    actorId: null,
    approverId: null,
    approvalMode: null,
    approvedAt: null,
    budgetOverride: false,
    decidedAt: DECIDED,
    ...patch,
  };
}

/** An outbox keyed on the zone alone: a second draft for a zone is a redelivery. */
function fakeOutbox(): {
  calls: string[][];
  enqueue: (rows: readonly OutboxRowDraft[]) => Promise<EnqueueResult>;
} {
  const held = new Set<string>();
  const calls: string[][] = [];
  return {
    calls,
    enqueue: (rows) => {
      calls.push(rows.map((r) => r.watchZoneId));
      let inserted = 0;
      for (const row of rows) {
        if (held.has(row.watchZoneId)) continue;
        held.add(row.watchZoneId);
        inserted += 1;
      }
      return Promise.resolve({
        received: rows.length,
        inserted,
        alreadyDecided: rows.length - inserted,
      });
    },
  };
}

describe('enqueueCountingDeferrals', () => {
  it('enqueues a batch with nothing deferred in one call, in order, and counts no deferral', async () => {
    const outbox = fakeOutbox();
    const result = await enqueueCountingDeferrals(outbox, [draft('a'), draft('b')]);
    expect(outbox.calls).toEqual([['a', 'b']]);
    expect(result).toEqual({ inserted: 2, alreadyDecided: 0, deferred: noDeferrals() });
    expect(noDeferrals()).toEqual({ over_budget_b: 0, manual_approval: 0 });
  });

  it('counts rows entering awaiting_approval by reason: over budget B, or a manual row', async () => {
    const outbox = fakeOutbox();
    const result = await enqueueCountingDeferrals(outbox, [
      draft('a'),
      draft('b', { status: 'awaiting_approval' }),
      draft('c', { status: 'awaiting_approval', triggerType: 'manual' }),
      draft('d', { status: 'awaiting_approval' }),
      // An approved manual row is released, not deferred.
      draft('e', { triggerType: 'manual' }),
    ]);
    expect(outbox.calls).toEqual([['a', 'e'], ['b', 'd'], ['c']]);
    expect(result).toEqual({
      inserted: 5,
      alreadyDecided: 0,
      deferred: { over_budget_b: 2, manual_approval: 1 },
    });
  });

  it('does not count a redelivered awaiting row a second time (A1.11 key already held)', async () => {
    const outbox = fakeOutbox();
    const rows = [draft('a', { status: 'awaiting_approval' }), draft('b')];
    await enqueueCountingDeferrals(outbox, rows);
    const again = await enqueueCountingDeferrals(outbox, rows);
    expect(again).toEqual({ inserted: 0, alreadyDecided: 2, deferred: noDeferrals() });
  });

  it('makes no call for an empty batch', async () => {
    const outbox = fakeOutbox();
    expect(await enqueueCountingDeferrals(outbox, [])).toEqual({
      inserted: 0,
      alreadyDecided: 0,
      deferred: noDeferrals(),
    });
    expect(outbox.calls).toEqual([]);
  });
});
