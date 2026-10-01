/**
 * The F17 cloud forecast at each satellite pass, the pure half: what the passes document's
 * `cloud` block and each pass's `cloud_forecast_pct` are, how they are validated, and which
 * of three words a percentage reads as.
 *
 * The number is ECMWF IFS total cloud cover **forecast** for the cell at the pass's
 * culmination (`cloud_cover_v1` on the server: linear in time between the two recorded
 * forecast steps around it). It is never an observation, and the panel never shows it
 * without saying so.
 *
 * Both fields are additive to passes schema 1 (ADR-003 A1.3): a body without them is an
 * older server and reads as "no forecast". A body *with* them must spell them exactly, or
 * the whole document is rejected — a half-understood forecast would be shown as a fact.
 */

export type PassCloudLevel = 'clear' | 'partly' | 'cloudy';

/** The document-level description of what `cloud_forecast_pct` is. */
export interface PassesCloud {
  readonly kind: 'forecast';
  readonly provider: 'ecmwf-open-data';
  readonly model: 'ifs';
  readonly param: 'tcc';
  readonly at: 'culmination';
  readonly method: 'linear_in_time';
  readonly runs: readonly string[];
  readonly available_at: string;
  readonly cloud_cover_version: string;
}

/**
 * The level boundaries, in percent of sky covered. They follow the okta convention
 * (2 oktas ≈ 25 %, 6 oktas = 75 %): up to a quarter of the sky is "mostly clear", three
 * quarters or more is "cloudy". A founder decision (TASKS F17); the percentage is shown
 * next to the word, so the boundary never hides the number.
 */
export const PASS_CLOUD_CLEAR_MAX_PCT = 25;
export const PASS_CLOUD_CLOUDY_MIN_PCT = 75;

export function passCloudLevel(pct: number): PassCloudLevel {
  if (pct <= PASS_CLOUD_CLEAR_MAX_PCT) return 'clear';
  if (pct >= PASS_CLOUD_CLOUDY_MIN_PCT) return 'cloudy';
  return 'partly';
}

// ── Validation ──────────────────────────────────────────────────────────────

const INVALID = Symbol('invalid');
export type Invalid = typeof INVALID;

export function isInvalid<T>(value: T | Invalid): value is Invalid {
  return value === INVALID;
}

const isInstant = (value: unknown): value is string =>
  typeof value === 'string' &&
  /^\d{4}-\d{2}-\d{2}T/u.test(value) &&
  Number.isFinite(Date.parse(value));

/**
 * A pass's `cloud_forecast_pct`: absent or `null` → `null` (no forecast); a whole percent
 * 0–100 → itself; anything else → invalid.
 */
export function parsePassCloudPct(value: unknown): number | null | Invalid {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 100) {
    return INVALID;
  }
  return value;
}

/** The document's `cloud` block: absent or `null` → `null`; exact → itself; else invalid. */
export function parsePassesCloud(value: unknown): PassesCloud | null | Invalid {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) return INVALID;
  const rec = value as Record<string, unknown>;
  if (
    rec['kind'] !== 'forecast' ||
    rec['provider'] !== 'ecmwf-open-data' ||
    rec['model'] !== 'ifs' ||
    rec['param'] !== 'tcc' ||
    rec['at'] !== 'culmination' ||
    rec['method'] !== 'linear_in_time'
  ) {
    return INVALID;
  }
  const { runs, available_at, cloud_cover_version } = rec;
  if (!Array.isArray(runs) || !runs.every(isInstant)) return INVALID;
  if (!isInstant(available_at)) return INVALID;
  if (typeof cloud_cover_version !== 'string' || cloud_cover_version === '') return INVALID;
  return {
    kind: 'forecast',
    provider: 'ecmwf-open-data',
    model: 'ifs',
    param: 'tcc',
    at: 'culmination',
    method: 'linear_in_time',
    runs: [...runs],
    available_at,
    cloud_cover_version,
  };
}

/**
 * Whether the document shows any forecast cloud: a block that names at least one run. A
 * block with no runs answered no pass, so nothing ECMWF-derived is on screen — no caveat
 * and no credit are owed.
 */
export function passesCloudShown(cloud: PassesCloud | null): boolean {
  return cloud !== null && cloud.runs.length > 0;
}
