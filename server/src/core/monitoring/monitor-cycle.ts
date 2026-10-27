/**
 * One meta-alert cycle (TASKS J1; GATES L-8; OPERATIONS §3).
 *
 * read → readings → hysteresis → pager. The hysteresis state is read from and written to a
 * {@link MetaAlertStateStore} every cycle (migration 036), so a restart or a standby
 * worker's takeover resumes the streaks and a live page instead of reporting "all clear"
 * for a cycle; `meta-alert-memory.ts` says when a stored state is held rather than
 * advanced, and when its streaks are too old to count as consecutive.
 *
 * The pager is called only after every reader succeeded. A cycle that throws reports
 * nothing, so a monitor that cannot see the database pages through the dead-man's switch
 * rather than reporting "all clear" over readings it never took.
 */

import type { CanaryProbe } from '../ports/canary-probe.js';
import type { Clock, EpochMs } from '../ports/clock.js';
import { isoFromEpochMs } from '../ports/clock.js';
import type { MetaAlertPager } from '../ports/meta-alert-pager.js';
import type { MetaAlertStateStore } from '../ports/meta-alert-state-store.js';
import type { MonitorReader } from '../ports/monitor-reader.js';
import { INITIAL_CANARY_STATE, settleCanary, type CanaryState } from './canary.js';
import { evaluateMetaAlert, type ReadingStatus } from './meta-alert-evaluator.js';
import { resumeMetaAlertStates, type StoredMetaAlertState } from './meta-alert-memory.js';
import { META_ALERT_KEYS, type MetaAlertKey, type MetaAlertRules } from './meta-alert-params.js';
import { identityReadings, outboxReadings, type Readings } from './readings.js';

export interface MonitorCycleDeps {
  readonly reader: MonitorReader;
  readonly pager: MetaAlertPager;
  readonly clock: Clock;
  readonly rules: MetaAlertRules;
  readonly stateStore: MetaAlertStateStore;
  /** The loop's cadence; defines "consecutive" for the stored streaks. */
  readonly intervalMs: number;
  /** The identity loop's cold-start window (clustering `activeWindowMs`). */
  readonly identityWindowMs: number;
  /** `null` until an operator channel exists — see `core/ports/canary-probe.ts`. */
  readonly canary: CanaryProbe | null;
}

export interface MonitorReadingReport {
  readonly value: number | null;
  readonly status: ReadingStatus;
  readonly page_above: number | null;
}

export interface MonitorCycleReport {
  readonly at: string;
  readonly readings: Readonly<Record<MetaAlertKey, MonitorReadingReport>>;
  readonly transitions: readonly { readonly key: MetaAlertKey; readonly to: 'page' | 'clear' }[];
  /** Every key paging after this cycle, in {@link META_ALERT_KEYS} order. */
  readonly paging: readonly MetaAlertKey[];
  /**
   * `false` when another cycle advanced the stored state less than half an interval ago:
   * this one reported that stored level and counted nothing (`meta-alert-memory.ts`).
   */
  readonly advanced: boolean;
}

export interface MonitorCycle {
  runOnce(): Promise<MonitorCycleReport>;
}

export function createMonitorCycle(deps: MonitorCycleDeps): MonitorCycle {
  if (!Number.isFinite(deps.identityWindowMs) || deps.identityWindowMs < 0) {
    throw new RangeError('identityWindowMs must be a non-negative finite number');
  }
  if (!Number.isFinite(deps.intervalMs) || deps.intervalMs <= 0) {
    throw new RangeError('intervalMs must be a positive finite number');
  }
  let canaryState: CanaryState = INITIAL_CANARY_STATE;

  async function readCanary(now: EpochMs): Promise<number | null> {
    const probe = deps.canary;
    if (probe === null) return null;
    const inFlight = canaryState.inFlight;
    const ackedAt = inFlight === null ? null : await probe.observe(inFlight.probeId);
    const outcome = settleCanary(canaryState, ackedAt, now);
    canaryState = outcome.reinject
      ? { ...outcome.state, inFlight: await probe.inject(now) }
      : outcome.state;
    return outcome.readingSeconds;
  }

  return {
    async runOnce(): Promise<MonitorCycleReport> {
      const now = deps.clock.now();
      const [outbox, identity] = await Promise.all([
        deps.reader.readOutboxQueue(now),
        deps.reader.readIdentityLag(now - deps.identityWindowMs),
      ]);
      const canary = await readCanary(now);
      const readings: Readings = {
        ...outboxReadings(outbox, now),
        ...identityReadings(identity, now),
        canary_round_trip_seconds: canary,
      };

      // `decide` throws for a malformed rule; the store then writes nothing and the
      // stored state stays as it was.
      const { reports, transitions, paging, advanced } = await deps.stateStore.update((stored) => {
        const resumed = resumeMetaAlertStates(stored, now, deps.intervalMs);
        const next = new Map<MetaAlertKey, StoredMetaAlertState>();
        const reports = {} as Record<MetaAlertKey, MonitorReadingReport>;
        const transitions: { key: MetaAlertKey; to: 'page' | 'clear' }[] = [];
        const paging: MetaAlertKey[] = [];
        for (const key of META_ALERT_KEYS) {
          const rule = deps.rules[key];
          const from = resumed.states.get(key);
          if (from === undefined) throw new Error(`no resumed state for ${key}`);
          const step = evaluateMetaAlert(rule, readings[key], from, now);
          const isPaging = resumed.advance ? step.state.paging : from.paging;
          reports[key] = {
            value: readings[key],
            status: resumed.advance ? step.status : heldStatus(step.status, from.paging),
            page_above: rule.pageAbove,
          };
          if (resumed.advance) {
            next.set(key, { state: step.state, evaluatedAt: now });
            if (step.transition !== null) transitions.push({ key, to: step.transition });
          }
          if (isPaging) paging.push(key);
        }
        return {
          write: resumed.advance ? next : null,
          result: { reports, transitions, paging, advanced: resumed.advance },
        };
      });

      await deps.pager.report(paging);
      return { at: isoFromEpochMs(now), readings: reports, transitions, paging, advanced };
    },
  };
}

/** A held cycle reports the stored level: it neither raises nor clears a page. */
function heldStatus(status: ReadingStatus, storedPaging: boolean): ReadingStatus {
  if (storedPaging) return status === 'unarmed' ? 'unarmed' : 'paging';
  return status === 'paging' ? 'breaching' : status;
}
