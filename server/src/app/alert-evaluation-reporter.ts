/**
 * The per-cycle report of the live alert evaluation loop: one canonical-JSON line per
 * cycle, plus one line at start-up when the loop is disabled.
 *
 * `alert_evaluation_cycle` carries the whole {@link AlertEvaluationCycleReport} — the
 * cursor range, batches, skips, cipher failures, per-outcome and per-reason counts, and
 * what was written. `behind` is lifted to the top level for grepping, as in the identity
 * report. The report holds counts, seqs and an instant only: no zone id, no account id,
 * no public id and never a coordinate (05 §5.3.2).
 *
 * `alert_evaluation_cycle_failed` is one batch rolled back; batches committed before it
 * stay committed and the durable cursor makes the retry resume after them.
 *
 * `alert_evaluation_disabled` is written once, at start-up, with the blockers and the
 * known gaps (see `alert-evaluation-wiring.ts`).
 */

import { canonicalJson } from '../core/determinism/canonical-json.js';
import type { AlertEvaluationCycleReport } from '../core/alerts/evaluation-cycle.js';
import type { JobRun } from '../core/scheduler/repeating-job.js';
import type { AlertEvaluationBlocker, AlertEvaluationGap } from './alert-evaluation-wiring.js';

export interface AlertEvaluationReporterDeps {
  /** One canonical-JSON line per run, newline excluded; the worker adds it. */
  writeLine(line: string): void;
}

export function reportAlertEvaluationCycle(
  run: JobRun<AlertEvaluationCycleReport>,
  deps: AlertEvaluationReporterDeps,
): void {
  if (run.value === undefined) {
    deps.writeLine(
      canonicalJson({
        alert_evaluation_cycle_failed: { error: describeError(run.error), at: run.finishedAt },
      }),
    );
    return;
  }
  deps.writeLine(
    canonicalJson({
      alert_evaluation_cycle: run.value,
      behind: run.value.behind,
      duration_ms: run.finishedAt - run.startedAt,
    }),
  );
}

export function reportAlertEvaluationDisabled(
  disabled: {
    readonly blockers: readonly AlertEvaluationBlocker[];
    readonly gaps: readonly AlertEvaluationGap[];
  },
  deps: AlertEvaluationReporterDeps,
): void {
  deps.writeLine(
    canonicalJson({
      alert_evaluation_disabled: { blockers: [...disabled.blockers], gaps: [...disabled.gaps] },
    }),
  );
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
