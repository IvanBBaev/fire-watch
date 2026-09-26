/**
 * The per-cycle report for the alert dispatch job: one canonical-JSON line each.
 *
 * Outside the wiring for the same reason as `cycle-reporter.ts`: the one field an alarm
 * keys on — `pages` — is decided here, and it must sit where a test can flip it. A halt
 * pages exactly when `dispatchAllowance` says so; the kill switch is the only halt that
 * does not, because it is the one a human asked for.
 *
 * No heartbeat leg: `alert-dispatch` is not a budgeted job id (C5), and a ping on every
 * halted cycle would keep the off-box monitor calm about a dispatcher that has sent
 * nothing for a day. D6's queue-age alarm is the signal a stalled outbox raises.
 */

import type { DispatchAllowance } from '../core/alerts/dispatch-breaker.js';
import { canonicalJson } from '../core/determinism/canonical-json.js';
import type { JobRun } from '../core/scheduler/repeating-job.js';

export interface DispatchReporterDeps {
  /** One canonical-JSON line per cycle, newline excluded; the worker adds it. */
  writeLine(line: string): void;
}

/**
 * The one field this module reads. Structural rather than `DispatchJobReport`, so the
 * wiring can import the reporter without the reporter importing the wiring back.
 */
export interface DispatchReportLike {
  readonly allowance: DispatchAllowance;
}

export function reportDispatch(run: JobRun<DispatchReportLike>, deps: DispatchReporterDeps): void {
  if (run.value === undefined) {
    // The cycle reads the control files and releases claims before it decides anything,
    // so reaching here means one of those threw — nothing was claimed after it.
    deps.writeLine(
      canonicalJson({
        alert_dispatch_failed: { error: describeError(run.error), at: run.finishedAt },
      }),
    );
    return;
  }
  const { allowance } = run.value;
  deps.writeLine(
    canonicalJson({
      alert_dispatch: run.value,
      pages: allowance.state === 'halted' && allowance.pages,
    }),
  );
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
