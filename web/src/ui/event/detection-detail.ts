/**
 * Per-detection detail for the event page: parsed from the event's detections file and
 * reduced to what the page states — which sensors contributed, which sensor saw it last,
 * and the fire radiative power (FRP) of each overpass.
 *
 * Pure: no fetch, no clock. The snapshot stays the authority for the event's own facts
 * (first/last observation, detection count); this file only adds what the snapshot does
 * not carry, and a missing or partial detections file removes those additions rather than
 * guessing them.
 *
 * `frp_mw` is optional on the wire: detections recorded before it existed, and sources
 * that do not publish it, simply contribute no FRP point. Absence is never read as zero.
 *
 * The position is kept for one reader, the per-detection static-source caveat (TASKS F16):
 * a row whose geometry is not a finite Point keeps its sensor and FRP facts and simply has
 * no position, so it can never be counted as near a heat source.
 */

import { sensorOrder } from './sensors.js';

export interface DetailDetection {
  readonly uid: string;
  readonly observedAt: string;
  readonly observedMs: number;
  readonly sourceId: string;
  /** Megawatts; `null` when the source did not publish a value. */
  readonly frpMw: number | null;
  /** The pixel centre; `null` when the feature carries no finite Point geometry. */
  readonly position: DetectionPosition | null;
}

export interface DetectionPosition {
  readonly lon: number;
  readonly lat: number;
}

/** One pass of one sensor over the event: every detection it made at one instant. */
export interface Overpass {
  readonly observedAt: string;
  readonly observedMs: number;
  readonly sourceId: string;
  readonly detections: number;
  /** Sum over the pass's detections that carry FRP — the event's radiated power as that pass saw it. */
  readonly frpMw: number | null;
}

export interface SensorContribution {
  readonly sourceId: string;
  readonly detections: number;
}

export interface FrpSummary {
  /** The most recent pass that carried FRP (not necessarily the most recent pass). */
  readonly latest: Overpass;
  /** The pass with the highest FRP; the earliest one on a tie. */
  readonly peak: Overpass;
  /** Every pass with FRP, oldest first. */
  readonly series: readonly Overpass[];
  /** More than one sensor contributed FRP, so the series mixes incomparable numbers. */
  readonly mixedSensors: boolean;
}

export interface DetectionSummary {
  /** Sources of the most recent observation instant, in registry order. */
  readonly latestSources: readonly string[];
  readonly latestObservedAt: string;
  /** Registry order, unknown sources last. */
  readonly sensors: readonly SensorContribution[];
  /** `null` when no detection carries FRP. */
  readonly frp: FrpSummary | null;
  /** Every detection's position, file order; rows without one are left out (F16 caveat). */
  readonly positions: readonly DetectionPosition[];
}

/** The detections file → typed rows. Malformed rows are dropped, never repaired. */
export function parseDetectionDetail(input: unknown): DetailDetection[] {
  if (typeof input !== 'object' || input === null) return [];
  const features = (input as Record<string, unknown>)['features'];
  if (!Array.isArray(features)) return [];
  const rows: DetailDetection[] = [];
  for (const feature of features as unknown[]) {
    const row = parseRow(feature);
    if (row !== null) rows.push(row);
  }
  return rows;
}

function parseRow(feature: unknown): DetailDetection | null {
  if (typeof feature !== 'object' || feature === null) return null;
  const properties = (feature as Record<string, unknown>)['properties'];
  if (typeof properties !== 'object' || properties === null) return null;
  const record = properties as Record<string, unknown>;
  const uid = record['uid'];
  const observedAt = record['observed_at'];
  const sourceId = record['source_id'];
  if (typeof uid !== 'string' || typeof observedAt !== 'string' || typeof sourceId !== 'string') {
    return null;
  }
  const observedMs = Date.parse(observedAt);
  if (!Number.isFinite(observedMs)) return null;
  const frp = record['frp_mw'];
  const frpMw = typeof frp === 'number' && Number.isFinite(frp) && frp >= 0 ? frp : null;
  return { uid, observedAt, observedMs, sourceId, frpMw, position: pointOf(feature) };
}

function pointOf(feature: object): DetectionPosition | null {
  const geometry = (feature as Record<string, unknown>)['geometry'];
  if (typeof geometry !== 'object' || geometry === null) return null;
  const record = geometry as Record<string, unknown>;
  const coordinates = record['coordinates'];
  if (record['type'] !== 'Point' || !Array.isArray(coordinates)) return null;
  const [lon, lat] = coordinates as unknown[];
  if (typeof lon !== 'number' || typeof lat !== 'number') return null;
  if (!Number.isFinite(lon) || !Number.isFinite(lat) || Math.abs(lat) > 90) return null;
  if (Math.abs(lon) > 180) return null;
  return { lon, lat };
}

const byTimeThenSensor = (a: Overpass, b: Overpass): number =>
  a.observedMs - b.observedMs || sensorOrder(a.sourceId) - sensorOrder(b.sourceId);

/** Groups detections into overpasses, oldest first. */
export function overpassesOf(detections: readonly DetailDetection[]): Overpass[] {
  const groups = new Map<string, { first: DetailDetection; count: number; frp: number | null }>();
  for (const detection of detections) {
    const key = `${String(detection.observedMs)}|${detection.sourceId}`;
    const group = groups.get(key);
    if (group === undefined) {
      groups.set(key, { first: detection, count: 1, frp: detection.frpMw });
    } else {
      group.count += 1;
      if (detection.frpMw !== null) group.frp = (group.frp ?? 0) + detection.frpMw;
    }
  }
  return [...groups.values()]
    .map(({ first, count, frp }) => ({
      observedAt: first.observedAt,
      observedMs: first.observedMs,
      sourceId: first.sourceId,
      detections: count,
      frpMw: frp === null ? null : Math.round(frp * 10) / 10,
    }))
    .toSorted(byTimeThenSensor);
}

export function summariseDetections(
  detections: readonly DetailDetection[],
): DetectionSummary | null {
  if (detections.length === 0) return null;
  const passes = overpassesOf(detections);
  const last = passes.at(-1);
  if (last === undefined) return null;

  const latestSources = passes
    .filter((pass) => pass.observedMs === last.observedMs)
    .map((pass) => pass.sourceId);

  const counts = new Map<string, number>();
  for (const detection of detections) {
    counts.set(detection.sourceId, (counts.get(detection.sourceId) ?? 0) + 1);
  }
  const sensors = [...counts.entries()]
    .map(([sourceId, count]) => ({ sourceId, detections: count }))
    .toSorted((a, b) => sensorOrder(a.sourceId) - sensorOrder(b.sourceId));

  return {
    latestSources,
    latestObservedAt: last.observedAt,
    sensors,
    frp: frpSummary(passes),
    positions: detections.flatMap((detection) =>
      detection.position === null ? [] : [detection.position],
    ),
  };
}

function frpSummary(passes: readonly Overpass[]): FrpSummary | null {
  const series = passes.filter((pass) => pass.frpMw !== null);
  const latest = series.at(-1);
  if (latest === undefined) return null;
  let peak = latest;
  for (const pass of series) {
    if (
      (pass.frpMw ?? 0) > (peak.frpMw ?? 0) ||
      (pass.frpMw === peak.frpMw && pass.observedMs < peak.observedMs)
    ) {
      peak = pass;
    }
  }
  const mixedSensors = new Set(series.map((pass) => pass.sourceId)).size > 1;
  return { latest, peak, series, mixedSensors };
}
