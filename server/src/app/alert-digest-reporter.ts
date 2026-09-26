/**
 * The per-cycle report of the live digest pass: one canonical-JSON line per cycle, plus
 * one line at start-up when the loop is disabled.
 *
 * `alert_digest_cycle` carries the whole {@link AlertDigestCycleReport} — accounts read,
 * failed and gone, per-outcome counts, undeliverable and copy-less groups, lost races,
 * cipher failures, candidates by kind and what was written. `undeliverable` is lifted to
 * the top level for grepping: a non-zero value means due windows are being re-offered
 * every tick rather than spent. The report holds counts and an instant only: no account
 * id, no zone id, no public id and never a coordinate (05 §5.3.2).
 *
 * `alert_digest_cycle_failed` is a cycle in which every account failed (or the listing
 * did); accounts decided before a failure stay committed, and the derived watermark makes
 * the retry skip them.
 *
 * `alert_digest_disabled` is written once, at start-up, with the blockers (see
 * `alert-digest-wiring.ts`).
 */

import { canonicalJson } from '../core/determinism/canonical-json.js';
import type { AlertDigestCycleReport } from '../core/alerts/digest-pass.js';
import type { JobRun } from '../core/scheduler/repeating-job.js';
import type { AlertDigestBlocker } from './alert-digest-wiring.js';

export interface AlertDigestReporterDeps {
  /** One canonical-JSON line per run, newline excluded; the worker adds it. */
  writeLine(line: string): void;
}

export function reportAlertDigestCycle(
  run: JobRun<AlertDigestCycleReport>,
  deps: AlertDigestReporterDeps,
): void {
  if (run.value === undefined) {
    deps.writeLine(
      canonicalJson({
        alert_digest_cycle_failed: { error: describeError(run.error), at: run.finishedAt },
      }),
    );
    return;
  }
  deps.writeLine(
    canonicalJson({
      alert_digest_cycle: run.value,
      undeliverable: run.value.undeliverable,
      duration_ms: run.finishedAt - run.startedAt,
    }),
  );
}

export function reportAlertDigestDisabled(
  disabled: { readonly blockers: readonly AlertDigestBlocker[] },
  deps: AlertDigestReporterDeps,
): void {
  deps.writeLine(canonicalJson({ alert_digest_disabled: { blockers: [...disabled.blockers] } }));
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
