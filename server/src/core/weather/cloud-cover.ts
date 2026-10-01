/**
 * The F17 cloud-per-pass forecast, core half: cut ECMWF's `tcc` (total cloud cover) to the
 * pass-cell grid, and answer "how cloudy was the cell forecast to be at this instant"
 * (TASKS F17; A19; DATA-SOURCES §D2; config `cloud_cover_v1`).
 *
 * **Why it exists.** A polar orbiter only detects a fire through a clear sky. A pass in
 * the panel with no cloud context invites "the satellite flew over and saw nothing, so
 * there is nothing" — the cloud figure beside it is the honest qualifier. It is ECMWF's
 * IFS *forecast* of cloud, never an observation, and every consumer is told so.
 *
 * **Derived in the worker, served as a file** — the wind layer's pattern (F14). The
 * weather refresh records `tcc` at the `cloud_cover_v1` steps; after it, the worker
 * decodes each step once and writes `weather/cloud/current.json`: whole-percent values at
 * every 0.5° pass-cell centre of the polling bbox, per step. The passes route reads that
 * small document on a request, never a GRIB file.
 *
 * **Nothing is guessed.** Every field's bytes must hash to the `sha256` its provenance
 * sidecar recorded, and the decoded message must say it is what its path claims:
 * discipline 0, category 6, number 192 (ECMWF-local total cloud cover), surface type 1
 * (ground or water surface; its value is the missing sentinel, so it is not compared),
 * the recorded run as reference time and the recorded step as forecast time — and every
 * value must be a fraction in [0, 1]. A step that fails any of that is left out and
 * named in the report; the others still ship.
 *
 * **Runs.** The latest run's steps, plus the previous run's `previousRunSteps` for valid
 * times *before* the latest run's reference time (the window's past end; see the config).
 * Each step names the run it came from. When the latest run has no usable step at all
 * the stored document is left in place — the route's time bracket stops an old document
 * from answering for hours it does not cover.
 */

import { canonicalJson } from '../determinism/canonical-json.js';
import { CLOUD_COVER, type CloudCoverValues } from '../config/cloud-cover.js';
import {
  WEATHER_CONTEXT,
  latestPublishedCycle,
  type WeatherContextValues,
} from '../config/weather-context.js';
import { configDigest, type VersionedConfig } from '../config/versioned-config.js';
import { epochMsFromIso, isoFromEpochMs, type EpochMs } from '../ports/clock.js';
import type { PayloadReader } from '../ports/payload-reader.js';
import type { PayloadStore } from '../ports/payload-store.js';
import type { ForecastCycleRef } from '../ports/weather-client.js';
import { decodeGrib2, valueNear, type Grib2Field } from './grib2.js';
import { runWeatherRefresh, weatherFieldPath, type WeatherRefreshDeps } from './weather-refresh.js';
import {
  cycleEpochMs,
  deriveWindOverlay,
  parseFieldSidecar,
  storedInputsDigest,
  type WeatherAndWindReport,
  type WindDerivationDeps,
  type WindGrid,
} from './wind-overlay.js';

/** Bumped when the stored document's shape changes incompatibly. */
export const CLOUD_DOCUMENT_SCHEMA_VERSION = 1;

export const CLOUD_CURRENT_PATH = 'weather/cloud/current.json';
export const CLOUD_CURRENT_META_PATH = 'weather/cloud/current.meta.json';

const HOUR_MS = 3_600_000;

export interface CloudStep {
  /** The run this step belongs to — the latest, or the one before for the window's past. */
  readonly run_at: string;
  readonly step_hours: number;
  readonly valid_at: string;
  /** `rows × cols` whole percentages, 0–100. */
  readonly cloud_pct: readonly number[];
}

/** What the worker writes to {@link CLOUD_CURRENT_PATH}. */
export interface CloudDocument {
  readonly schema_version: number;
  readonly provider: 'ecmwf-open-data';
  readonly model: 'ifs';
  /** Always `forecast`: a consumer must never present this as an observed sky. */
  readonly kind: 'forecast';
  readonly param: 'tcc';
  /** The latest `available_at` among the input fields. */
  readonly available_at: string;
  /** Points at pass-cell centres; the same shape as the wind grid. */
  readonly grid: WindGrid;
  /** Ascending by `valid_at`, one step per valid time. */
  readonly steps: readonly CloudStep[];
  readonly cloud_cover_version: string;
  readonly cloud_cover_digest: string;
}

export interface CloudDerivationDeps {
  readonly reader: PayloadReader;
  readonly payloads: PayloadStore;
  readonly cloudConfig?: VersionedConfig<CloudCoverValues>;
}

export type CloudStepOutcome =
  | 'derived'
  | 'missing'
  | 'integrity_mismatch'
  | 'refused'
  | 'identity_mismatch'
  /** A value outside [0, 1], or the IFS field does not cover a cell centre. */
  | 'out_of_range';

export interface CloudStepResult {
  readonly runAt: string;
  readonly step: number;
  readonly outcome: CloudStepOutcome;
  readonly detail: string | null;
}

export type CloudDerivationOutcome =
  'written' | 'unchanged' | 'no_steps' | 'read_failed' | 'write_failed';

export interface CloudDerivationResult {
  readonly outcome: CloudDerivationOutcome;
  readonly runAt: string;
  readonly steps: readonly CloudStepResult[];
  readonly error: string | null;
}

export interface WeatherWindAndCloudReport extends WeatherAndWindReport {
  readonly cloud: CloudDerivationResult;
}

/**
 * The worker's hourly weather job: the refresh (recording the extra `tcc` steps
 * `cloud_cover_v1` asks for), then the wind and cloud derivations for the run it just
 * recorded. A derived product's failure shows up in the job's log line, never in the
 * `weather:context` feed row.
 */
export async function runWeatherJob(
  refresh: WeatherRefreshDeps,
  wind: WindDerivationDeps,
  cloud: CloudDerivationDeps = { reader: wind.reader, payloads: wind.payloads },
): Promise<WeatherWindAndCloudReport> {
  const config = cloud.cloudConfig ?? CLOUD_COVER;
  const report = await runWeatherRefresh({
    ...refresh,
    extraFields: refresh.extraFields ?? {
      params: [config.values.param],
      steps: config.values.steps,
      config: { version: config.version, digest: config.digest },
    },
  });
  const context = refresh.contextConfig ?? WEATHER_CONTEXT;
  return {
    ...report,
    wind: await deriveWindOverlay(report.cycle, wind, context),
    cloud: await deriveCloudCover(report.cycle, cloud, context),
  };
}

/** The pass-cell-centre grid for a config: cell centres from `west + cellDeg / 2`. */
export function cloudGrid(values: CloudCoverValues): WindGrid {
  const { bbox, cellDeg } = values;
  const cols = Math.round((bbox.east - bbox.west) / cellDeg);
  const rows = Math.round((bbox.north - bbox.south) / cellDeg);
  const half = cellDeg / 2;
  return {
    west: bbox.west + half,
    south: bbox.south + half,
    east: bbox.west + half + (cols - 1) * cellDeg,
    north: bbox.south + half + (rows - 1) * cellDeg,
    resolution_deg: cellDeg,
    cols,
    rows,
    order: 'north_to_south_west_to_east',
  };
}

/** The run before `cycle` under the context's cycle hours. */
export function previousCycle(
  cycle: ForecastCycleRef,
  context: WeatherContextValues = WEATHER_CONTEXT.values,
): ForecastCycleRef {
  return latestPublishedCycle(
    cycleEpochMs(cycle) - 1 + context.publicationDelayHours * HOUR_MS,
    context,
  );
}

interface Candidate {
  readonly cycle: ForecastCycleRef;
  readonly runAtMs: EpochMs;
  readonly step: number;
  readonly sidecar: { sha256: string; availableAtMs: EpochMs };
}

/**
 * Derive the cloud document for `cycle` and store it, unless the recorded inputs are the
 * ones the stored document was built from (compared on the sidecars' hashes before any
 * decoding, so an unchanged hour costs a few small reads). Never throws for bad data.
 */
export async function deriveCloudCover(
  cycle: ForecastCycleRef,
  deps: CloudDerivationDeps,
  context: VersionedConfig<WeatherContextValues> = WEATHER_CONTEXT,
): Promise<CloudDerivationResult> {
  const config = deps.cloudConfig ?? CLOUD_COVER;
  const values = config.values;
  const runAtMs = cycleEpochMs(cycle);
  const runAt = isoFromEpochMs(runAtMs);
  const grid = cloudGrid(values);
  const previous = previousCycle(cycle, context.values);
  const previousRunAtMs = cycleEpochMs(previous);

  const results: CloudStepResult[] = [];
  const candidates: Candidate[] = [];
  try {
    const wanted: [ForecastCycleRef, EpochMs, number][] = [
      ...values.steps.map((step): [ForecastCycleRef, EpochMs, number] => [cycle, runAtMs, step]),
      ...values.previousRunSteps
        .filter((step) => previousRunAtMs + step * HOUR_MS < runAtMs)
        .map((step): [ForecastCycleRef, EpochMs, number] => [previous, previousRunAtMs, step]),
    ];
    for (const [run, at, step] of wanted) {
      const path = sidecarPath(run, step, values.param);
      const text = await deps.reader.readText(path);
      const sidecar = text === null ? null : parseFieldSidecar(text);
      if (sidecar === null) {
        results.push({
          runAt: isoFromEpochMs(at),
          step,
          outcome: text === null ? 'missing' : 'integrity_mismatch',
          detail: text === null ? 'not recorded' : 'sidecar is unreadable',
        });
        continue;
      }
      candidates.push({ cycle: run, runAtMs: at, step, sidecar });
    }
  } catch (error: unknown) {
    return { outcome: 'read_failed', runAt, steps: results, error: describeError(error) };
  }

  if (!candidates.some((candidate) => candidate.runAtMs === runAtMs)) {
    return { outcome: 'no_steps', runAt, steps: results, error: null };
  }

  // FNV over what is recorded and the parameters: change detection, not a security claim.
  const inputsDigest = configDigest({
    run_at: runAt,
    inputs: candidates.map((c) => ({
      run_at: isoFromEpochMs(c.runAtMs),
      step: c.step,
      sha256: c.sidecar.sha256,
    })),
    cloud_cover_digest: config.digest,
    schema_version: CLOUD_DOCUMENT_SCHEMA_VERSION,
  });
  try {
    const stored = await deps.reader.readText(CLOUD_CURRENT_META_PATH);
    if (stored !== null && storedInputsDigest(stored) === inputsDigest) {
      return { outcome: 'unchanged', runAt, steps: results, error: null };
    }
  } catch {
    // An unreadable sidecar is not a reason to keep an old document: rewrite.
  }

  const steps: CloudStep[] = [];
  let availableAtMs = 0;
  try {
    for (const candidate of candidates) {
      const read = await readStep(deps.reader, candidate, values.param, grid);
      const label = { runAt: isoFromEpochMs(candidate.runAtMs), step: candidate.step };
      if (!read.ok) {
        results.push({ ...label, outcome: read.outcome, detail: read.detail });
        continue;
      }
      steps.push({
        run_at: label.runAt,
        step_hours: candidate.step,
        valid_at: isoFromEpochMs(candidate.runAtMs + candidate.step * HOUR_MS),
        cloud_pct: read.cloudPct,
      });
      availableAtMs = Math.max(availableAtMs, candidate.sidecar.availableAtMs);
      results.push({ ...label, outcome: 'derived', detail: null });
    }
  } catch (error: unknown) {
    return { outcome: 'read_failed', runAt, steps: results, error: describeError(error) };
  }

  if (!steps.some((step) => step.run_at === runAt)) {
    return { outcome: 'no_steps', runAt, steps: results, error: null };
  }
  steps.sort((a, b) => epochMsFromIso(a.valid_at) - epochMsFromIso(b.valid_at));

  const document: CloudDocument = {
    schema_version: CLOUD_DOCUMENT_SCHEMA_VERSION,
    provider: 'ecmwf-open-data',
    model: 'ifs',
    kind: 'forecast',
    param: 'tcc',
    available_at: isoFromEpochMs(availableAtMs),
    grid,
    steps,
    cloud_cover_version: config.version,
    cloud_cover_digest: config.digest,
  };
  try {
    const written = await deps.payloads.writeText(
      CLOUD_CURRENT_PATH,
      `${canonicalJson(document)}\n`,
    );
    await deps.payloads.writeText(
      CLOUD_CURRENT_META_PATH,
      `${canonicalJson({
        sha256: written.sha256,
        bytes: written.bytes,
        run_at: runAt,
        available_at: document.available_at,
        inputs_digest: inputsDigest,
        cloud_cover_version: config.version,
      })}\n`,
    );
  } catch (error: unknown) {
    return { outcome: 'write_failed', runAt, steps: results, error: describeError(error) };
  }
  return { outcome: 'written', runAt, steps: results, error: null };
}

function sidecarPath(cycle: ForecastCycleRef, step: number, param: string): string {
  return weatherFieldPath(cycle, step, param).replace(/\.grib2$/, '.meta.json');
}

type StepRead =
  | { readonly ok: true; readonly cloudPct: readonly number[] }
  | { readonly ok: false; readonly outcome: CloudStepOutcome; readonly detail: string };

async function readStep(
  reader: PayloadReader,
  candidate: Candidate,
  param: string,
  grid: WindGrid,
): Promise<StepRead> {
  const label = `${param}@${String(candidate.step)}h`;
  const payload = await reader.readPayload(
    weatherFieldPath(candidate.cycle, candidate.step, param),
  );
  if (payload === null) return { ok: false, outcome: 'missing', detail: `${label} not recorded` };
  if (payload.sha256 !== candidate.sidecar.sha256) {
    return {
      ok: false,
      outcome: 'integrity_mismatch',
      detail: `${label} bytes do not match the recorded sha256`,
    };
  }
  const decoded = decodeGrib2(payload.bytes);
  if (!decoded.ok) {
    return {
      ok: false,
      outcome: 'refused',
      detail: `${label}: ${decoded.reason} (${decoded.detail})`,
    };
  }
  const identity: [string, unknown, unknown][] = [
    ['discipline', decoded.discipline, 0],
    ['parameter category', decoded.parameterCategory, 6],
    ['parameter number', decoded.parameterNumber, 192],
    ['surface type', decoded.surfaceType, 1],
    ['reference time', decoded.referenceTimeMs, candidate.runAtMs],
    ['forecast hours', decoded.forecastHours, candidate.step],
  ];
  for (const [name, actual, expected] of identity) {
    if (actual !== expected) {
      return {
        ok: false,
        outcome: 'identity_mismatch',
        detail: `${label} ${name} is ${String(actual)}, expected ${String(expected)}`,
      };
    }
  }
  const sampled = sampleGrid(grid, decoded);
  return sampled === null
    ? {
        ok: false,
        outcome: 'out_of_range',
        detail: `${label} does not cover the grid with fractions in [0, 1]`,
      }
    : { ok: true, cloudPct: sampled };
}

/**
 * The 8-bit packing's reconstruction can land a hair outside [0, 1] (the reference value
 * is a float32); anything further out is not a fraction and refuses the step.
 */
const FRACTION_TOLERANCE = 1e-6;

function sampleGrid(grid: WindGrid, field: Grib2Field): number[] | null {
  const out: number[] = [];
  for (let row = 0; row < grid.rows; row += 1) {
    const lat = grid.north - row * grid.resolution_deg;
    for (let col = 0; col < grid.cols; col += 1) {
      const value = valueNear(field, lat, grid.west + col * grid.resolution_deg);
      if (value === null || !Number.isFinite(value)) return null;
      if (value < -FRACTION_TOLERANCE || value > 1 + FRACTION_TOLERANCE) return null;
      out.push(Math.min(100, Math.max(0, Math.round(value * 100))));
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------
// The read side: the value at one cell and instant.

export interface CloudAt {
  /** Whole percent, 0–100. */
  readonly pct: number;
  /** The run(s) the value came from — two when the bracket spans a run change. */
  readonly runs: readonly string[];
}

/**
 * The forecast cloud cover at a pass-cell centre and instant: exact when `timeMs` is a
 * step's valid time, otherwise linear in time between the two steps that bracket it —
 * and `null` when there is no bracket, when the bracket is wider than
 * `maxBracketHours`, or when the point is not a cell centre of the grid.
 */
export function cloudAt(
  document: CloudDocument,
  point: { readonly lat: number; readonly lon: number },
  timeMs: EpochMs,
  values: CloudCoverValues = CLOUD_COVER.values,
): CloudAt | null {
  const { grid } = document;
  const col = Math.round((point.lon - grid.west) / grid.resolution_deg);
  const row = Math.round((grid.north - point.lat) / grid.resolution_deg);
  if (col < 0 || col >= grid.cols || row < 0 || row >= grid.rows) return null;
  if (Math.abs(grid.west + col * grid.resolution_deg - point.lon) > 1e-6) return null;
  if (Math.abs(grid.north - row * grid.resolution_deg - point.lat) > 1e-6) return null;
  const index = row * grid.cols + col;

  let before: CloudStep | null = null;
  let after: CloudStep | null = null;
  for (const step of document.steps) {
    const at = epochMsFromIso(step.valid_at);
    if (at <= timeMs) before = step;
    if (at >= timeMs && after === null) after = step;
  }
  if (before === null || after === null) return null;
  const beforeValue = before.cloud_pct[index];
  const afterValue = after.cloud_pct[index];
  if (beforeValue === undefined || afterValue === undefined) return null;
  const t0 = epochMsFromIso(before.valid_at);
  const t1 = epochMsFromIso(after.valid_at);
  if (t1 === t0) return { pct: beforeValue, runs: [before.run_at] };
  if (t1 - t0 > values.maxBracketHours * HOUR_MS) return null;
  const pct = Math.round(beforeValue + ((afterValue - beforeValue) * (timeMs - t0)) / (t1 - t0));
  const runs = before.run_at === after.run_at ? [before.run_at] : [before.run_at, after.run_at];
  return { pct, runs };
}

/**
 * Parse a stored document, checking every member the passes route relies on — including
 * that each step's array is exactly `rows × cols` whole percentages, so a truncated array
 * can never answer for the wrong cell. `null` for anything else.
 */
export function parseCloudDocument(text: string): CloudDocument | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(value)) return null;
  if (value['schema_version'] !== CLOUD_DOCUMENT_SCHEMA_VERSION) return null;
  if (value['provider'] !== 'ecmwf-open-data' || value['model'] !== 'ifs') return null;
  if (value['kind'] !== 'forecast' || value['param'] !== 'tcc') return null;
  for (const key of ['available_at', 'cloud_cover_version', 'cloud_cover_digest']) {
    if (typeof value[key] !== 'string') return null;
  }
  if (!isIso(value['available_at'])) return null;
  const grid = value['grid'];
  if (!isRecord(grid) || grid['order'] !== 'north_to_south_west_to_east') return null;
  for (const key of ['west', 'south', 'east', 'north', 'resolution_deg', 'cols', 'rows']) {
    if (typeof grid[key] !== 'number' || !Number.isFinite(grid[key])) return null;
  }
  if ((grid['resolution_deg'] as number) <= 0) return null;
  const cells = (grid['cols'] as number) * (grid['rows'] as number);
  if (!Number.isInteger(cells) || cells <= 0) return null;
  const steps = value['steps'];
  if (!Array.isArray(steps)) return null;
  let previous = -Infinity;
  for (const step of steps as unknown[]) {
    if (!isRecord(step)) return null;
    if (typeof step['step_hours'] !== 'number') return null;
    if (!isIso(step['valid_at']) || !isIso(step['run_at'])) return null;
    const at = epochMsFromIso(step['valid_at'] as string);
    if (at <= previous) return null;
    previous = at;
    const pct = step['cloud_pct'];
    if (!Array.isArray(pct) || pct.length !== cells) return null;
    if (!pct.every((item) => Number.isInteger(item) && item >= 0 && item <= 100)) return null;
  }
  return value as unknown as CloudDocument;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isIso(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  try {
    epochMsFromIso(value);
    return true;
  } catch {
    return false;
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
