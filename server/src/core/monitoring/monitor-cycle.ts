/**
 * One meta-alert cycle (TASKS J1; GATES L-8; OPERATIONS §3).
 *
 * read → readings → hysteresis → pager. The hysteresis state lives in this closure, not in
 * a table: a restart forgets the streaks, which costs at most `pageAfter` cycles of delay
 * on a page that is still true after the restart — and a page that clears across a
 * restart was cleared by healthchecks.io's own state, not by ours, because the pager
 * reports the level every cycle.
 *
 * The pager is called only after every reader succeeded. A cycle that throws reports
 * nothing, so a monitor that cannot see the database pages through the dead-man's switch
 * rather than reporting "all clear" over readings it never took.
 */

import type { CanaryProbe } from '../ports/canary-probe.js';
import type { Clock, EpochMs } from '../ports/clock.js';
import { isoFromEpochMs } from '../ports/clock.js';
import type { MetaAlertPager } from '../ports/meta-alert-pager.js';
import type { MonitorReader } from '../ports/monitor-reader.js';
import { INITIAL_CANARY_STATE, settleCanary, type CanaryState } from './canary.js';
import {
  evaluateMetaAlert,
  INITIAL_META_ALERT_STATE,
  type MetaAlertState,
  type ReadingStatus,
} from './meta-alert-evaluator.js';
import { META_ALERT_KEYS, type MetaAlertKey, type MetaAlertRules } from './meta-alert-params.js';
import { identityReadings, outboxReadings, type Readings } from './readings.js';

export interface MonitorCycleDeps {
  readonly reader: MonitorReader;
  readonly pager: MetaAlertPager;
  readonly clock: Clock;
  readonly rules: MetaAlertRules;
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
}

export interface MonitorCycle {
  runOnce(): Promise<MonitorCycleReport>;
}

export function createMonitorCycle(deps: MonitorCycleDeps): MonitorCycle {
  if (!Number.isFinite(deps.identityWindowMs) || deps.identityWindowMs < 0) {
    throw new RangeError('identityWindowMs must be a non-negative finite number');
  }
  let states = new Map<MetaAlertKey, MetaAlertState>();
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

      // Built into a fresh map and swapped in only once every key evaluated, so a rule
      // that throws (a malformed configuration) leaves the previous state intact.
      const next = new Map<MetaAlertKey, MetaAlertState>();
      const reports = {} as Record<MetaAlertKey, MonitorReadingReport>;
      const transitions: { key: MetaAlertKey; to: 'page' | 'clear' }[] = [];
      const paging: MetaAlertKey[] = [];
      for (const key of META_ALERT_KEYS) {
        const rule = deps.rules[key];
        const step = evaluateMetaAlert(
          rule,
          readings[key],
          states.get(key) ?? INITIAL_META_ALERT_STATE,
          now,
        );
        next.set(key, step.state);
        reports[key] = { value: readings[key], status: step.status, page_above: rule.pageAbove };
        if (step.transition !== null) transitions.push({ key, to: step.transition });
        if (step.state.paging) paging.push(key);
      }
      states = next;

      await deps.pager.report(paging);
      return { at: isoFromEpochMs(now), readings: reports, transitions, paging };
    },
  };
}
