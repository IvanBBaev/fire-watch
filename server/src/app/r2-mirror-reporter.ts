/**
 * The per-run reports for the two R2 mirror loops (TASKS E3): one canonical-JSON line each,
 * and the gate that decides whether the dead-man's switch hears about the push.
 *
 * Outside the wiring for the same reason as `refresh-reporter.ts`: the one conditional
 * whose job is to keep a *failing* push quiet must sit where a test can flip it.
 */

import { canonicalJson } from '../core/determinism/canonical-json.js';
import type { Heartbeat } from '../core/ports/heartbeat.js';
import type { JobRun } from '../core/scheduler/repeating-job.js';
import type { MirrorAgeVerdict } from '../core/snapshot/mirror-age.js';
import { mirrorPushFailed, type MirrorPushReport } from '../core/snapshot/mirror-push.js';

export interface MirrorPushReporterDeps {
  readonly heartbeat: Heartbeat;
  /** One canonical-JSON line per run, newline excluded; the worker adds it. */
  writeLine(line: string): void;
}

export async function reportMirrorPush(
  run: JobRun<MirrorPushReport>,
  deps: MirrorPushReporterDeps,
): Promise<void> {
  if (run.value === undefined) {
    // The push catches its own read and upload failures, so reaching here means recording
    // the attempt threw — the line is all the evidence there will be.
    deps.writeLine(
      canonicalJson({
        r2_mirror_push_failed: { error: describeError(run.error), at: run.finishedAt },
      }),
    );
    return;
  }
  const failed = mirrorPushFailed(run.value);
  deps.writeLine(canonicalJson({ r2_mirror_push: run.value, degraded: failed }));
  // Success only: a ping sent regardless would keep the off-box monitor calm about a T2
  // object that has not been replaced for a week.
  if (!failed) await deps.heartbeat.succeeded('snapshot-push');
}

export interface MirrorAgeReporterDeps {
  writeLine(line: string): void;
}

export function reportMirrorAge(run: JobRun<MirrorAgeVerdict>, deps: MirrorAgeReporterDeps): void {
  if (run.value === undefined) {
    deps.writeLine(
      canonicalJson({
        r2_mirror_age_failed: { error: describeError(run.error), at: run.finishedAt },
      }),
    );
    return;
  }
  deps.writeLine(canonicalJson({ r2_mirror_age: run.value, degraded: run.value.level !== 'ok' }));
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
