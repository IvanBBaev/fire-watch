/**
 * The meta-alert route's verdict (TASKS J1): what `GET /api/health/meta` answers, from the
 * monitors loop's last run.
 *
 * The route is the pull side of the same readings the loop pushes to healthchecks.io and
 * exports as metrics. It exists for the operator and the runbooks (RB-1, RB-3): one body
 * that says whether a meta-alert is paging, and why, without opening a dashboard.
 *
 * It is never served by the public server — the readings are an inventory of the alert
 * path (queue depth, claimed rows, identity backlog) — only by the internal, token-guarded
 * listener the worker already runs for `/metrics`.
 *
 * Verdicts, in precedence order:
 *
 *   * `stale` (500) — no run has finished within {@link META_HEALTH_STALE_AFTER_INTERVALS}
 *     intervals: the loop is dead or wedged, and its last readings say nothing about now.
 *     A process that has never finished a run counts from its own start.
 *   * `failed` (500) — the last run threw: the monitor could not take its readings, and
 *     "all clear" over readings it never took would be a lie (the same reason the pager is
 *     never called on a failed cycle).
 *   * `paging` (500) — the last run finished with at least one key paging after hysteresis.
 *   * `starting` (200) — no run has finished yet and the process is younger than the stale
 *     window. Never a 500, for the reason OPERATIONS §2.2 rule 2 gives `unknown`: a fresh
 *     process must not fail its first deploy smoke.
 *   * `ok` (200) — the last run finished and nothing is paging.
 *
 * The status code is a page signal only for the three 500s; the body carries the readings
 * either way. A failed run's error message is not in the body — it is in the redacted log
 * line `meta_alerts_failed`, which is where the runbook sends the operator.
 */

import type { EpochMs } from '../ports/clock.js';
import { isoFromEpochMs } from '../ports/clock.js';
import type { JobRun } from '../scheduler/repeating-job.js';
import type { MetaAlertKey } from './meta-alert-params.js';
import type { MonitorCycleReport, MonitorReadingReport } from './monitor-cycle.js';

/**
 * Three missed cycles before the route calls the loop stale. Not a design number: one
 * interval of slack for a slow cycle, one for the scheduler, one for the read itself.
 */
export const META_HEALTH_STALE_AFTER_INTERVALS = 3;

export type MetaHealthStatus = 'ok' | 'starting' | 'paging' | 'failed' | 'stale';

export interface MetaHealthBody {
  readonly status: MetaHealthStatus;
  readonly generatedAt: string;
  /** When the last run finished, successful or not; `null` before the first one. */
  readonly lastRunAt: string | null;
  /** Seconds since {@link lastRunAt} (or since the process started, before the first run). */
  readonly ageSeconds: number;
  readonly staleAfterSeconds: number;
  /** Keys paging after the last successful run; empty when it failed or never ran. */
  readonly paging: readonly MetaAlertKey[];
  /** The last successful run's readings; `null` when the last run failed or none ran. */
  readonly readings: Readonly<Record<MetaAlertKey, MonitorReadingReport>> | null;
}

export interface MetaHealthVerdict {
  readonly statusCode: 200 | 500;
  readonly body: MetaHealthBody;
}

export interface MetaHealthInput {
  readonly last: JobRun<MonitorCycleReport> | null;
  /** When the process (the holder of `last`) started. */
  readonly startedAt: EpochMs;
  readonly now: EpochMs;
  readonly intervalMs: number;
}

export function evaluateMetaHealth(input: MetaHealthInput): MetaHealthVerdict {
  if (!Number.isFinite(input.intervalMs) || input.intervalMs <= 0) {
    throw new RangeError('intervalMs must be a positive finite number');
  }
  const staleAfterMs = input.intervalMs * META_HEALTH_STALE_AFTER_INTERVALS;
  const last = input.last;
  const since = last === null ? input.startedAt : last.finishedAt;
  const ageMs = Math.max(0, input.now - since);
  const succeeded = last !== null && last.value !== undefined ? last.value : null;

  const status: MetaHealthStatus =
    ageMs > staleAfterMs
      ? 'stale'
      : last === null
        ? 'starting'
        : succeeded === null
          ? 'failed'
          : succeeded.paging.length > 0
            ? 'paging'
            : 'ok';

  return {
    statusCode: status === 'ok' || status === 'starting' ? 200 : 500,
    body: {
      status,
      generatedAt: isoFromEpochMs(input.now),
      lastRunAt: last === null ? null : isoFromEpochMs(last.finishedAt),
      ageSeconds: Math.floor(ageMs / 1000),
      staleAfterSeconds: Math.floor(staleAfterMs / 1000),
      paging: succeeded?.paging ?? [],
      readings: succeeded?.readings ?? null,
    },
  };
}
