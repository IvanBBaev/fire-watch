import { describe, expect, it } from 'vitest';

import { ageSeconds, identityReadings, outboxReadings } from './readings.js';

describe('ageSeconds', () => {
  it('floors to whole seconds and never goes negative across two clocks', () => {
    expect(ageSeconds(0, 1_999)).toBe(1);
    expect(ageSeconds(5_000, 4_000)).toBe(0);
    expect(ageSeconds(null, 1_000)).toBeNull();
  });
});

describe('outboxReadings', () => {
  it('reads an empty queue as age zero, not as missing', () => {
    const readings = outboxReadings(
      {
        pendingCount: 0,
        claimedCount: 0,
        oldestUnsentDecidedAt: null,
        oldestClaimedDecidedAt: null,
        awaitingApprovalCount: 0,
        oldestAwaitingDecidedAt: null,
      },
      1_000_000,
    );
    expect(readings.outbox_queue_oldest_seconds).toBe(0);
    expect(readings.outbox_claimed_oldest_seconds).toBe(0);
  });

  it('ages each queue from its own oldest decision', () => {
    const readings = outboxReadings(
      {
        pendingCount: 4,
        claimedCount: 1,
        oldestUnsentDecidedAt: 0,
        oldestClaimedDecidedAt: 100_000,
        awaitingApprovalCount: 2,
        oldestAwaitingDecidedAt: 400_000,
      },
      700_000,
    );
    expect(readings).toEqual({
      outbox_queue_oldest_seconds: 700,
      outbox_pending_rows: 4,
      outbox_claimed_rows: 1,
      outbox_claimed_oldest_seconds: 600,
      outbox_awaiting_approval_oldest_seconds: 300,
    });
  });
});

describe('identityReadings', () => {
  it('reads nothing without exactly one live run', () => {
    for (const liveRuns of [0, 2]) {
      expect(
        identityReadings({ liveRuns, pendingBatches: 0, oldestPendingRecordedAt: null }, 0),
      ).toEqual({ identity_pending_batches: null, identity_oldest_pending_seconds: null });
    }
  });

  it('reads a caught-up loop as zero lag', () => {
    expect(
      identityReadings({ liveRuns: 1, pendingBatches: 0, oldestPendingRecordedAt: null }, 5_000),
    ).toEqual({ identity_pending_batches: 0, identity_oldest_pending_seconds: 0 });
  });
});
