/**
 * E1-grade validation of a parsed FIRMS row (TASKS C2, A23).
 *
 * The parser (`firms-csv.ts`) answers "is this a row?". This answers "is this a row we
 * asked for, from a provider whose clock and instrument were working?" — a distinction
 * that matters because the two failures need different treatment. A row the parser cannot
 * read is malformed; a row that parses but reports a fire in Poland, or an acquisition
 * timestamped after we received the file, is *well-formed and wrong*, and it is the second
 * kind that silently poisons clustering.
 *
 * Everything here flags. Nothing here clamps, corrects or drops. Review 14 §3 offers
 * "clamp/flag" for the `available_at < acq_ts` case and we take flag every time: a clamped
 * timestamp is a provider value we overwrote with a guess, indistinguishable a year later
 * from a value the provider actually sent. The violation is recorded, the raw bytes are
 * quarantined, and the archive keeps what arrived.
 *
 * The one derived value is the footprint default (M5): `scan`/`track` missing entirely is
 * not a violation — it is the documented nadir case, and `footprintKm` resolves it here so
 * that `max(3, 1.5·√(scan·track))` never meets a null. The *archive* still stores the null.
 */

import { POLLING_BBOX, assertBoundingBox, type BoundingBox } from '../config/polling-bbox.js';
import { epochMsFromIso, type EpochMs } from '../ports/clock.js';
import type { FirmsRow } from './firms-csv.js';

/**
 * The pinned nadir footprint (review 14 M5). A VIIRS or MODIS row with no `scan`/`track`
 * would otherwise put a null — and then a NaN — into the ε formula, and a NaN ε makes
 * every distance comparison false, which is how a fire quietly stops clustering.
 *
 * 1.0 × 2.0 km is the nadir MODIS pixel. It is deliberately the *coarse* choice: an ε that
 * is slightly too large merges two neighbouring detections that might be separate fires,
 * while an ε that is too small splits one fire into two events with two public ids and two
 * alert streams. Of the two failures, only the second is visible to a user as a lie.
 */
export const NADIR_SCAN_KM = 1.0;
export const NADIR_TRACK_KM = 2.0;

/**
 * How far outside the polled box a detection centre may sit before it is a violation, in
 * degrees (~1.1 km). FIRMS filters on the same centre we check, so anything outside is a
 * provider-side filter difference, not a real pixel — but the box travels to NASA as text
 * rounded to 1e-6 and comes back filtered by a different implementation, so an exact-edge
 * comparison would quarantine real fires on the boundary of the box.
 */
export const BBOX_TOLERANCE_DEG = 0.01;

/**
 * How far an acquisition may precede its own delivery in the wrong direction before we
 * call it skew. `acq_ts` is truncated to the minute, so a genuinely simultaneous value can
 * legitimately read up to 60 s ahead; the rest is slack for an upstream clock that is a
 * few minutes off without being broken. NRT lag is minutes to hours *positive* — a row
 * that arrives before it was acquired by more than this is not lag, it is a wrong clock,
 * and the fixed batch ordering `(available_at, source, lat, lon, uid)` is built on the
 * assumption that it never happens.
 */
export const MAX_CLOCK_SKEW_MS = 5 * 60_000;

/**
 * Slack applied when deciding which UTC day the poll window starts on. A response built at
 * 23:59:58 UTC and delivered at 00:00:01 covers the *previous* pair of calendar days; without
 * this, every row in it would be flagged as out of window for the few seconds a day when
 * the poll straddles midnight. An hour of slack costs at most one extra day of leniency
 * during the first hour of each UTC day — irrelevant against the failure this check is for,
 * which is an archive file served in place of the NRT one and is weeks out, not one day.
 */
export const WINDOW_GRACE_MS = 60 * 60_000;

const MS_PER_DAY = 86_400_000;

/**
 * The plausible pixel footprint envelope, in kilometres. VIIRS 375 m stays near 0.375 km
 * across the swath; MODIS grows to roughly 4.8 km at scan edge. Ten is far outside both and
 * exists only to catch a unit change or a shifted column, not to second-guess the provider.
 */
const MAX_FOOTPRINT_KM = 10;

/**
 * Brightness temperature envelope, kelvin. The floor is well below any Earth scene the
 * instrument can report; the ceiling is above the saturation value of every band FIRMS
 * publishes here (VIIRS I4 saturates near 367 K, MODIS band 21 near 500 K). A value
 * outside this is a fill value or a shifted column, never a measurement.
 */
const MIN_BRIGHTNESS_K = 150;
const MAX_BRIGHTNESS_K = 600;

export type ViolationCode =
  | 'outside_polling_bbox'
  | 'acquired_after_available'
  | 'acquired_before_window'
  | 'footprint_out_of_range'
  | 'frp_negative'
  | 'brightness_out_of_envelope';

export interface DetectionViolation {
  readonly code: ViolationCode;
  /** Human-readable, and carrying the offending value — this is what an operator reads. */
  readonly detail: string;
}

export interface ValidationContext {
  /** The instant the batch was in our hands; the reference for both time checks. */
  readonly availableAt: EpochMs;
  /** The box actually queried. A backfill validates against the box it replays under. */
  readonly bbox?: BoundingBox;
  /** The `day_range` actually requested; 2 for every live poll (pitfall 2). */
  readonly dayRange?: number;
}

export interface InvalidDetection<T> {
  readonly detection: T;
  /** Never empty. Every rule is evaluated, so one bad row reports all of its problems. */
  readonly violations: readonly DetectionViolation[];
}

export interface ValidationPartition<T> {
  readonly valid: readonly T[];
  readonly invalid: readonly InvalidDetection<T>[];
}

/**
 * Every rule, against one row. Rules are independent and all of them run: an operator
 * reading a quarantine entry wants the whole diagnosis, and a row that is both outside the
 * box and outside the window is evidence of something different from a row that is only one.
 */
export function validateDetection(
  row: FirmsRow,
  context: ValidationContext,
): readonly DetectionViolation[] {
  const bbox = context.bbox ?? POLLING_BBOX.values;
  assertBoundingBox(bbox);
  const dayRange = context.dayRange ?? 2;
  if (!Number.isInteger(dayRange) || dayRange < 1) {
    throw new RangeError(`day_range must be a positive integer, got ${String(dayRange)}`);
  }
  if (!Number.isFinite(context.availableAt)) {
    throw new RangeError(
      `available_at must be a finite instant, got ${String(context.availableAt)}`,
    );
  }

  const violations: DetectionViolation[] = [];
  const lat = Number(row.latCanonical);
  const lon = Number(row.lonCanonical);

  if (
    lat < bbox.south - BBOX_TOLERANCE_DEG ||
    lat > bbox.north + BBOX_TOLERANCE_DEG ||
    lon < bbox.west - BBOX_TOLERANCE_DEG ||
    lon > bbox.east + BBOX_TOLERANCE_DEG
  ) {
    violations.push({
      code: 'outside_polling_bbox',
      detail:
        `(${row.latCanonical}, ${row.lonCanonical}) lies outside the polled box ` +
        `[${String(bbox.west)}, ${String(bbox.south)}, ${String(bbox.east)}, ${String(bbox.north)}] ` +
        `by more than ${String(BBOX_TOLERANCE_DEG)}°`,
    });
  }

  const acquiredAt = epochMsFromIso(row.acqTsIso);
  if (acquiredAt > context.availableAt + MAX_CLOCK_SKEW_MS) {
    violations.push({
      code: 'acquired_after_available',
      detail:
        `acquired ${row.acqTsIso}, which is ` +
        `${String(Math.round((acquiredAt - context.availableAt) / 1000))} s after the response ` +
        'reached us; the value is flagged, never clamped',
    });
  }

  const windowStart = pollWindowStart(context.availableAt, dayRange);
  if (acquiredAt < windowStart) {
    violations.push({
      code: 'acquired_before_window',
      detail:
        `acquired ${row.acqTsIso}, before the day_range=${String(dayRange)} window that opened ` +
        `at ${new Date(windowStart).toISOString()}`,
    });
  }

  checkFootprint(violations, 'scan', row.scanKm);
  checkFootprint(violations, 'track', row.trackKm);

  // Zero FRP is a reported zero and a legitimate measurement (pitfall 9); negative is not.
  if (row.frpMw !== null && row.frpMw < 0) {
    violations.push({
      code: 'frp_negative',
      detail: `frp is ${String(row.frpMw)} MW; radiative power cannot be negative`,
    });
  }

  checkBrightness(violations, 'brightness', row.brightnessK);
  checkBrightness(violations, 'brightness_secondary', row.brightnessSecondaryK);

  return violations;
}

/**
 * The earliest acquisition a `day_range=N` response may legitimately contain.
 *
 * `day_range` counts whole UTC calendar days ending with the day the response was built,
 * so the window opens at the start of the day `N-1` days before that one — computed from
 * epoch arithmetic rather than a `Date`, because a Unix day is exactly 86 400 000 ms and a
 * local-zone `Date` here is how a fixture starts depending on where CI runs.
 */
export function pollWindowStart(availableAt: EpochMs, dayRange: number): EpochMs {
  const reference = availableAt - WINDOW_GRACE_MS;
  const dayStart = Math.floor(reference / MS_PER_DAY) * MS_PER_DAY;
  return dayStart - (dayRange - 1) * MS_PER_DAY;
}

function checkFootprint(
  violations: DetectionViolation[],
  column: string,
  value: number | null,
): void {
  // `null` is the documented nadir case, resolved by `footprintKm`, not a violation.
  if (value === null) return;
  if (value <= 0 || value > MAX_FOOTPRINT_KM) {
    violations.push({
      code: 'footprint_out_of_range',
      detail:
        `${column} is ${String(value)} km; a pixel footprint must be greater than 0 and at ` +
        `most ${String(MAX_FOOTPRINT_KM)} km`,
    });
  }
}

function checkBrightness(
  violations: DetectionViolation[],
  column: string,
  value: number | null,
): void {
  if (value === null) return;
  if (value < MIN_BRIGHTNESS_K || value > MAX_BRIGHTNESS_K) {
    violations.push({
      code: 'brightness_out_of_envelope',
      detail:
        `${column} is ${String(value)} K, outside the plausible envelope ` +
        `${String(MIN_BRIGHTNESS_K)}–${String(MAX_BRIGHTNESS_K)} K`,
    });
  }
}

/**
 * The footprint ε is computed from, with the nadir default applied (M5).
 *
 * Deliberately separate from the archive: this returns a usable pair for every row, while
 * `detections.scan_km`/`track_km` keep whatever arrived, including nothing. Storing the
 * default would make a fabricated footprint indistinguishable from a measured one the day
 * someone re-derives ε from the archive.
 */
export function footprintKm(row: Pick<FirmsRow, 'scanKm' | 'trackKm'>): {
  readonly scanKm: number;
  readonly trackKm: number;
} {
  return {
    scanKm: row.scanKm ?? NADIR_SCAN_KM,
    trackKm: row.trackKm ?? NADIR_TRACK_KM,
  };
}

/**
 * Splits a batch into what may land and what must be quarantined.
 *
 * Order is preserved on both sides: the batch arrives in the fixed determinism order and
 * a filter that reshuffled it would make the same poll produce two different archives.
 */
export function partitionByValidity<T extends FirmsRow>(
  rows: readonly T[],
  context: ValidationContext,
): ValidationPartition<T> {
  const valid: T[] = [];
  const invalid: InvalidDetection<T>[] = [];

  for (const row of rows) {
    const violations = validateDetection(row, context);
    if (violations.length === 0) {
      valid.push(row);
    } else {
      invalid.push({ detection: row, violations });
    }
  }

  return { valid, invalid };
}

/** `outside_polling_bbox, frp_negative` — the quarantine row's one-line reason. */
export function describeViolations(violations: readonly DetectionViolation[]): string {
  return violations.map((violation) => `${violation.code}: ${violation.detail}`).join('; ');
}
