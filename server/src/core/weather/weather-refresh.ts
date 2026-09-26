/**
 * One weather refresh: record the configured ECMWF Open Data surface fields for the
 * latest published run (TASKS C4; A19 — ECMWF Open Data is the source of record for our
 * own weather inputs; DATA-SOURCES §D2).
 *
 * The shape mirrors the EFFIS refresh, adapted to how ECMWF publishes: per step, fetch
 * the small `.index`, select our six fields, and Range-request each one out of the big
 * GRIB2 file. Fields already on disk are counted as `already_recorded` and not
 * refetched — a published run's bytes are immutable, so the hourly cadence costs one
 * index round-trip per step once a run has been captured, and a partially-failed run
 * heals itself on the next tick.
 *
 * Provenance follows the EFFIS pattern: each stored field gets a canonical-JSON sidecar
 * with the byte extent it was cut from, its hash, `available_at`, and the config
 * version it was recorded under. The `weather:context` feed row is recorded on every
 * cycle, success or not — the freshness page's data must survive the failure it reports.
 */

import { canonicalJson } from '../determinism/canonical-json.js';
import {
  WEATHER_CONTEXT,
  latestPublishedCycle,
  type WeatherContextValues,
} from '../config/weather-context.js';
import type { VersionedConfig } from '../config/versioned-config.js';
import type { Clock, EpochMs } from '../ports/clock.js';
import { isoFromEpochMs } from '../ports/clock.js';
import type { FeedStatusStore } from '../ports/feed-status-store.js';
import type { PayloadStore } from '../ports/payload-store.js';
import type { ForecastCycleRef, WeatherClient } from '../ports/weather-client.js';
import {
  checkGribSanity,
  selectIndexEntries,
  toByteRange,
  type EcmwfIndexEntry,
} from './ecmwf-index.js';

export interface WeatherRefreshDeps {
  readonly client: WeatherClient;
  readonly payloads: PayloadStore;
  readonly feedStatus: FeedStatusStore;
  readonly clock: Clock;
  readonly contextConfig?: VersionedConfig<WeatherContextValues>;
}

export type WeatherFieldOutcome =
  | 'stored'
  /** Already on disk from an earlier cycle of the same run — immutable, not refetched. */
  | 'already_recorded'
  /** The index does not list this param for this step. */
  | 'missing_from_index'
  | 'fetch_failed'
  /** The ranged bytes failed the structural GRIB sanity check. Nothing recorded. */
  | 'unsound'
  | 'write_failed';

export interface WeatherFieldResult {
  readonly param: string;
  readonly step: number;
  readonly outcome: WeatherFieldOutcome;
  readonly bytes: number;
  readonly error: string | null;
}

export interface WeatherStepResult {
  readonly step: number;
  /** `false` means the index request itself failed; `fields` is then empty. */
  readonly indexFetched: boolean;
  readonly fields: readonly WeatherFieldResult[];
  readonly error: string | null;
}

export interface WeatherRefreshReport {
  readonly startedAt: EpochMs;
  readonly finishedAt: EpochMs;
  readonly cycle: ForecastCycleRef;
  readonly steps: readonly WeatherStepResult[];
  /** `null` when the `weather:context` feed row was recorded. */
  readonly feedStatusError: string | null;
}

/**
 * The degraded gate. Failed when the evidence chain broke or when not even one index
 * was reachable — individual missing or unsound fields degrade the *feed* row (the
 * cycle succeeded at its job of finding that out), not the worker loop.
 */
export function weatherRefreshFailed(report: WeatherRefreshReport): boolean {
  return report.feedStatusError !== null || report.steps.every((step) => !step.indexFetched);
}

/** `weather/ecmwf/20260813/06z/0h/10u.grib2` — run-addressed, so re-runs are no-ops. */
export function weatherFieldPath(cycle: ForecastCycleRef, step: number, param: string): string {
  return `weather/ecmwf/${cycle.dateYmd}/${cycleHourLabel(cycle)}z/${String(step)}h/${param}.grib2`;
}

export async function runWeatherRefresh(deps: WeatherRefreshDeps): Promise<WeatherRefreshReport> {
  const config = deps.contextConfig ?? WEATHER_CONTEXT;
  const values = config.values;
  const startedAt = deps.clock.now();
  const cycle = latestPublishedCycle(startedAt, values);

  const steps: WeatherStepResult[] = [];
  for (const step of values.steps) {
    steps.push(await refreshStep(cycle, step, deps, config));
  }

  const attemptAt = deps.clock.now();
  const succeeded =
    steps.every((step) => step.indexFetched) &&
    steps.every((step) =>
      step.fields.every(
        (field) => field.outcome === 'stored' || field.outcome === 'already_recorded',
      ),
    );
  const hadData = steps.some((step) => step.fields.some((field) => field.outcome === 'stored'));

  let feedStatusError: string | null = null;
  try {
    await deps.feedStatus.recordAttempt({
      row: 'weather:context',
      attemptAt,
      succeeded,
      hadData,
      error: joinErrors(steps),
    });
  } catch (error: unknown) {
    feedStatusError = describeError(error);
  }

  return { startedAt, finishedAt: deps.clock.now(), cycle, steps, feedStatusError };
}

async function refreshStep(
  cycle: ForecastCycleRef,
  step: number,
  deps: WeatherRefreshDeps,
  config: VersionedConfig<WeatherContextValues>,
): Promise<WeatherStepResult> {
  const values = config.values;

  let index;
  try {
    index = await deps.client.fetchIndex(cycle, step);
  } catch (error: unknown) {
    index = { text: null, availableAt: null, error: describeError(error) };
  }
  if (index.text === null) {
    return {
      step,
      indexFetched: false,
      fields: [],
      error: index.error ?? 'index fetch failed without a reason',
    };
  }

  const selection = selectIndexEntries(index.text, step, values);
  const fields: WeatherFieldResult[] = [];

  for (const param of selection.missingParams) {
    fields.push({
      param,
      step,
      outcome: 'missing_from_index',
      bytes: 0,
      error: `param ${param} is not in the index for step ${String(step)}`,
    });
  }

  for (const entry of selection.entries) {
    fields.push(await recordField(cycle, step, entry, deps, config));
  }

  return { step, indexFetched: true, fields, error: null };
}

async function recordField(
  cycle: ForecastCycleRef,
  step: number,
  entry: EcmwfIndexEntry,
  deps: WeatherRefreshDeps,
  config: VersionedConfig<WeatherContextValues>,
): Promise<WeatherFieldResult> {
  const path = weatherFieldPath(cycle, step, entry.param);

  try {
    if (await deps.payloads.exists(path)) {
      return {
        param: entry.param,
        step,
        outcome: 'already_recorded',
        bytes: entry.length,
        error: null,
      };
    }
  } catch {
    // An unanswerable `exists` will surface as a loud write failure below; proceeding is
    // the option that can still leave the field recorded.
  }

  let fetched;
  try {
    fetched = await deps.client.fetchRange(cycle, step, toByteRange(entry));
  } catch (error: unknown) {
    fetched = { bytes: null, availableAt: null, error: describeError(error) };
  }
  if (fetched.bytes === null) {
    return {
      param: entry.param,
      step,
      outcome: 'fetch_failed',
      bytes: 0,
      error: fetched.error ?? 'range fetch failed without a reason',
    };
  }

  const sanity = checkGribSanity(fetched.bytes, config.values.byteFloorBytes);
  if (!sanity.sane) {
    return {
      param: entry.param,
      step,
      outcome: 'unsound',
      bytes: fetched.bytes.byteLength,
      error: sanity.reason,
    };
  }

  const availableAt = fetched.availableAt ?? deps.clock.now();
  try {
    const written = await deps.payloads.writePayload(path, fetched.bytes);
    await deps.payloads.writeText(
      `weather/ecmwf/${cycle.dateYmd}/${cycleHourLabel(cycle)}z/${String(step)}h/${entry.param}.meta.json`,
      `${canonicalJson({
        feed: 'weather:context',
        provider: 'ecmwf-open-data',
        date: cycle.dateYmd,
        hour: cycle.hour,
        step,
        param: entry.param,
        levtype: entry.levtype,
        offset: entry.offset,
        length: entry.length,
        bytes: written.bytes,
        sha256: written.sha256,
        available_at: isoFromEpochMs(availableAt),
        weather_context_version: config.version,
        weather_context_digest: config.digest,
      })}\n`,
    );
    return { param: entry.param, step, outcome: 'stored', bytes: written.bytes, error: null };
  } catch (error: unknown) {
    return {
      param: entry.param,
      step,
      outcome: 'write_failed',
      bytes: fetched.bytes.byteLength,
      error: describeError(error),
    };
  }
}

function cycleHourLabel(cycle: ForecastCycleRef): string {
  return String(cycle.hour).padStart(2, '0');
}

function joinErrors(steps: readonly WeatherStepResult[]): string | null {
  const errors: string[] = [];
  for (const step of steps) {
    if (step.error !== null) errors.push(`step ${String(step.step)}: ${step.error}`);
    for (const field of step.fields) {
      if (field.error !== null)
        errors.push(`${field.param}@${String(field.step)}h: ${field.error}`);
    }
  }
  return errors.length === 0 ? null : errors.join('; ');
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
