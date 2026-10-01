/**
 * Where a satellite's swath lies on the ground while it crosses the polled box (TASKS F15,
 * the map half): the sub-satellite ground track and the two swath edges, per pass.
 *
 * Pure: SGP4 elements, a box, a window, a swath width in → a list of pass geometries out.
 * Like `pass-compute.ts` this is **display only** — nothing downstream branches on it — so
 * trigonometry is fine here; the pass table the lifecycle reads is untouched.
 *
 * ## Which samples belong to a pass
 *
 * The sub-satellite point is sampled every {@link SCAN_STEP_MS}, on a grid anchored to the
 * epoch (the same grid `computePasses` uses, so two windows that share a pass draw it from
 * the same samples and the geometry does not shimmer each bucket). A sample **covers** the
 * box when the great-circle distance from the sub-satellite point to the nearest point of
 * the box is at most half the swath — the same "within half the swath of the track" rule
 * `computePasses` applies to one point, applied to the box's nearest point. The nearest
 * point is found by clamping latitude and longitude into the box, which is exact for the
 * meridian edges and within a few km for the parallel edges at this box's size — far below
 * what a 3 000 km swath drawn at country scale can show.
 *
 * A pass is one contiguous run of covering samples. Its geometry keeps one sample either
 * side of the run so the drawn swath reaches past the box edge instead of stopping short of
 * it by up to a step (~200 km of track). A run that touches the scan's first or last sample
 * is dropped rather than drawn half: the scan carries a {@link SCAN_MARGIN_MS} margin, and a
 * box crossing takes minutes, so such a run's `mid` is outside the window anyway.
 *
 * ## The edges
 *
 * Each edge point is the great-circle destination half a swath away from a track sample,
 * at ±90° to the local track bearing. The swath is modelled symmetric about the track, the
 * same simplification `computePasses` makes; SLSTR's real swath is offset westward
 * (nadir view 1 400 km, asymmetric), so its drawn swath is an approximation of which side
 * saw what, and the panel calls the whole layer "predicted".
 *
 * `mid` is the sample nearest the box centre — "when this pass is over the area" — and the
 * label sits on the track there, clamped into the box so a pass whose track runs outside
 * the box is still labelled where a reader looking at the box can see it.
 */

import { eciToGeodetic, gstime, propagate, type SatRec } from 'satellite.js';

import type { BoundingBox } from '../config/polling-bbox.js';
import type { EpochMs } from '../ports/clock.js';
import {
  SCAN_MARGIN_MS,
  SCAN_STEP_MS,
  greatCircleKm,
  type GroundPoint,
  type PassWindow,
} from './pass-compute.js';

/** IUGG mean Earth radius, as `pass-compute.ts` uses. */
const EARTH_RADIUS_KM = 6371.0088;
const DEG = Math.PI / 180;
/** How far inside the box a clamped label is pulled, so it is never drawn on the edge. */
const LABEL_INSET_DEG = 0.2;

export interface SwathPass {
  /** First covering sample. */
  readonly startMs: EpochMs;
  /** The sample nearest the box centre. */
  readonly midMs: EpochMs;
  /** Last covering sample. */
  readonly endMs: EpochMs;
  /** Sub-satellite points, in time order (one sample beyond the run at each end). */
  readonly track: readonly GroundPoint[];
  /** Swath edge to the left of the direction of flight, parallel to `track`. */
  readonly left: readonly GroundPoint[];
  /** Swath edge to the right of the direction of flight, parallel to `track`. */
  readonly right: readonly GroundPoint[];
  /** Where the pass's label goes: on the track at `mid`, clamped into the box. */
  readonly labelAt: GroundPoint;
}

function subSatellitePoint(satrec: SatRec, ms: number): GroundPoint | null {
  const date = new Date(ms);
  const state = propagate(satrec, date);
  if (state === null) return null;
  const geo = eciToGeodetic(state.position, gstime(date));
  return { lat: geo.latitude / DEG, lon: normaliseLon(geo.longitude / DEG) };
}

function normaliseLon(lon: number): number {
  return ((((lon + 180) % 360) + 360) % 360) - 180;
}

const clamp = (value: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, value));

/** The box point nearest `point` (clamped per axis; see the module note). */
export function nearestBoxPoint(box: BoundingBox, point: GroundPoint): GroundPoint {
  return { lat: clamp(point.lat, box.south, box.north), lon: clamp(point.lon, box.west, box.east) };
}

/** Whether a swath of `swathKm` centred on `point` reaches the box. */
export function swathCoversBox(box: BoundingBox, point: GroundPoint, swathKm: number): boolean {
  return greatCircleKm(point, nearestBoxPoint(box, point)) <= swathKm / 2;
}

/** Initial great-circle bearing from `a` to `b`, radians clockwise from north. */
export function initialBearing(a: GroundPoint, b: GroundPoint): number {
  const phi1 = a.lat * DEG;
  const phi2 = b.lat * DEG;
  const dLambda = (b.lon - a.lon) * DEG;
  return Math.atan2(
    Math.sin(dLambda) * Math.cos(phi2),
    Math.cos(phi1) * Math.sin(phi2) - Math.sin(phi1) * Math.cos(phi2) * Math.cos(dLambda),
  );
}

/** The point `distanceKm` from `start` along the great circle leaving at `bearing` (rad). */
export function destination(start: GroundPoint, bearing: number, distanceKm: number): GroundPoint {
  const delta = distanceKm / EARTH_RADIUS_KM;
  const phi1 = start.lat * DEG;
  const lambda1 = start.lon * DEG;
  const phi2 = Math.asin(
    Math.sin(phi1) * Math.cos(delta) + Math.cos(phi1) * Math.sin(delta) * Math.cos(bearing),
  );
  const lambda2 =
    lambda1 +
    Math.atan2(
      Math.sin(bearing) * Math.sin(delta) * Math.cos(phi1),
      Math.cos(delta) - Math.sin(phi1) * Math.sin(phi2),
    );
  return { lat: phi2 / DEG, lon: normaliseLon(lambda2 / DEG) };
}

interface Sample {
  readonly ms: number;
  readonly point: GroundPoint | null;
  readonly covers: boolean;
}

const wholeSecond = (ms: number): EpochMs => Math.round(ms / 1000) * 1000;

/**
 * Every pass of `satrec` whose swath (`swathKm` across) reaches `box` and whose `mid` falls
 * in `[fromMs, toMs)`, in time order.
 */
export function computeSwathPasses(
  satrec: SatRec,
  box: BoundingBox,
  window: PassWindow,
  swathKm: number,
): readonly SwathPass[] {
  const start = Math.floor((window.fromMs - SCAN_MARGIN_MS) / SCAN_STEP_MS) * SCAN_STEP_MS;
  const end = window.toMs + SCAN_MARGIN_MS;
  const samples: Sample[] = [];
  for (let ms = start; ms <= end; ms += SCAN_STEP_MS) {
    // SGP4 failure reads as "not over the box": nothing is drawn from a position the
    // propagator could not produce.
    const point = subSatellitePoint(satrec, ms);
    samples.push({ ms, point, covers: point !== null && swathCoversBox(box, point, swathKm) });
  }

  const passes: SwathPass[] = [];
  let runStart = -1;
  for (let i = 0; i <= samples.length; i += 1) {
    const covers = i < samples.length && samples[i]!.covers;
    if (covers && runStart < 0) runStart = i;
    if (!covers && runStart >= 0) {
      const runEnd = i - 1;
      if (runStart > 0 && runEnd < samples.length - 1) {
        const pass = describeRun(samples, runStart, runEnd, box, swathKm);
        if (pass !== null && pass.midMs >= window.fromMs && pass.midMs < window.toMs) {
          passes.push(pass);
        }
      }
      runStart = -1;
    }
  }
  return passes;
}

function describeRun(
  samples: readonly Sample[],
  runStart: number,
  runEnd: number,
  box: BoundingBox,
  swathKm: number,
): SwathPass | null {
  const track: GroundPoint[] = [];
  const times: number[] = [];
  for (let i = runStart - 1; i <= runEnd + 1; i += 1) {
    const point = samples[i]!.point;
    if (point === null) continue;
    track.push(point);
    times.push(samples[i]!.ms);
  }
  if (track.length < 2) return null;

  const half = swathKm / 2;
  const left: GroundPoint[] = [];
  const right: GroundPoint[] = [];
  track.forEach((point, i) => {
    const bearing =
      i < track.length - 1
        ? initialBearing(point, track[i + 1]!)
        : initialBearing(track[i - 1]!, point);
    left.push(destination(point, bearing - Math.PI / 2, half));
    right.push(destination(point, bearing + Math.PI / 2, half));
  });

  const centre = { lat: (box.south + box.north) / 2, lon: (box.west + box.east) / 2 };
  let nearest = 0;
  let nearestKm = Infinity;
  track.forEach((point, i) => {
    const km = greatCircleKm(point, centre);
    if (km < nearestKm) {
      nearest = i;
      nearestKm = km;
    }
  });
  const at = track[nearest]!;
  return {
    startMs: wholeSecond(samples[runStart]!.ms),
    midMs: wholeSecond(times[nearest]!),
    endMs: wholeSecond(samples[runEnd]!.ms),
    track,
    left,
    right,
    labelAt: {
      lat: clamp(at.lat, box.south + LABEL_INSET_DEG, box.north - LABEL_INSET_DEG),
      lon: clamp(at.lon, box.west + LABEL_INSET_DEG, box.east - LABEL_INSET_DEG),
    },
  };
}
