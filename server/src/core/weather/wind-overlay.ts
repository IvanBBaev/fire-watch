/**
 * The F14 wind context layer, core half: cut a small 10 m wind grid out of the ECMWF
 * fields the weather refresh recorded, and pick the step a reader should see (TASKS F14;
 * A19; DATA-SOURCES §D2).
 *
 * **Derived in the worker, served as a file.** The weather refresh already records the
 * `10u`/`10v` GRIB2 messages for every step of the latest run. Decoding two 0.25° global
 * fields is ~150 ms of CPU — cheap for an hourly job, wrong for a request path — so the
 * worker derives once per new run and writes `weather/wind/current.json`, and the read
 * route serves what the job judged, exactly as the EFFIS proxy does. A cycle whose
 * fields are not all there yet (or were refused) leaves the previous document in place:
 * serve-stale with honest times in the body beats a gap, and the route's step-distance
 * bound (`wind_overlay_v1.maxStepDistanceHours`) stops "stale" becoming "wrong".
 *
 * **Nothing is guessed.** Every input field is checked twice before a value is used:
 *
 *   * its bytes must hash to the `sha256` its provenance sidecar recorded (a file damaged
 *     on disk is refused, not decoded), and
 *   * the decoded message must *say* it is what the path claims — discipline 0, category
 *     2, number 2 (u) or 3 (v), 10 m above ground, the recorded run as its reference time
 *     and the recorded step as its forecast time. A mislabelled file would otherwise draw
 *     the wrong hour's wind with a confident time label on it.
 *
 * A step with either component missing or refused is left out; the others still ship.
 *
 * **The grid.** Points at `resolutionDeg` from the bbox's north-west corner, rows north to
 * south and columns west to east — the order a reader's eye and the GRIB scan both use.
 * Each point is the nearest IFS grid point (exact at 0.5°: see `wind_overlay_v1`), never an
 * interpolation. Speed is `hypot(u, v)` in m/s to 0.1; direction is where the wind blows
 * *from*, in whole degrees clockwise from north — the meteorological convention, and the
 * one the legend states. The arrow the web draws points downwind (`from + 180°`).
 */

import { canonicalJson } from '../determinism/canonical-json.js';
import { WIND_OVERLAY, type WindOverlayValues } from '../config/wind-overlay.js';
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
import {
  runWeatherRefresh,
  weatherFieldPath,
  type WeatherRefreshDeps,
  type WeatherRefreshReport,
} from './weather-refresh.js';

/** Bumped when the stored document's shape changes incompatibly. */
export const WIND_DOCUMENT_SCHEMA_VERSION = 1;

export const WIND_CURRENT_PATH = 'weather/wind/current.json';
export const WIND_CURRENT_META_PATH = 'weather/wind/current.meta.json';

const HOUR_MS = 3_600_000;

export interface WindGrid {
  readonly west: number;
  readonly south: number;
  readonly east: number;
  readonly north: number;
  readonly resolution_deg: number;
  readonly cols: number;
  readonly rows: number;
  /** Row-major, starting at the north-west corner. */
  readonly order: 'north_to_south_west_to_east';
}

export interface WindStep {
  readonly step_hours: number;
  readonly valid_at: string;
  /** `rows × cols` values, m/s to 0.1. */
  readonly speed_ms: readonly number[];
  /** `rows × cols` values, whole degrees 0–359, direction the wind blows *from*. */
  readonly direction_from_deg: readonly number[];
}

/** What the worker writes to {@link WIND_CURRENT_PATH}. */
export interface WindDocument {
  readonly schema_version: number;
  readonly provider: 'ecmwf-open-data';
  readonly model: 'ifs';
  readonly run_at: string;
  /** The latest `available_at` among the input fields — when the data could be known. */
  readonly available_at: string;
  readonly grid: WindGrid;
  readonly steps: readonly WindStep[];
  readonly wind_overlay_version: string;
  readonly wind_overlay_digest: string;
  readonly weather_context_version: string;
}

export interface WindDerivationDeps {
  readonly reader: PayloadReader;
  readonly payloads: PayloadStore;
  readonly overlayConfig?: VersionedConfig<WindOverlayValues>;
}

export type WindStepOutcome =
  | 'derived'
  /** A component or its sidecar is not on disk (yet). */
  | 'missing'
  /** The bytes do not hash to what the sidecar recorded. */
  | 'integrity_mismatch'
  /** The GRIB2 decoder refused the message (typed reason in `detail`). */
  | 'refused'
  /** The message decoded but is not the field, run or step its path claims. */
  | 'identity_mismatch'
  /** The IFS grid does not cover a point of the wind grid. */
  | 'outside_grid';

export interface WindStepResult {
  readonly step: number;
  readonly outcome: WindStepOutcome;
  readonly detail: string | null;
}

export type WindDerivationOutcome =
  | 'written'
  /** Same inputs as the stored document — nothing rewritten. */
  | 'unchanged'
  /** No step of this run was usable; the previous document (if any) stays. */
  | 'no_steps'
  | 'read_failed'
  | 'write_failed';

export interface WindDerivationResult {
  readonly outcome: WindDerivationOutcome;
  readonly runAt: string;
  readonly steps: readonly WindStepResult[];
  readonly error: string | null;
}

interface Component {
  readonly field: Grib2Field;
  readonly sha256: string;
  readonly availableAtMs: EpochMs;
}

type ComponentRead =
  | { readonly ok: true; readonly component: Component }
  | { readonly ok: false; readonly outcome: WindStepOutcome; readonly detail: string };

export interface WeatherAndWindReport extends WeatherRefreshReport {
  readonly wind: WindDerivationResult;
}

/**
 * The worker's hourly weather job: the refresh, then the wind derivation for the run it
 * just recorded. Composed here rather than inside `runWeatherRefresh` so the refresh
 * stays a pure recorder and its feed row (`weather:context`) never depends on a derived
 * product; a wind failure shows up in the job's log line, not as a weather outage.
 */
export async function runWeatherRefreshWithWind(
  refresh: WeatherRefreshDeps,
  wind: WindDerivationDeps,
): Promise<WeatherAndWindReport> {
  const report = await runWeatherRefresh(refresh);
  const context = refresh.contextConfig ?? WEATHER_CONTEXT;
  return { ...report, wind: await deriveWindOverlay(report.cycle, wind, context) };
}

/** The run the refresh records at `now` — derivation always follows the refresh. */
export function windCycleAt(
  now: EpochMs,
  context: VersionedConfig<WeatherContextValues> = WEATHER_CONTEXT,
): ForecastCycleRef {
  return latestPublishedCycle(now, context.values);
}

export function cycleEpochMs(cycle: ForecastCycleRef): EpochMs {
  const y = Number(cycle.dateYmd.slice(0, 4));
  const m = Number(cycle.dateYmd.slice(4, 6));
  const d = Number(cycle.dateYmd.slice(6, 8));
  return Date.UTC(y, m - 1, d, cycle.hour);
}

/** The wind grid's geometry for a config — shared by the derivation and its tests. */
export function windGrid(values: WindOverlayValues): WindGrid {
  const { bbox, resolutionDeg: res } = values;
  const cols = Math.round((bbox.east - bbox.west) / res) + 1;
  const rows = Math.round((bbox.north - bbox.south) / res) + 1;
  return {
    west: bbox.west,
    south: bbox.south,
    east: bbox.west + (cols - 1) * res,
    north: bbox.north,
    resolution_deg: res,
    cols,
    rows,
    order: 'north_to_south_west_to_east',
  };
}

/** Meteorological direction the wind blows from, whole degrees 0–359. */
export function directionFromDeg(u: number, v: number): number {
  const deg = (Math.atan2(-u, -v) * 180) / Math.PI;
  return Math.round((deg + 360) % 360) % 360;
}

export function speedMs(u: number, v: number): number {
  return Math.round(Math.hypot(u, v) * 10) / 10;
}

/**
 * Derive the wind document for `cycle` and store it, unless its inputs are the ones the
 * stored document was already built from. Never throws for bad data; store failures are
 * reported as outcomes.
 */
export async function deriveWindOverlay(
  cycle: ForecastCycleRef,
  deps: WindDerivationDeps,
  context: VersionedConfig<WeatherContextValues> = WEATHER_CONTEXT,
): Promise<WindDerivationResult> {
  const overlay = deps.overlayConfig ?? WIND_OVERLAY;
  const runAtMs = cycleEpochMs(cycle);
  const runAt = isoFromEpochMs(runAtMs);
  const grid = windGrid(overlay.values);

  const results: WindStepResult[] = [];
  const steps: WindStep[] = [];
  const inputs: { step: number; param: string; sha256: string }[] = [];
  let availableAtMs = 0;

  try {
    for (const step of context.values.steps) {
      const u = await readComponent(deps.reader, cycle, runAtMs, step, '10u', 2);
      const v = u.ok ? await readComponent(deps.reader, cycle, runAtMs, step, '10v', 3) : u;
      if (!u.ok || !v.ok) {
        const failed = !u.ok ? u : (v as Extract<ComponentRead, { ok: false }>);
        results.push({ step, outcome: failed.outcome, detail: failed.detail });
        continue;
      }
      const sampled = sampleStep(grid, u.component.field, v.component.field);
      if (sampled === null) {
        results.push({
          step,
          outcome: 'outside_grid',
          detail: 'the IFS field does not cover the wind grid',
        });
        continue;
      }
      steps.push({
        step_hours: step,
        valid_at: isoFromEpochMs(runAtMs + step * HOUR_MS),
        ...sampled,
      });
      inputs.push(
        { step, param: '10u', sha256: u.component.sha256 },
        { step, param: '10v', sha256: v.component.sha256 },
      );
      availableAtMs = Math.max(availableAtMs, u.component.availableAtMs, v.component.availableAtMs);
      results.push({ step, outcome: 'derived', detail: null });
    }
  } catch (error: unknown) {
    return { outcome: 'read_failed', runAt, steps: results, error: describeError(error) };
  }

  if (steps.length === 0) return { outcome: 'no_steps', runAt, steps: results, error: null };

  // FNV over the inputs and the parameters: change detection, not a security claim.
  const inputsDigest = configDigest({
    run_at: runAt,
    inputs,
    wind_overlay_digest: overlay.digest,
    schema_version: WIND_DOCUMENT_SCHEMA_VERSION,
  });
  try {
    const stored = await deps.reader.readText(WIND_CURRENT_META_PATH);
    if (stored !== null && storedInputsDigest(stored) === inputsDigest) {
      return { outcome: 'unchanged', runAt, steps: results, error: null };
    }
  } catch {
    // An unreadable sidecar is not a reason to keep an old document: rewrite.
  }

  const document: WindDocument = {
    schema_version: WIND_DOCUMENT_SCHEMA_VERSION,
    provider: 'ecmwf-open-data',
    model: 'ifs',
    run_at: runAt,
    available_at: isoFromEpochMs(availableAtMs),
    grid,
    steps,
    wind_overlay_version: overlay.version,
    wind_overlay_digest: overlay.digest,
    weather_context_version: context.version,
  };
  try {
    const written = await deps.payloads.writeText(
      WIND_CURRENT_PATH,
      `${canonicalJson(document)}\n`,
    );
    await deps.payloads.writeText(
      WIND_CURRENT_META_PATH,
      `${canonicalJson({
        sha256: written.sha256,
        bytes: written.bytes,
        run_at: runAt,
        available_at: document.available_at,
        inputs_digest: inputsDigest,
        inputs,
        wind_overlay_version: overlay.version,
      })}\n`,
    );
  } catch (error: unknown) {
    return { outcome: 'write_failed', runAt, steps: results, error: describeError(error) };
  }
  return { outcome: 'written', runAt, steps: results, error: null };
}

async function readComponent(
  reader: PayloadReader,
  cycle: ForecastCycleRef,
  runAtMs: EpochMs,
  step: number,
  param: '10u' | '10v',
  parameterNumber: number,
): Promise<ComponentRead> {
  const path = weatherFieldPath(cycle, step, param);
  const sidecarText = await reader.readText(path.replace(/\.grib2$/, '.meta.json'));
  const payload = await reader.readPayload(path);
  if (sidecarText === null || payload === null) {
    return { ok: false, outcome: 'missing', detail: `${param}@${String(step)}h not recorded` };
  }
  const sidecar = parseFieldSidecar(sidecarText);
  if (sidecar === null) {
    return {
      ok: false,
      outcome: 'integrity_mismatch',
      detail: `${param}@${String(step)}h sidecar is unreadable`,
    };
  }
  if (sidecar.sha256 !== payload.sha256) {
    return {
      ok: false,
      outcome: 'integrity_mismatch',
      detail: `${param}@${String(step)}h bytes do not match the recorded sha256`,
    };
  }
  const decoded = decodeGrib2(payload.bytes);
  if (!decoded.ok) {
    return {
      ok: false,
      outcome: 'refused',
      detail: `${param}@${String(step)}h: ${decoded.reason} (${decoded.detail})`,
    };
  }
  const identity: [string, unknown, unknown][] = [
    ['discipline', decoded.discipline, 0],
    ['parameter category', decoded.parameterCategory, 2],
    ['parameter number', decoded.parameterNumber, parameterNumber],
    ['surface type', decoded.surfaceType, 103],
    ['surface value', decoded.surfaceValue, 10],
    ['reference time', decoded.referenceTimeMs, runAtMs],
    ['forecast hours', decoded.forecastHours, step],
  ];
  for (const [name, actual, expected] of identity) {
    if (actual !== expected) {
      return {
        ok: false,
        outcome: 'identity_mismatch',
        detail: `${param}@${String(step)}h ${name} is ${String(actual)}, expected ${String(expected)}`,
      };
    }
  }
  return {
    ok: true,
    component: { field: decoded, sha256: payload.sha256, availableAtMs: sidecar.availableAtMs },
  };
}

function sampleStep(
  grid: WindGrid,
  u: Grib2Field,
  v: Grib2Field,
): Pick<WindStep, 'speed_ms' | 'direction_from_deg'> | null {
  const speed: number[] = [];
  const direction: number[] = [];
  for (let row = 0; row < grid.rows; row += 1) {
    const lat = grid.north - row * grid.resolution_deg;
    for (let col = 0; col < grid.cols; col += 1) {
      const lon = grid.west + col * grid.resolution_deg;
      const uValue = valueNear(u, lat, lon);
      const vValue = valueNear(v, lat, lon);
      if (uValue === null || vValue === null) return null;
      speed.push(speedMs(uValue, vValue));
      direction.push(directionFromDeg(uValue, vValue));
    }
  }
  return { speed_ms: speed, direction_from_deg: direction };
}

export function parseFieldSidecar(text: string): { sha256: string; availableAtMs: EpochMs } | null {
  try {
    const value = JSON.parse(text) as unknown;
    if (typeof value !== 'object' || value === null) return null;
    const record = value as Record<string, unknown>;
    const sha256 = record['sha256'];
    const availableAt = record['available_at'];
    if (typeof sha256 !== 'string' || typeof availableAt !== 'string') return null;
    return { sha256, availableAtMs: epochMsFromIso(availableAt) };
  } catch {
    return null;
  }
}

export function storedInputsDigest(text: string): string | null {
  try {
    const value = JSON.parse(text) as unknown;
    if (typeof value !== 'object' || value === null) return null;
    const digest = (value as Record<string, unknown>)['inputs_digest'];
    return typeof digest === 'string' ? digest : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------------------
// The read side: what the route serves from a stored document.

/** The body of `GET /overlays/wind/latest.json` — one step of the stored document. */
export interface WindOverlayBody {
  readonly schema_version: number;
  readonly provider: 'ecmwf-open-data';
  readonly model: 'ifs';
  readonly run_at: string;
  readonly step_hours: number;
  readonly valid_at: string;
  readonly available_at: string;
  readonly grid: WindGrid;
  readonly speed_ms: readonly number[];
  readonly direction_from_deg: readonly number[];
  readonly wind_overlay_version: string;
}

export type WindSelection =
  | { readonly ok: true; readonly body: WindOverlayBody }
  | { readonly ok: false; readonly reason: 'no_steps' | 'stale'; readonly detail: string };

/**
 * The step whose valid time is nearest `now` (ties to the earlier step: the arrows that
 * have already happened, not the ones that might), or `stale` when even that one is more
 * than `maxStepDistanceHours` away.
 */
export function selectWindStep(
  document: WindDocument,
  now: EpochMs,
  values: WindOverlayValues = WIND_OVERLAY.values,
): WindSelection {
  let best: WindStep | null = null;
  let bestDistance = Infinity;
  for (const step of document.steps) {
    const distance = Math.abs(epochMsFromIso(step.valid_at) - now);
    if (distance < bestDistance) {
      best = step;
      bestDistance = distance;
    }
  }
  if (best === null) return { ok: false, reason: 'no_steps', detail: 'no step is recorded' };
  if (bestDistance > values.maxStepDistanceHours * HOUR_MS) {
    return {
      ok: false,
      reason: 'stale',
      detail: `the nearest recorded step is valid at ${best.valid_at}`,
    };
  }
  return {
    ok: true,
    body: {
      schema_version: document.schema_version,
      provider: document.provider,
      model: document.model,
      run_at: document.run_at,
      step_hours: best.step_hours,
      valid_at: best.valid_at,
      available_at: document.available_at,
      grid: document.grid,
      speed_ms: best.speed_ms,
      direction_from_deg: best.direction_from_deg,
      wind_overlay_version: document.wind_overlay_version,
    },
  };
}

/**
 * Parse a stored document, checking every member the route relies on — including that
 * each step's arrays are exactly `rows × cols` long, so a truncated array can never be
 * drawn with arrows shifted into the wrong cells. `null` for anything else.
 */
export function parseWindDocument(text: string): WindDocument | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(value)) return null;
  if (value['schema_version'] !== WIND_DOCUMENT_SCHEMA_VERSION) return null;
  if (value['provider'] !== 'ecmwf-open-data' || value['model'] !== 'ifs') return null;
  for (const key of ['run_at', 'available_at', 'wind_overlay_version', 'wind_overlay_digest']) {
    if (typeof value[key] !== 'string') return null;
  }
  if (typeof value['weather_context_version'] !== 'string') return null;
  if (!isIso(value['run_at']) || !isIso(value['available_at'])) return null;
  const grid = value['grid'];
  if (!isRecord(grid) || grid['order'] !== 'north_to_south_west_to_east') return null;
  for (const key of ['west', 'south', 'east', 'north', 'resolution_deg', 'cols', 'rows']) {
    if (typeof grid[key] !== 'number' || !Number.isFinite(grid[key])) return null;
  }
  const cells = (grid['cols'] as number) * (grid['rows'] as number);
  if (!Number.isInteger(cells) || cells <= 0) return null;
  const steps = value['steps'];
  if (!Array.isArray(steps)) return null;
  for (const step of steps as unknown[]) {
    if (!isRecord(step)) return null;
    if (typeof step['step_hours'] !== 'number' || !isIso(step['valid_at'])) return null;
    if (!isNumberArray(step['speed_ms'], cells)) return null;
    if (!isNumberArray(step['direction_from_deg'], cells)) return null;
  }
  return value as unknown as WindDocument;
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

function isNumberArray(value: unknown, length: number): boolean {
  return (
    Array.isArray(value) &&
    value.length === length &&
    value.every((item) => typeof item === 'number' && Number.isFinite(item))
  );
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
