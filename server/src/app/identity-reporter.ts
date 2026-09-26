/**
 * The per-cycle report of the live identity loop: one canonical-JSON line per cycle.
 *
 * `identity_cycle` carries the whole {@link IdentityCycleReport} — batches taken and
 * skipped, the summed engine stats, reignition links, and the tick's transition count —
 * so "no event ever left `active`" is answerable from the log alone. `behind` is lifted to
 * the top level because it is the one field an operator greps for: the cycle hit its batch
 * limit and the pipeline is catching up rather than idle.
 *
 * A failed cycle (`identity_cycle_failed`) is the whole cycle rolled back at the failing
 * transaction; batches committed before it stay committed and the ledger makes the retry
 * resume after them. There is no heartbeat leg: `identity` is not a budgeted job id (see
 * `identity-wiring.ts`).
 */

import { canonicalJson } from '../core/determinism/canonical-json.js';
import type { IdentityCycleReport } from '../core/identity/identity-cycle.js';
import type { JobRun } from '../core/scheduler/repeating-job.js';

export interface IdentityReporterDeps {
  /** One canonical-JSON line per run, newline excluded; the worker adds it. */
  writeLine(line: string): void;
}

export function reportIdentityCycle(
  run: JobRun<IdentityCycleReport>,
  deps: IdentityReporterDeps,
): void {
  if (run.value === undefined) {
    deps.writeLine(
      canonicalJson({
        identity_cycle_failed: { error: describeError(run.error), at: run.finishedAt },
      }),
    );
    return;
  }
  deps.writeLine(
    canonicalJson({
      identity_cycle: run.value,
      behind: run.value.batches.limitReached,
      duration_ms: run.finishedAt - run.startedAt,
    }),
  );
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
