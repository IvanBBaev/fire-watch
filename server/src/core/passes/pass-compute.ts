/**
 * When a satellite rises over, culminates above and sets below one ground point (TASKS F15).
 *
 * Pure: SGP4 elements, a point, a window in → a list of passes out. SGP4 itself is
 * `satellite.js` (MIT), the reference implementation's JavaScript port; this file only
 * finds the events on its output.
 *
 * ## Display only — never a decision input
 *
 * The product's decision paths (lifecycle, scoring, alerts) avoid platform trigonometry so a
 * replay reproduces bit-for-bit. This module uses `Math.sin`/`Math.cos` freely (through
 * SGP4 and the transforms) because what it produces is **only shown to a reader**: "the
 * satellites last looked here at…, and will next look at…". Nothing downstream branches
 * on it, and lifecycle keeps using `pass_table_v0` (`static-pass-predictor.ts`), which this
 * module deliberately does not replace. A last-digit difference between platforms can move
 * an AOS by a millisecond, which the whole-second rounding below absorbs.
 *
 * ## Method
 *
 * Elevation above the point's horizon is sampled every {@link SCAN_STEP_MS}; each sign change
 * is bisected to {@link EDGE_TOLERANCE_MS} (AOS on the way up, LOS on the way down), and the
 * culmination between them is found by golden-section search (elevation is unimodal within
 * one pass). A 30 s step can step over a grazing pass that stays up for less than 30 s; such
 * a pass tops out below ~1° and its ground track lies ~3 000 km away, beyond every swath this
 * product models, so a look it could have been is never lost.
 *
 * A pass belongs to the window when its **culmination** does; passes are scanned with a
 * {@link SCAN_MARGIN_MS} margin so one straddling an edge is found whole, and one that is
 * already up at the margin (so its AOS is unknowable here) is skipped rather than guessed.
 * The sample grid is aligned to the epoch, so a pass is reported identically by every
 * window that contains it.
 *
 * "In the swath" compares the great-circle distance from the point to the sub-satellite
 * point at culmination (the closest approach of the ground track, to within the few km the
 * track moves across a second) with half the platform's across-track swath. Day or night is
 * the Sun's elevation at the point at culmination: above the horizon is day.
 */

import {
  eciToEcf,
  eciToGeodetic,
  ecfToLookAngles,
  gstime,
  jday,
  propagate,
  sunPos,
  type GeodeticLocation,
  type SatRec,
} from 'satellite.js';

import type { EpochMs } from '../ports/clock.js';

export const SCAN_STEP_MS = 30_000;
export const EDGE_TOLERANCE_MS = 500;
export const SCAN_MARGIN_MS = 20 * 60_000;
/** IUGG mean Earth radius; the distance is shown in whole km, so the ellipsoid adds nothing. */
const EARTH_RADIUS_KM = 6371.0088;
/** IAU 2012 astronomical unit, for scaling `sunPos` (AU) into the km the transforms take. */
const AU_KM = 149_597_870.7;
const DEG = Math.PI / 180;
const GOLDEN = (Math.sqrt(5) - 1) / 2;

export interface GroundPoint {
  readonly lat: number;
  readonly lon: number;
}

export type Daylight = 'day' | 'night';

export interface ComputedPass {
  readonly aosMs: EpochMs;
  readonly culminationMs: EpochMs;
  readonly losMs: EpochMs;
  readonly maxElevationDeg: number;
  /** Distance from the point to the sub-satellite point at culmination, km. */
  readonly crossTrackKm: number;
  readonly inSwath: boolean;
  readonly daylight: Daylight;
}

export interface PassWindow {
  readonly fromMs: EpochMs;
  readonly toMs: EpochMs;
}

function observerOf(point: GroundPoint): GeodeticLocation {
  return { latitude: point.lat * DEG, longitude: point.lon * DEG, height: 0 };
}

/** Elevation (radians) of the satellite at `ms`, or null when SGP4 cannot place it. */
function elevationAt(satrec: SatRec, observer: GeodeticLocation, ms: number): number | null {
  const date = new Date(ms);
  const state = propagate(satrec, date);
  if (state === null) return null;
  const ecf = eciToEcf(state.position, gstime(date));
  return ecfToLookAngles(observer, ecf).elevation;
}

function subSatellitePoint(satrec: SatRec, ms: number): GroundPoint | null {
  const date = new Date(ms);
  const state = propagate(satrec, date);
  if (state === null) return null;
  const geo = eciToGeodetic(state.position, gstime(date));
  return { lat: geo.latitude / DEG, lon: geo.longitude / DEG };
}

export function greatCircleKm(a: GroundPoint, b: GroundPoint): number {
  const dLat = (b.lat - a.lat) * DEG;
  const dLon = (b.lon - a.lon) * DEG;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a.lat * DEG) * Math.cos(b.lat * DEG) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** The Sun's elevation (degrees) above the point's horizon at `ms`. */
export function sunElevationDeg(point: GroundPoint, ms: number): number {
  const date = new Date(ms);
  const rsun = sunPos(jday(date)).rsun;
  const eciKm = { x: rsun.x * AU_KM, y: rsun.y * AU_KM, z: rsun.z * AU_KM };
  const ecf = eciToEcf(eciKm, gstime(date));
  return ecfToLookAngles(observerOf(point), ecf).elevation / DEG;
}

/** Bisect a sign change of `f` in [lo, hi] (f(lo) and f(hi) on opposite sides of zero). */
function bisect(f: (ms: number) => number, lo: number, hi: number): number {
  let a = lo;
  let b = hi;
  const rising = f(a) <= 0;
  while (b - a > EDGE_TOLERANCE_MS) {
    const mid = (a + b) / 2;
    const above = f(mid) > 0;
    if (above === rising) b = mid;
    else a = mid;
  }
  return (a + b) / 2;
}

function goldenMax(f: (ms: number) => number, lo: number, hi: number): number {
  let a = lo;
  let b = hi;
  let c = b - GOLDEN * (b - a);
  let d = a + GOLDEN * (b - a);
  let fc = f(c);
  let fd = f(d);
  while (b - a > EDGE_TOLERANCE_MS) {
    if (fc > fd) {
      b = d;
      d = c;
      fd = fc;
      c = b - GOLDEN * (b - a);
      fc = f(c);
    } else {
      a = c;
      c = d;
      fc = fd;
      d = a + GOLDEN * (b - a);
      fd = f(d);
    }
  }
  return (a + b) / 2;
}

const wholeSecond = (ms: number): EpochMs => Math.round(ms / 1000) * 1000;

/**
 * Every pass of `satrec` over `point` whose culmination falls in `[fromMs, toMs)`, in time
 * order. `swathKm` is the platform's full across-track swath.
 */
export function computePasses(
  satrec: SatRec,
  point: GroundPoint,
  window: PassWindow,
  swathKm: number,
): readonly ComputedPass[] {
  const observer = observerOf(point);
  // SGP4 failure mid-window (decay, bad elements) reads as "below the horizon": no pass is
  // invented from a position the propagator could not produce.
  const elevation = (ms: number): number => elevationAt(satrec, observer, ms) ?? -Math.PI / 2;
  // The sample grid is anchored to the epoch, not to the window: two windows that share a
  // pass then bisect it over the same brackets and report the same second, so a reader's
  // "next look" does not jitter by a second each time the window slides.
  const start = Math.floor((window.fromMs - SCAN_MARGIN_MS) / SCAN_STEP_MS) * SCAN_STEP_MS;
  const end = window.toMs + SCAN_MARGIN_MS;
  const passes: ComputedPass[] = [];

  let prevMs = start;
  let prevEl = elevation(prevMs);
  let aosMs: number | null = null;
  for (let ms = start + SCAN_STEP_MS; ms <= end; ms += SCAN_STEP_MS) {
    const el = elevation(ms);
    if (prevEl <= 0 && el > 0) {
      aosMs = bisect(elevation, prevMs, ms);
    } else if (prevEl > 0 && el <= 0 && aosMs !== null) {
      const losMs = bisect(elevation, prevMs, ms);
      const culminationMs = goldenMax(elevation, aosMs, losMs);
      if (culminationMs >= window.fromMs && culminationMs < window.toMs) {
        const pass = describePass(satrec, point, aosMs, culminationMs, losMs, elevation, swathKm);
        if (pass !== null) passes.push(pass);
      }
      aosMs = null;
    }
    prevMs = ms;
    prevEl = el;
  }
  return passes;
}

function describePass(
  satrec: SatRec,
  point: GroundPoint,
  aosMs: number,
  culminationMs: number,
  losMs: number,
  elevation: (ms: number) => number,
  swathKm: number,
): ComputedPass | null {
  const sub = subSatellitePoint(satrec, culminationMs);
  if (sub === null) return null;
  const crossTrackKm = greatCircleKm(point, sub);
  return {
    aosMs: wholeSecond(aosMs),
    culminationMs: wholeSecond(culminationMs),
    losMs: wholeSecond(losMs),
    maxElevationDeg: Math.round((elevation(culminationMs) / DEG) * 10) / 10,
    crossTrackKm: Math.round(crossTrackKm),
    inSwath: crossTrackKm <= swathKm / 2,
    daylight: sunElevationDeg(point, culminationMs) > 0 ? 'day' : 'night',
  };
}
