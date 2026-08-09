import { describe, expect, it } from 'vitest';

import { epochMsFromIso } from '../ports/clock.js';
import {
  LSA_502_CADENCE,
  LSA_509_CADENCE,
  newestPublishedSlot,
  planGranuleSlots,
  type SlotPlanRequest,
} from './lsa-saf-slots.js';

function request(overrides: Partial<SlotPlanRequest> = {}): SlotPlanRequest {
  return {
    now: epochMsFromIso('2026-08-02T12:00:00Z'),
    cadence: LSA_502_CADENCE,
    lastSettledSlotIso: '2026-08-02T11:15:00Z',
    maxSlots: 8,
    ...overrides,
  };
}

describe('newestPublishedSlot', () => {
  it('waits out the product latency instead of asking for a granule that is coming', () => {
    // 12:00 minus 30 minutes of latency is 11:30, which is itself a grid point.
    expect(newestPublishedSlot(epochMsFromIso('2026-08-02T12:00:00Z'), LSA_502_CADENCE)).toBe(
      '2026-08-02T11:30:00Z',
    );
  });

  it('floors to the grid rather than rounding to the nearest slot', () => {
    // 12:14 − 30 min = 11:44, which is inside the 11:30 slot. Rounding up would ask for
    // 11:45 four minutes after it was acquired and thirty before it exists.
    expect(newestPublishedSlot(epochMsFromIso('2026-08-02T12:14:59Z'), LSA_502_CADENCE)).toBe(
      '2026-08-02T11:30:00Z',
    );
  });

  it('uses the instrument’s own grid', () => {
    expect(newestPublishedSlot(epochMsFromIso('2026-08-02T12:05:00Z'), LSA_509_CADENCE)).toBe(
      '2026-08-02T11:30:00Z',
    );
  });
});

describe('planGranuleSlots', () => {
  it('asks for everything owed, oldest first', () => {
    expect(planGranuleSlots(request())).toEqual({
      slots: ['2026-08-02T11:30:00Z'],
      skipped: [],
    });
  });

  it('asks for nothing when the newest publishable slot is already settled', () => {
    // The common case by far: the cycle runs more often than the product is published.
    expect(planGranuleSlots(request({ lastSettledSlotIso: '2026-08-02T11:30:00Z' }))).toEqual({
      slots: [],
      skipped: [],
    });
  });

  it('asks for nothing when the clock has gone backwards', () => {
    // An NTP correction on the VM must not become a re-fetch of granules already judged.
    const plan = planGranuleSlots(request({ lastSettledSlotIso: '2026-08-02T13:00:00Z' }));

    expect(plan.slots).toEqual([]);
  });

  it('catches up across an outage, slot by slot', () => {
    const plan = planGranuleSlots(request({ lastSettledSlotIso: '2026-08-02T10:15:00Z' }));

    expect(plan.slots).toEqual([
      '2026-08-02T10:30:00Z',
      '2026-08-02T10:45:00Z',
      '2026-08-02T11:00:00Z',
      '2026-08-02T11:15:00Z',
      '2026-08-02T11:30:00Z',
    ]);
    expect(plan.skipped).toEqual([]);
  });

  it('keeps the newest slots when the backlog outgrows one cycle, and names the rest', () => {
    // A day-long outage would otherwise queue ninety-six granules against a rate-limited
    // provider, and the oldest of them attach 0.05 of evidence to events already closed.
    const plan = planGranuleSlots(
      request({ lastSettledSlotIso: '2026-08-02T08:00:00Z', maxSlots: 3 }),
    );

    expect(plan.slots).toEqual([
      '2026-08-02T11:00:00Z',
      '2026-08-02T11:15:00Z',
      '2026-08-02T11:30:00Z',
    ]);
    expect(plan.skipped).toHaveLength(11);
    expect(plan.skipped[0]).toBe('2026-08-02T08:15:00Z');
    expect(plan.skipped.at(-1)).toBe('2026-08-02T10:45:00Z');
  });

  it('starts cold with one slot, because history is the backfill’s job', () => {
    expect(planGranuleSlots(request({ lastSettledSlotIso: null }))).toEqual({
      slots: ['2026-08-02T11:30:00Z'],
      skipped: [],
    });
  });

  it('crosses midnight without arithmetic of its own', () => {
    const plan = planGranuleSlots(
      request({ now: epochMsFromIso('2026-08-03T00:15:00Z'), lastSettledSlotIso: null }),
    );

    expect(plan.slots).toEqual(['2026-08-02T23:45:00Z']);
  });

  it('refuses a last slot that is not on the grid, rather than drifting off it', () => {
    // One off-grid pointer would offset every slot after it, and every uid with them.
    expect(() => planGranuleSlots(request({ lastSettledSlotIso: '2026-08-02T11:17:00Z' }))).toThrow(
      /grid/,
    );
  });

  it('refuses a repeat cycle that does not divide the hour', () => {
    expect(() =>
      planGranuleSlots(request({ cadence: { repeatMinutes: 7, latencyMinutes: 30 } })),
    ).toThrow(/divide the hour/);
  });

  it('refuses a catch-up bound that would ask for nothing or for everything', () => {
    expect(() => planGranuleSlots(request({ maxSlots: 0 }))).toThrow(/maxSlots/);
    expect(() => planGranuleSlots(request({ now: Number.NaN }))).toThrow(/finite/);
  });
});
