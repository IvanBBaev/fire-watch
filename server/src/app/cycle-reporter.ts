/**
 * The worker's per-cycle report: one canonical-JSON line to the log, and the gate that
 * decides whether the dead-man's switch hears about the cycle (C5, OPERATIONS §3).
 *
 * This lives next to the worker rather than inside it because the worker is an entrypoint
 * — importing it runs `main()` — and the one conditional whose job is to keep a *failing*
 * worker quiet must not sit where no test can reach it. Flipping that condition would
 * turn the heartbeat into a switch that reports "alive" for a worker failing every cycle.
 */

import { canonicalJson } from '../core/determinism/canonical-json.js';
import { cycleFailed, type IngestCycleReport } from '../core/ingest/ingest-cycle.js';
import type { Heartbeat } from '../core/ports/heartbeat.js';
import type { JobRun } from '../core/scheduler/repeating-job.js';

export interface CycleReporterDeps {
  readonly heartbeat: Heartbeat;
  /** Receives one canonical-JSON line per cycle, newline excluded; the worker adds it and writes to stdout. */
  writeLine(line: string): void;
}

export async function reportCycle(
  run: JobRun<IngestCycleReport>,
  deps: CycleReporterDeps,
): Promise<void> {
  if (run.value === undefined) {
    // The cycle records its own per-source failures, so reaching here means the wiring
    // itself threw — the report is all the evidence there will be.
    deps.writeLine(
      canonicalJson({
        ingest_cycle_failed: { error: describeError(run.error), at: run.finishedAt },
      }),
    );
    return;
  }

  const failed = cycleFailed(run.value);
  deps.writeLine(canonicalJson({ ingest_cycle: run.value, degraded: failed }));

  // The ping is inside the success branch and nowhere else. Sending it unconditionally —
  // from a `finally`, or before the check — would produce a switch that keeps reporting
  // "alive" for a worker that has been failing every cycle for a week, which is the exact
  // failure this leg exists to catch (§3). A single source outage is not a failed cycle:
  // that is what the per-source freshness budgets are for.
  if (!failed) await deps.heartbeat.succeeded('ingest-cycle');
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
