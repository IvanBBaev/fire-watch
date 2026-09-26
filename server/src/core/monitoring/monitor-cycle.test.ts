import { describe, expect, it } from 'vitest';

import type { CanaryProbe } from '../ports/canary-probe.js';
import { epochMsFromIso, VirtualClock } from '../ports/clock.js';
import type { MetaAlertPager } from '../ports/meta-alert-pager.js';
import type {
  IdentityLagSnapshot,
  MonitorReader,
  OutboxQueueSnapshot,
} from '../ports/monitor-reader.js';
import { META_ALERT_RULES, type MetaAlertKey } from './meta-alert-params.js';
import { createMonitorCycle, type MonitorCycleDeps } from './monitor-cycle.js';

const START = '2026-09-23T10:00:00Z';
const T0 = epochMsFromIso(START);
const HOUR = 3_600_000;

const EMPTY_OUTBOX: OutboxQueueSnapshot = {
  pendingCount: 0,
  claimedCount: 0,
  oldestUnsentDecidedAt: null,
  oldestClaimedDecidedAt: null,
  awaitingApprovalCount: 0,
  oldestAwaitingDecidedAt: null,
};

const CAUGHT_UP: IdentityLagSnapshot = {
  liveRuns: 1,
  pendingBatches: 0,
  oldestPendingRecordedAt: null,
};

class FakeReader implements MonitorReader {
  outbox: OutboxQueueSnapshot = EMPTY_OUTBOX;
  identity: IdentityLagSnapshot = CAUGHT_UP;
  failing = false;
  readonly asOf: number[] = [];
  readonly notBefore: number[] = [];

  readOutboxQueue(asOf: number): Promise<OutboxQueueSnapshot> {
    this.asOf.push(asOf);
    return this.failing ? Promise.reject(new Error('db down')) : Promise.resolve(this.outbox);
  }

  readIdentityLag(notBefore: number): Promise<IdentityLagSnapshot> {
    this.notBefore.push(notBefore);
    return Promise.resolve(this.identity);
  }
}

class RecordingPager implements MetaAlertPager {
  readonly reports: (readonly MetaAlertKey[])[] = [];
  report(paging: readonly MetaAlertKey[]): Promise<void> {
    this.reports.push([...paging]);
    return Promise.resolve();
  }
}

function setup(overrides: Partial<MonitorCycleDeps> = {}): {
  clock: VirtualClock;
  reader: FakeReader;
  pager: RecordingPager;
  cycle: ReturnType<typeof createMonitorCycle>;
} {
  const clock = new VirtualClock(START);
  const reader = new FakeReader();
  const pager = new RecordingPager();
  const cycle = createMonitorCycle({
    reader,
    pager,
    clock,
    rules: META_ALERT_RULES,
    identityWindowMs: 48 * HOUR,
    canary: null,
    ...overrides,
  });
  return { clock, reader, pager, cycle };
}

describe('createMonitorCycle', () => {
  it('reads with the clock, bounds identity by the active window, and reports all clear', async () => {
    const { reader, pager, cycle } = setup();
    const report = await cycle.runOnce();

    expect(reader.asOf).toEqual([T0]);
    expect(reader.notBefore).toEqual([T0 - 48 * HOUR]);
    expect(report.at).toBe(START);
    expect(report.paging).toEqual([]);
    expect(report.readings.outbox_queue_oldest_seconds).toEqual({
      value: 0,
      status: 'ok',
      page_above: 600,
    });
    expect(report.readings.identity_pending_batches.status).toBe('unarmed');
    expect(report.readings.canary_round_trip_seconds.value).toBeNull();
    // The level is reported on every successful cycle — that is the dead-man's switch.
    expect(pager.reports).toEqual([[]]);
  });

  it('pages a stuck queue on the second breaching cycle and clears it after two healthy ones', async () => {
    const { clock, reader, pager, cycle } = setup();
    reader.outbox = { ...EMPTY_OUTBOX, pendingCount: 3, oldestUnsentDecidedAt: T0 - 601_000 };

    const first = await cycle.runOnce();
    expect(first.readings.outbox_queue_oldest_seconds.status).toBe('breaching');
    expect(first.transitions).toEqual([]);

    clock.advanceMinutes(1);
    const second = await cycle.runOnce();
    expect(second.readings.outbox_queue_oldest_seconds.value).toBe(661);
    expect(second.transitions).toEqual([{ key: 'outbox_queue_oldest_seconds', to: 'page' }]);
    expect(second.paging).toEqual(['outbox_queue_oldest_seconds']);

    reader.outbox = EMPTY_OUTBOX;
    clock.advanceMinutes(1);
    expect((await cycle.runOnce()).paging).toEqual(['outbox_queue_oldest_seconds']);
    clock.advanceMinutes(1);
    const cleared = await cycle.runOnce();
    expect(cleared.transitions).toEqual([{ key: 'outbox_queue_oldest_seconds', to: 'clear' }]);

    expect(pager.reports).toEqual([
      [],
      ['outbox_queue_oldest_seconds'],
      ['outbox_queue_oldest_seconds'],
      [],
    ]);
  });

  it('reports identity lag as readings but never pages on it (unarmed)', async () => {
    const { reader, pager, cycle } = setup();
    reader.identity = { liveRuns: 1, pendingBatches: 30, oldestPendingRecordedAt: T0 - 5 * HOUR };
    await cycle.runOnce();
    const report = await cycle.runOnce();
    expect(report.readings.identity_pending_batches.value).toBe(30);
    expect(report.readings.identity_oldest_pending_seconds.value).toBe(5 * 3600);
    expect(pager.reports.every((keys) => keys.length === 0)).toBe(true);
  });

  it('reports no identity reading without exactly one live run', async () => {
    const { reader, cycle } = setup();
    reader.identity = { liveRuns: 2, pendingBatches: 0, oldestPendingRecordedAt: null };
    const report = await cycle.runOnce();
    expect(report.readings.identity_pending_batches.value).toBeNull();
    expect(report.readings.identity_oldest_pending_seconds.value).toBeNull();
  });

  it('does not call the pager when a read fails, so the dead-man switch pages', async () => {
    const { reader, pager, cycle } = setup();
    reader.failing = true;
    await expect(cycle.runOnce()).rejects.toThrow('db down');
    expect(pager.reports).toEqual([]);
  });

  it('keeps one canary probe in flight and measures it end to end', async () => {
    const injected: number[] = [];
    const acks = new Map<string, number>();
    const canary: CanaryProbe = {
      inject(now) {
        injected.push(now);
        return Promise.resolve({ probeId: `p${String(injected.length)}`, injectedAt: now });
      },
      observe(probeId) {
        return Promise.resolve(acks.get(probeId) ?? null);
      },
    };
    const { clock, cycle } = setup({ canary });

    expect((await cycle.runOnce()).readings.canary_round_trip_seconds.value).toBeNull();
    expect(injected).toEqual([T0]);

    clock.advanceMinutes(1);
    expect((await cycle.runOnce()).readings.canary_round_trip_seconds.value).toBe(60);
    expect(injected).toHaveLength(1);

    acks.set('p1', T0 + 70_000);
    clock.advanceMinutes(1);
    const done = await cycle.runOnce();
    expect(done.readings.canary_round_trip_seconds).toEqual({
      value: 70,
      status: 'unarmed',
      page_above: null,
    });
    expect(injected).toEqual([T0, T0 + 120_000]);
  });

  it('refuses a negative identity window', () => {
    expect(() => setup({ identityWindowMs: -1 })).toThrow(RangeError);
  });
});
