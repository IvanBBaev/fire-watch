/**
 * One event's estimated outline over time (V3-P3): the document
 * `GET /api/v1/events/{id}/outline-series` serves, and its parser.
 *
 * The server replays its V2-A4 outline drawing over the event's member detections, once per
 * satellite observation (`server/src/core/outlines/series.ts`); V3-B1 (observed growth
 * direction) and V3-B2 (area over time) only read it. It lives here because both sides
 * must agree on it to the field, and the readers are features of their own.
 *
 * Descriptive, never predictive: every point is what the satellites had seen by `at`. The
 * area is a band (`area_low_ha`..`area_high_ha`), as on the outline itself, and the label
 * is "estimated outline from satellite detections" wherever a point is shown.
 */

export const OUTLINE_SERIES_SCHEMA_VERSION = 1;

/** The live route; `{id}` is the event's public id. */
export const OUTLINE_SERIES_URL_TEMPLATE = '/api/v1/events/{id}/outline-series';

export interface OutlineSeriesPointWire {
  /** The last acquisition instant of the observation the point closes; explicit UTC. */
  readonly at: string;
  readonly area_ha: number;
  readonly area_low_ha: number;
  readonly area_high_ha: number;
  readonly edge_uncertainty_km: number;
  readonly footprints: number;
  /** Area-weighted centroid of the outline, `[lon, lat]`, 5-dp degrees. */
  readonly centroid: readonly [number, number];
}

/** One rendered credit, the shape every read route serves (`SnapshotAttribution`). */
export interface OutlineSeriesAttribution {
  readonly id: string;
  readonly source: string;
  readonly text: string;
  readonly href?: string;
}

export interface OutlineSeriesDocument {
  readonly schema_version: typeof OUTLINE_SERIES_SCHEMA_VERSION;
  /** Never claims to be a perimeter. */
  readonly kind: 'estimated_outline_series';
  /** The id the request named. For a merge tombstone, not the survivor's. */
  readonly event_id: string;
  /** The final survivor's public id for a merge tombstone (then `points` is empty). */
  readonly merged_into: string | null;
  /** The outline parameters every point was drawn under. */
  readonly params_version: string;
  readonly generated_at: string;
  /**
   * True when the event has more member detections than the read covers: the early points
   * then lack the oldest detections and understate the area they had.
   */
  readonly truncated: boolean;
  /** True when observations were left out to bound the body; the first and last are kept. */
  readonly thinned: boolean;
  /** Oldest first, strictly increasing in `at`. */
  readonly points: readonly OutlineSeriesPointWire[];
  readonly attribution: readonly OutlineSeriesAttribution[];
}

/** The live URL, or a template's, for one event. */
export function outlineSeriesUrl(template: string, eventId: string): string {
  return template.replace('{id}', encodeURIComponent(eventId));
}

/** A UTC instant as the route writes it (`…Z`). */
function isInstant(value: unknown): value is string {
  return typeof value === 'string' && value.endsWith('Z') && Number.isFinite(Date.parse(value));
}

function isNonNegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parsePoint(value: unknown): OutlineSeriesPointWire | null {
  if (!isRecord(value)) return null;
  const { at, area_ha, area_low_ha, area_high_ha, edge_uncertainty_km, footprints, centroid } =
    value;
  if (!isInstant(at)) return null;
  if (!isNonNegative(area_ha) || !isNonNegative(area_low_ha) || !isNonNegative(area_high_ha)) {
    return null;
  }
  if (!(area_low_ha <= area_ha && area_ha <= area_high_ha)) return null;
  if (!isNonNegative(edge_uncertainty_km) || edge_uncertainty_km === 0) return null;
  if (!Number.isSafeInteger(footprints) || (footprints as number) < 1) return null;
  if (!Array.isArray(centroid) || centroid.length !== 2) return null;
  const [lon, lat] = centroid as unknown[];
  if (typeof lon !== 'number' || typeof lat !== 'number') return null;
  if (!(Math.abs(lon) <= 180 && Math.abs(lat) <= 90)) return null;
  return {
    at,
    area_ha,
    area_low_ha,
    area_high_ha,
    edge_uncertainty_km,
    footprints: footprints as number,
    centroid: [lon, lat],
  };
}

function parseAttribution(value: unknown): OutlineSeriesAttribution | null {
  if (!isRecord(value)) return null;
  const { id, source, text, href } = value;
  if (typeof id !== 'string' || typeof source !== 'string' || typeof text !== 'string') {
    return null;
  }
  if (href !== undefined && typeof href !== 'string') return null;
  return { id, source, text, ...(href === undefined ? {} : { href }) };
}

/**
 * The document, or `null` when anything in it is off: a reader shows nothing rather than a
 * series it cannot vouch for. Points must be strictly increasing in time.
 */
export function parseOutlineSeries(value: unknown): OutlineSeriesDocument | null {
  if (!isRecord(value)) return null;
  if (value['schema_version'] !== OUTLINE_SERIES_SCHEMA_VERSION) return null;
  if (value['kind'] !== 'estimated_outline_series') return null;
  const eventId = value['event_id'];
  const mergedInto = value['merged_into'];
  const paramsVersion = value['params_version'];
  if (typeof eventId !== 'string' || eventId.length === 0) return null;
  if (mergedInto !== null && typeof mergedInto !== 'string') return null;
  if (typeof paramsVersion !== 'string' || paramsVersion.length === 0) return null;
  const generatedAt = value['generated_at'];
  const truncated = value['truncated'];
  const thinned = value['thinned'];
  if (!isInstant(generatedAt)) return null;
  if (typeof truncated !== 'boolean' || typeof thinned !== 'boolean') return null;
  const rawPoints = value['points'];
  const rawAttribution = value['attribution'];
  if (!Array.isArray(rawPoints) || !Array.isArray(rawAttribution)) return null;
  if (mergedInto !== null && rawPoints.length > 0) return null;

  const points: OutlineSeriesPointWire[] = [];
  let previous = -Infinity;
  for (const raw of rawPoints) {
    const point = parsePoint(raw);
    if (point === null) return null;
    const at = Date.parse(point.at);
    if (!(at > previous)) return null;
    previous = at;
    points.push(point);
  }
  const attribution: OutlineSeriesAttribution[] = [];
  for (const raw of rawAttribution) {
    const credit = parseAttribution(raw);
    if (credit === null) return null;
    attribution.push(credit);
  }

  return {
    schema_version: OUTLINE_SERIES_SCHEMA_VERSION,
    kind: 'estimated_outline_series',
    event_id: eventId,
    merged_into: mergedInto,
    params_version: paramsVersion,
    generated_at: generatedAt,
    truncated,
    thinned,
    points,
    attribution,
  };
}
