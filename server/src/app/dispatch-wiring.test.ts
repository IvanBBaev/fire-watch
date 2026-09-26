import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type {
  DispatchCycleReport,
  GatewayEvent,
  NotificationGateway,
} from '../adapters/alerts/gateway/notification-gateway.js';
import type { DispatchControlState } from '../core/alerts/dispatch-breaker.js';
import { CLAIM_LEASE_MS } from '../core/alerts/claim-lease.js';
import { ALERT_BUDGETS, type AlertBudgetParams } from '../core/config/alert-budgets.js';
import type { ClaimedOutboxRow, SettleOutcome } from '../core/ports/alert-dispatch-queue.js';
import { ConfigError, loadConfig, type Environment } from './config.js';
import {
  DISPATCH_BATCH_SIZE,
  createDispatchCycle,
  startDispatchJob,
  type DispatchCycleDeps,
  type DispatchJobQueue,
} from './dispatch-wiring.js';

const NOW = 1_785_670_200_000;

const EMPTY_CYCLE: DispatchCycleReport = {
  claimed: 0,
  sent: 0,
  closed: 0,
  released: 0,
  errored: 0,
  channelMismatches: 0,
  leaseExhausted: 0,
  lintViolations: [],
};

interface Harness {
  readonly deps: DispatchCycleDeps;
  /** Everything the fakes were asked, in order. */
  readonly calls: string[];
  readonly batchSizes: number[];
  readonly latches: { at: number; detail: string }[];
}

interface HarnessOptions {
  readonly control?: DispatchControlState;
  readonly sends?: number | Error;
  readonly controlError?: Error;
  readonly events?: readonly GatewayEvent[];
  readonly params?: AlertBudgetParams;
}

function harness(options: HarnessOptions = {}): Harness {
  const calls: string[] = [];
  const batchSizes: number[] = [];
  const latches: { at: number; detail: string }[] = [];
  const queue: DispatchJobQueue = {
    claim(): Promise<readonly ClaimedOutboxRow[]> {
      calls.push('claim');
      return Promise.resolve([]);
    },
    settle(_id: string, _outcome: SettleOutcome): Promise<void> {
      return Promise.resolve();
    },
    releaseAbandonedClaims() {
      calls.push('releaseAbandoned');
      return Promise.resolve(2);
    },
    releaseExpiredClaims(cutoff: number) {
      calls.push(`releaseExpired:${String(NOW - cutoff)}`);
      return Promise.resolve(3);
    },
  };
  const deps: DispatchCycleDeps = {
    queue,
    control: {
      read() {
        calls.push('readControl');
        if (options.controlError !== undefined) return Promise.reject(options.controlError);
        return Promise.resolve(options.control ?? { killSwitch: false, breakerLatched: false });
      },
      latchBreaker(at, detail) {
        calls.push('latch');
        latches.push({ at, detail });
        return Promise.resolve();
      },
    },
    sendRate: {
      sendsSince(from) {
        calls.push(`sendsSince:${String(NOW - from)}`);
        const sends = options.sends ?? 0;
        return sends instanceof Error ? Promise.reject(sends) : Promise.resolve(sends);
      },
    },
    now: () => NOW,
    ...(options.params === undefined ? {} : { params: options.params }),
    gatewayFor(batchSize, onEvent): NotificationGateway {
      batchSizes.push(batchSize);
      return {
        runOnce() {
          calls.push('runOnce');
          for (const event of options.events ?? []) onEvent(event);
          return Promise.resolve({ ...EMPTY_CYCLE, claimed: batchSize });
        },
      };
    },
  };
  return { deps, calls, batchSizes, latches };
}

/** Shipped G with the breaker armed at a floor — a tightening, which the clamp allows. */
const ARMED: AlertBudgetParams = {
  ...ALERT_BUDGETS.values,
  breaker: { ratio: ALERT_BUDGETS.values.breaker.ratio, floorSendsPerWindow: 50 },
};

describe('createDispatchCycle', () => {
  it('releases claims, then reads the switches, then counts, then dispatches', async () => {
    const h = harness();
    const report = await createDispatchCycle(h.deps)();

    expect(h.calls).toEqual([
      `releaseExpired:${String(CLAIM_LEASE_MS)}`,
      'releaseAbandoned',
      'readControl',
      `sendsSince:${String(ALERT_BUDGETS.values.globalWindowMs)}`,
      'runOnce',
    ]);
    expect(h.batchSizes).toEqual([DISPATCH_BATCH_SIZE]);
    expect(report).toMatchObject({
      expiredLeases: 3,
      releasedAbandoned: 2,
      sendsInWindow: 0,
      sendRateError: null,
      latchedBreaker: false,
      allowance: { state: 'open', claimLimit: DISPATCH_BATCH_SIZE },
      gateway: { claimed: DISPATCH_BATCH_SIZE },
    });
  });

  it('releases expired leases on every cycle, not only the first (H4)', async () => {
    const h = harness();
    const cycle = createDispatchCycle(h.deps);
    await cycle();
    const second = await cycle();

    expect(h.calls.filter((call) => call.startsWith('releaseExpired'))).toHaveLength(2);
    expect(second.expiredLeases).toBe(3);
  });

  it('derives the expiry cutoff from the injected lease', async () => {
    const h = harness();
    await createDispatchCycle({
      ...h.deps,
      claimLease: { leaseMs: 60_000, sendWindowMs: 20_000 },
    })();

    expect(h.calls[0]).toBe('releaseExpired:60000');
  });

  it('refuses a lease with no room for a send', () => {
    const h = harness();
    expect(() =>
      createDispatchCycle({ ...h.deps, claimLease: { leaseMs: 1_000, sendWindowMs: 1_000 } }),
    ).toThrow(RangeError);
  });

  it('fails the cycle before claiming when the expiry release fails, and retries next cycle', async () => {
    const h = harness();
    let attempts = 0;
    const cycle = createDispatchCycle({
      ...h.deps,
      queue: {
        ...h.deps.queue,
        releaseExpiredClaims() {
          attempts += 1;
          return attempts === 1 ? Promise.reject(new Error('db down')) : Promise.resolve(1);
        },
      },
    });
    await expect(cycle()).rejects.toThrow(/db down/);
    expect(h.calls).not.toContain('runOnce');
    expect((await cycle()).expiredLeases).toBe(1);
  });

  it('claims nothing under the kill switch, still releasing what it holds, and does not page', async () => {
    const h = harness({ control: { killSwitch: true, breakerLatched: false } });
    const report = await createDispatchCycle(h.deps)();

    expect(h.calls).not.toContain('runOnce');
    expect(h.calls).toContain('releaseAbandoned');
    expect(report.gateway).toBeNull();
    expect(report.allowance).toMatchObject({
      state: 'halted',
      reason: 'kill_switch',
      pages: false,
    });
  });

  it('claims nothing while the breaker is latched', async () => {
    const h = harness({ control: { killSwitch: false, breakerLatched: true } });
    const report = await createDispatchCycle(h.deps)();

    expect(h.calls).not.toContain('runOnce');
    expect(h.latches).toHaveLength(0);
    expect(report.allowance).toMatchObject({ state: 'halted', reason: 'breaker_latched' });
  });

  it('fails the cycle before claiming when the switches cannot be read', async () => {
    const h = harness({ controlError: new Error('EACCES') });
    await expect(createDispatchCycle(h.deps)()).rejects.toThrow(/EACCES/);
    expect(h.calls).not.toContain('runOnce');
  });

  it('halts and pages when the send rate cannot be measured', async () => {
    // An unenforceable ceiling is not a ceiling: `null`, never a guessed 0.
    const h = harness({ sends: new Error('statement timeout') });
    const report = await createDispatchCycle(h.deps)();

    expect(h.calls).not.toContain('runOnce');
    expect(report.sendsInWindow).toBeNull();
    expect(report.sendRateError).toBe('statement timeout');
    expect(report.allowance).toMatchObject({
      state: 'halted',
      reason: 'unknown_send_rate',
      pages: true,
    });
  });

  it('halts and pages at G', async () => {
    const h = harness({ sends: ALERT_BUDGETS.values.globalWindowSends });
    const report = await createDispatchCycle(h.deps)();

    expect(h.calls).not.toContain('runOnce');
    expect(report.allowance).toMatchObject({ reason: 'global_budget_exhausted', pages: true });
  });

  it("caps the gateway's batch at G's remaining headroom", async () => {
    const h = harness({ sends: ALERT_BUDGETS.values.globalWindowSends - 7 });
    await createDispatchCycle(h.deps)();
    expect(h.batchSizes).toEqual([7]);
  });

  it('does not build a gateway when the verdict is open with no room', async () => {
    // Sitting exactly on an armed threshold: open, holding, nothing to claim.
    const h = harness({ sends: 50, params: ARMED });
    const report = await createDispatchCycle(h.deps)();

    expect(report.allowance).toMatchObject({ state: 'open', claimLimit: 0 });
    expect(h.batchSizes).toEqual([]);
    expect(report.gateway).toBeNull();
  });

  it('latches the breaker when this cycle trips it, and claims nothing', async () => {
    const h = harness({ sends: 51, params: ARMED });
    const report = await createDispatchCycle(h.deps)();

    expect(report.allowance).toMatchObject({ state: 'halted', reason: 'send_rate_anomaly' });
    expect(report.latchedBreaker).toBe(true);
    expect(h.latches).toHaveLength(1);
    expect(h.latches[0]?.at).toBe(NOW);
    expect(h.calls).not.toContain('runOnce');
  });

  it('keeps the shipped breaker unarmed: no baseline sampling rule and no floor exist', async () => {
    const h = harness({ sends: ALERT_BUDGETS.values.globalWindowSends - 1 });
    const report = await createDispatchCycle(h.deps)();
    expect(report.allowance.breaker).toMatchObject({ state: 'unarmed', baseline: null });
  });

  it('counts per-row failures by message rather than listing them', async () => {
    const h = harness({
      events: [
        { kind: 'row_failed', outboxId: '1', error: 'no reviewed template registered for x' },
        { kind: 'row_failed', outboxId: '2', error: 'no reviewed template registered for x' },
        { kind: 'adapter_threw', outboxId: '3', error: 'socket hang up' },
        { kind: 'released', outboxId: '4', reason: 'no adapter for channel email' },
      ],
    });
    const report = await createDispatchCycle(h.deps)();
    expect(report.rowErrors).toEqual({
      'no reviewed template registered for x': 2,
      'socket hang up': 1,
    });
  });
});

const MAP_KEY = 'testtesttesttesttesttesttesttest';
const DATABASE_URL = 'postgres://fire_watch:hunter2@db.internal:5432/fire_watch';

const env = (overrides: Environment = {}): Environment => ({
  DATABASE_URL,
  FIRMS_MAP_KEY: MAP_KEY,
  ...overrides,
});

const temporaries: string[] = [];

afterEach(() => {
  for (const dir of temporaries.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('createDispatchCycle drops (A1.12, C5)', () => {
  it('counts rows the gateway closed as ttl_expired, and no other closure, as dropped', async () => {
    const h = harness({
      events: [
        { kind: 'closed', outboxId: '1', status: 'ttl_expired', reason: 'past ttl' },
        { kind: 'closed', outboxId: '2', status: 'ttl_expired', reason: 'past ttl' },
        { kind: 'closed', outboxId: '3', status: 'failed', reason: 'channel mismatch' },
      ],
    });
    const report = await createDispatchCycle(h.deps)();
    expect(report.dropped).toEqual({ expired_unapproved: 0, ttl_expired: 2 });
  });

  it('reports zero drops when nothing was claimed', async () => {
    const h = harness({ control: { killSwitch: true, breakerLatched: false } });
    const report = await createDispatchCycle(h.deps)();
    expect(report.dropped).toEqual({ expired_unapproved: 0, ttl_expired: 0 });
  });
});

describe('startDispatchJob', () => {
  const writeLine = (): void => undefined;

  it('starts nothing unless dispatch is enabled', () => {
    expect(startDispatchJob(loadConfig(env()), { writeLine }, new AbortController().signal)).toBe(
      null,
    );
  });

  it('refuses to start a dispatcher nobody can stop', () => {
    expect(() =>
      startDispatchJob(
        loadConfig(env({ FIRE_WATCH_ALERT_DISPATCH_ENABLED: 'true' })),
        { writeLine },
        new AbortController().signal,
      ),
    ).toThrow(ConfigError);
  });

  it('stops without a cycle when already aborted, closing its pool', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'fw-dispatch-'));
    temporaries.push(stateDir);
    const controller = new AbortController();
    controller.abort();

    const job = startDispatchJob(
      loadConfig(
        env({ FIRE_WATCH_ALERT_DISPATCH_ENABLED: 'true', FIRE_WATCH_STATE_DIR: stateDir }),
      ),
      { writeLine },
      controller.signal,
    );
    expect(job).not.toBeNull();
    expect(await job).toMatchObject({ runs: 0, failures: 0 });
  });
});
