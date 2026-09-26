/**
 * The per-cycle report of the live digest pass: one canonical-JSON line per cycle, plus
 * one line at start-up when the loop is disabled.
 *
 * `alert_digest_cycle` carries the whole {@link AlertDigestCycleReport} — accounts read,
 * failed and gone, per-outcome counts, undeliverable windows, lost races, lines sent and
 * what was written. Counts and an instant only: the core's report carries no account id,
 * zone id, event id, distance or coordinate, and this adds none.
 *
 * `alert_digest_cycle_failed` is an outage: the account listing itself failed, or every
 * account did. A failed account among healthy ones is only a count, rolled back and
 * retried next tick.
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
