/**
 * The alert dispatch job — H4's loop around the gateway (ADR-004 D1, D2, D5, D6).
 *
 * The gateway is deliberately one batch and no timer ("the caller decides when to run and
 * how often, so that budget exhaustion, the circuit breaker and the kill switch can stop
 * dispatch by simply not calling `runOnce`"). This module is that caller. Each cycle, in
 * this order:
 *
 *   1. Release every claim whose lease has expired (`core/alerts/claim-lease.ts`,
 *      migration 015) — a crashed dispatcher's rows, whichever process left them. Every
 *      cycle, not only the first: a lease is a clock, not a start-up guess, so a second
 *      dispatcher's live claims are never touched.
 *   2. Release the rows the previous cycle abandoned when a port threw mid-row.
 *   3. Read the kill switch and breaker latch. A read that fails fails the cycle, before
 *      anything is claimed.
 *   4. Count sends in G's trailing window. A count that fails becomes `null`, which
 *      `dispatchAllowance` turns into a paging halt — never a guess.
 *   5. Ask `dispatchAllowance` for a claim limit; latch the breaker if it tripped.
 *   6. Only when the verdict is open with room to claim, run the gateway with the claim
 *      limit as its batch size, so G's headroom is enforced by the claim itself.
 *
 * Steps 1 and 2 run even under the kill switch: releasing a claim sends nothing, and a
 * halted outbox is exactly when the rows should sit in `pending` where the post-mortem
 * and the TTL sweep can see them.
 *
 * **Off unless asked for.** `FIRE_WATCH_ALERT_DISPATCH_ENABLED` defaults to `false`, and
 * the switch that stops a live dispatcher lives under the state dir, so enabling dispatch
 * without one is a {@link ConfigError}: a dispatcher nobody can stop with one command is
 * not something this module will start.
 *
 * **Shadow mode is not this.** A8's "decisions written, nothing sent" season cannot be run
 * by pointing this loop at sink channels: a sink *delivers*, so the gateway would settle
 * real outbox rows `sent`, stamp `dispatched_at` on them and count them against G — an
 * audit trail recording sends that never happened. Shadow mode is dispatch left off plus
 * H8's shadow tables.
 *
 * Two numbers here are not in any document and are reported as such:
 *
 *   * {@link DISPATCH_INTERVAL_MS} — 10 s. Derived, not given: D6's p95 decision-to-provider
 *     SLO is 60 s, and a 10 s cadence spends at most a sixth of it waiting for the next
 *     cycle. The repeating job's floor is 1 s.
 *   * The breaker's seasonal baseline is `null` — D5 names it and no document says how it
 *     is sampled (`dispatch-breaker.ts`). With the shipped floor also `null` the breaker is
 *     unarmed either way, and G is the enforced ceiling.
 */

import { createAlertGateway, createLiveChannels } from './alert-wiring.js';
import { ConfigError, type ServerConfig } from './config.js';
import { reportDispatch } from './dispatch-reporter.js';
import type {
  DispatchCycleReport,
  GatewayEvent,
  NotificationGateway,
} from '../adapters/alerts/gateway/notification-gateway.js';
import { createTemplateRenderer } from '../adapters/alerts/templates/template-renderer.js';
import { systemClock } from '../adapters/clock/system-clock.js';
import {
  createPgAlertDispatchQueue,
  createPgSendRateReader,
} from '../adapters/db/pg-alert-dispatch-queue.js';
import { createPgPool } from '../adapters/db/pg-pool.js';
import { createPgRecipientResolver } from '../adapters/db/pg-recipient-resolver.js';
import { systemSleeper } from '../adapters/scheduler/system-sleeper.js';
import { createFsDispatchControlStore } from '../adapters/storage/fs-dispatch-control-store.js';
import {
  assertClaimLease,
  DEFAULT_CLAIM_LEASE,
  leaseExpiryCutoff,
  type ClaimLease,
} from '../core/alerts/claim-lease.js';
import {
  dispatchAllowance,
  type DispatchAllowance,
  type DispatchControlState,
} from '../core/alerts/dispatch-breaker.js';
import {
  ALERT_BUDGETS,
  clampToShipped,
  type AlertBudgetParams,
} from '../core/config/alert-budgets.js';
import type { AlertDispatchQueue } from '../core/ports/alert-dispatch-queue.js';
import type { DispatchControlStore } from '../core/ports/dispatch-control-store.js';
import type { SendRateReader } from '../core/ports/send-rate-reader.js';
import { alertDropReasonFor, type AlertDropReason } from '../core/observability/alert-metrics.js';
import { runRepeatedly, type JobRun, type JobStats } from '../core/scheduler/repeating-job.js';

export const DISPATCH_INTERVAL_MS = 10_000;

/** What one cycle would claim if no guard held it back — the gateway's own default. */
export const DISPATCH_BATCH_SIZE = 100;

/** The queue as the job needs it: the port, plus the two claim-expiry halves. */
export interface DispatchJobQueue extends AlertDispatchQueue {
  releaseAbandonedClaims(): Promise<number>;
  /** Release every claim made at or before `cutoff` (epoch ms). */
  releaseExpiredClaims(cutoff: number): Promise<number>;
}

export interface DispatchCycleDeps {
  readonly queue: DispatchJobQueue;
  readonly control: DispatchControlStore;
  readonly sendRate: SendRateReader;
  readonly now: () => number;
  /**
   * G and the breaker. The shipped values unless a test tightens them; `clampToShipped`
   * means nothing passed here can loosen either.
   */
  readonly params?: AlertBudgetParams;
  /**
   * A gateway sized to this cycle's claim limit, reporting its per-row events to
   * `onEvent`. Built per cycle because the gateway's batch size is fixed at construction
   * and G's headroom is not.
   */
  gatewayFor(batchSize: number, onEvent: (event: GatewayEvent) => void): NotificationGateway;
  /** The claim lease whose expiry step 1 enforces; the shipped one unless a test says so. */
  readonly claimLease?: ClaimLease;
}

export interface DispatchJobReport {
  /** Claims released because their lease expired (any dispatcher's). */
  readonly expiredLeases: number;
  readonly releasedAbandoned: number;
  readonly control: DispatchControlState;
  readonly sendsInWindow: number | null;
  /** Why the send count was unavailable, when it was. */
  readonly sendRateError: string | null;
  readonly allowance: DispatchAllowance;
  /** This cycle tripped the breaker and wrote the latch. */
  readonly latchedBreaker: boolean;
  /** `null` when nothing was claimed because the verdict said not to. */
  readonly gateway: DispatchCycleReport | null;
  /**
   * Distinct per-row failure messages and how often each occurred — a port that threw or
   * an adapter that threw. Counted rather than listed: a missing template fails every row
   * of a batch with the same sentence, and a hundred copies of it help nobody.
   */
  readonly rowErrors: Readonly<Record<string, number>>;
  /**
   * Rows this cycle closed under an A1.12 drop status, by reason — what
   * `fw_alert_sends_dropped_total` adds. Only `ttl_expired` can come from here: an
   * `awaiting_approval` row is never claimed, so `expired_unapproved` is a sweeper's.
   */
  readonly dropped: Readonly<Record<AlertDropReason, number>>;
}

/** One cycle as a function, so the order above is testable without a database. */
export function createDispatchCycle(deps: DispatchCycleDeps): () => Promise<DispatchJobReport> {
  // Clamped once, here, so the window the send count covers and the window the verdict
  // judges it against cannot come from two different configs.
  const params = clampToShipped(deps.params ?? ALERT_BUDGETS.values);
  const claimLease = deps.claimLease ?? DEFAULT_CLAIM_LEASE;
  assertClaimLease(claimLease);

  return async (): Promise<DispatchJobReport> => {
    const expiredLeases = await deps.queue.releaseExpiredClaims(
      leaseExpiryCutoff(deps.now(), claimLease),
    );
    const releasedAbandoned = await deps.queue.releaseAbandonedClaims();
    const control = await deps.control.read();

    const now = deps.now();
    let sendsInWindow: number | null = null;
    let sendRateError: string | null = null;
    try {
      sendsInWindow = await deps.sendRate.sendsSince(now - params.globalWindowMs);
    } catch (error) {
      sendRateError = describeError(error);
    }

    const allowance = dispatchAllowance({
      control,
      sendsInWindow,
      // Founder decision: no sampling rule for D5's seasonal baseline exists yet.
      baselineSendsPerWindow: null,
      batchSize: DISPATCH_BATCH_SIZE,
      params,
    });

    let latchedBreaker = false;
    if (allowance.state === 'halted' && allowance.reason === 'send_rate_anomaly') {
      await deps.control.latchBreaker(now, allowance.detail);
      latchedBreaker = true;
    }

    const rowErrors: Record<string, number> = {};
    const dropped: Record<AlertDropReason, number> = { expired_unapproved: 0, ttl_expired: 0 };
    let gateway: DispatchCycleReport | null = null;
    if (allowance.state === 'open' && allowance.claimLimit > 0) {
      gateway = await deps
        .gatewayFor(allowance.claimLimit, (event) => {
          if (event.kind === 'row_failed' || event.kind === 'adapter_threw') {
            rowErrors[event.error] = (rowErrors[event.error] ?? 0) + 1;
          } else if (event.kind === 'closed') {
            const reason = alertDropReasonFor(event.status);
            if (reason !== null) dropped[reason] += 1;
          }
        })
        .runOnce();
    }

    return {
      expiredLeases,
      releasedAbandoned,
      control,
      sendsInWindow,
      sendRateError,
      allowance,
      latchedBreaker,
      gateway,
      rowErrors,
      dropped,
    };
  };
}

export interface DispatchJobDeps {
  /** One canonical-JSON line per cycle, newline excluded; the worker adds it. */
  writeLine(line: string): void;
  /**
   * Wraps the loop's reporter to record metrics (C5) — the worker passes `observeLoop`
   * with `dispatchObserver`. It must hand every run to the reporter it wraps and never
   * throw; absent, the reporter runs bare.
   */
  readonly observe?: (
    report: (run: JobRun<DispatchJobReport>) => void | Promise<void>,
  ) => (run: JobRun<DispatchJobReport>) => void | Promise<void>;
}

/**
 * Start the dispatch loop, or return `null` when dispatch is not enabled. The promise
 * resolves with the loop's stats once `signal` aborts, after the job's own pool is closed.
 */
export function startDispatchJob(
  config: ServerConfig,
  deps: DispatchJobDeps,
  signal: AbortSignal,
): Promise<JobStats> | null {
  if (!config.alertDispatchEnabled) return null;
  if (config.stateDir === null) {
    throw new ConfigError(
      'FIRE_WATCH_ALERT_DISPATCH_ENABLED=true needs FIRE_WATCH_STATE_DIR: the kill switch lives there',
    );
  }

  const now = (): number => systemClock.now();
  const control = createFsDispatchControlStore(config.stateDir);
  // Built before the pool, so a provider credential that fails its own gate is a
  // ConfigError at start-up with nothing yet to close.
  const { channels } = createLiveChannels({
    config: config.alertChannels,
    now,
    sleeper: systemSleeper,
    signal,
  });
  // Its own pool, named in `pg_stat_activity`: a claim stuck behind a lock should name the
  // dispatcher, not the ingest loop that shares the process.
  const pool = createPgPool({
    databaseUrl: config.databaseUrl,
    role: config.databaseRole,
    applicationName: `${config.applicationName}-dispatch`,
  });
  const queue = createPgAlertDispatchQueue(pool);
  const recipients = createPgRecipientResolver(pool, { now });
  const renderer = createTemplateRenderer();

  const cycle = createDispatchCycle({
    queue,
    control,
    sendRate: createPgSendRateReader(pool),
    now,
    gatewayFor: (batchSize, onEvent) =>
      createAlertGateway({ queue, recipients, renderer, channels, now, batchSize, onEvent }),
  });

  const report = (run: JobRun<DispatchJobReport>): void => {
    reportDispatch(run, deps);
  };
  const loop = async (): Promise<JobStats> => {
    try {
      return await runRepeatedly({
        intervalMs: DISPATCH_INTERVAL_MS,
        clock: systemClock,
        sleeper: systemSleeper,
        signal,
        run: cycle,
        report: deps.observe === undefined ? report : deps.observe(report),
      });
    } finally {
      await pool.end();
    }
  };
  return loop();
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
