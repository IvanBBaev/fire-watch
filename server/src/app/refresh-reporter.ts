/**
 * The per-run reports for the C4 refresh loops: one canonical-JSON line each, and the
 * gate that decides whether the dead-man's switch hears about the EFFIS refresh.
 *
 * Outside the worker for the same reason as `cycle-reporter.ts`: the one conditional
 * whose job is to keep a *failing* refresh quiet must sit where a test can flip it.
 *
 * Only the EFFIS refresh has a heartbeat leg — `effis-refresh` is a budgeted job id
 * (C5); the weather refresh is watched through its `weather:context` feed row alone,
 * so its reporter has no heartbeat to gate.
 */

import { canonicalJson } from '../core/determinism/canonical-json.js';
import { effisRefreshFailed, type EffisRefreshReport } from '../core/effis/effis-refresh.js';
import type { Heartbeat } from '../core/ports/heartbeat.js';
import type { JobRun } from '../core/scheduler/repeating-job.js';
import {
  weatherRefreshFailed,
  type WeatherRefreshReport,
} from '../core/weather/weather-refresh.js';

export interface EffisRefreshReporterDeps {
  readonly heartbeat: Heartbeat;
  /** One canonical-JSON line per run, newline excluded; the worker adds it. */
  writeLine(line: string): void;
}

export async function reportEffisRefresh(
  run: JobRun<EffisRefreshReport>,
  deps: EffisRefreshReporterDeps,
): Promise<void> {
  if (run.value === undefined) {
    // The cycle catches its own per-layer failures, so reaching here means the wiring
    // itself threw — the line is all the evidence there will be.
    deps.writeLine(
      canonicalJson({
        effis_refresh_failed: { error: describeError(run.error), at: run.finishedAt },
      }),
    );
    return;
  }

  const failed = effisRefreshFailed(run.value);
  deps.writeLine(canonicalJson({ effis_refresh: run.value, degraded: failed }));

  // Success branch only, exactly like the ingest heartbeat: a ping sent regardless would
  // keep the off-box monitor calm about a refresh that has stored nothing for a week.
  if (!failed) await deps.heartbeat.succeeded('effis-refresh');
}

export interface WeatherRefreshReporterDeps {
  writeLine(line: string): void;
}

export function reportWeatherRefresh(
  run: JobRun<WeatherRefreshReport>,
  deps: WeatherRefreshReporterDeps,
): void {
  if (run.value === undefined) {
    deps.writeLine(
      canonicalJson({
        weather_refresh_failed: { error: describeError(run.error), at: run.finishedAt },
      }),
    );
    return;
  }
  deps.writeLine(
    canonicalJson({ weather_refresh: run.value, degraded: weatherRefreshFailed(run.value) }),
  );
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
