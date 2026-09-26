/**
 * Wiring and per-run report for the weekly QA report loop (TASKS D8).
 *
 * Kept out of `worker.ts` so the worker's hookup is a handful of lines and the part worth
 * testing — which adapters the job gets, and what one run prints — sits where a test can
 * reach it. The CLI (`qa-report-cli.ts`) builds its job from the same pieces.
 *
 * Nothing here connects: `createPgPool` opens a socket only when a query asks for one.
 *
 * The cadence is hourly. Each run looks at the last closed ISO week and stops at one
 * indexed lookup when that week is already stored, so the report lands within an hour of
 * Monday 00:00 UTC, and a worker that was down over the boundary catches up on its first
 * run. Only the most recent closed week is caught up; older gaps are the CLI's job.
 */

import { systemClock } from '../adapters/clock/system-clock.js';
import { createPgPool } from '../adapters/db/pg-pool.js';
import { createPgQaReportStore } from '../adapters/db/pg-qa-report-store.js';
import { canonicalJson } from '../core/determinism/canonical-json.js';
import {
  summarizeOutcome,
  type WeeklyQaReportDeps,
  type WeeklyQaReportOutcome,
} from '../core/qa/weekly-report-job.js';
import type { JobRun } from '../core/scheduler/repeating-job.js';
import type { ServerConfig } from './config.js';

export const QA_REPORT_INTERVAL_MS = 3_600_000;

export interface QaReportWiring {
  readonly deps: WeeklyQaReportDeps;
  /** Releases the pool. Always called from a `finally`. */
  close(): Promise<void>;
}

export function wireQaReport(config: ServerConfig): QaReportWiring {
  const pool = createPgPool({
    databaseUrl: config.databaseUrl,
    role: config.databaseRole,
    applicationName: config.applicationName,
  });
  const store = createPgQaReportStore(pool);
  return {
    deps: {
      reader: store,
      store,
      clock: systemClock,
      pollIntervalMs: config.pollIntervalMs,
    },
    close: () => pool.end(),
  };
}

export interface QaReportReporterDeps {
  /** One canonical-JSON line per run, newline excluded; the worker adds it. */
  writeLine(line: string): void;
}

/**
 * One line per run: the summary, never the report body (that is in the table). No
 * heartbeat leg: a missed weekly report is a log line, not a page.
 */
export function reportQaWeekly(
  run: JobRun<WeeklyQaReportOutcome>,
  deps: QaReportReporterDeps,
): void {
  if (run.value === undefined) {
    deps.writeLine(
      canonicalJson({
        qa_weekly_report_failed: {
          error: run.error instanceof Error ? run.error.message : String(run.error),
          at: run.finishedAt,
        },
      }),
    );
    return;
  }
  deps.writeLine(canonicalJson({ qa_weekly_report: summarizeOutcome(run.value) }));
}
