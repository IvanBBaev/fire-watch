/**
 * EFFIS burnt-area GeoJSON → label perimeters (TASKS D7; DATASETS DS-3).
 *
 * Reads the same files, under the same conventions, as the DS-6 candidate selection
 * (`infra/geodata/effis-ba-candidates.ts`): properties `id`, `FIREDATE`, `FINALDATE`,
 * `AREA_HA`; outer rings only, from Polygon, MultiPolygon and the polygonal members of a
 * GeometryCollection; holes ignored. It is a second reader rather than an import because
 * `infra/` is a tooling tree outside the server's build and the server core may not reach
 * it — the rules are restated here and tested against hand-built features.
 *
 * Two differences, both on the strict side. A feature with no `AREA_HA` is dropped, not
 * read as 0 ha: its size class is the whole point of the stratified gate. A feature whose
 * dates do not parse is dropped too, because the label join's time window is built from
 * them. Every drop is counted by reason, never guessed.
 *
 * EFFIS dates are `YYYY-MM-DD HH:MM:SS` (or a bare date) with no zone; they are read as
 * UTC, which is what the EFFIS WFS documents for the field and what the DS-6 selection
 * does. `FINALDATE` empty means the fire was never closed in the record, and the window
 * then ends at `FIREDATE` + the join's after-margin.
 */

import { epochMsFromIso } from '../ports/clock.js';
import type { LabelPerimeter, LonLat } from './label-join.js';

export type PerimeterRejection = 'no_id' | 'no_polygon' | 'no_area' | 'bad_date' | 'duplicate_id';

export interface ParsedPerimeters {
  readonly perimeters: readonly LabelPerimeter[];
  readonly rejected: Readonly<Record<PerimeterRejection, number>>;
}

const DATE_RE = /^(\d{4}-\d{2}-\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/;

/**
 * @param layerKey prefixed onto every feature id (`2024/239071`), because EFFIS ids are
 *   unique within a layer and the fit pools six of them.
 */
export function parseEffisPerimeters(layerKey: string, collection: unknown): ParsedPerimeters {
  const rejected: Record<PerimeterRejection, number> = {
    no_id: 0,
    no_polygon: 0,
    no_area: 0,
    bad_date: 0,
    duplicate_id: 0,
  };
  const features = featuresOf(collection);
  const perimeters: LabelPerimeter[] = [];
  const seen = new Set<string>();
  for (const feature of features) {
    const props = isRecord(feature.properties) ? feature.properties : {};
    const id = text(props, 'id');
    if (id === '') {
      rejected.no_id += 1;
      continue;
    }
    const rings = outerRings(feature.geometry);
    if (rings.length === 0) {
      rejected.no_polygon += 1;
      continue;
    }
    const area = numberOrNull(text(props, 'AREA_HA'));
    if (area === null || area < 0) {
      rejected.no_area += 1;
      continue;
    }
    const startMs = effisDateMs(text(props, 'FIREDATE'));
    const finalText = text(props, 'FINALDATE');
    const endMs = finalText.trim() === '' ? startMs : effisDateMs(finalText);
    if (startMs === null || endMs === null || endMs < startMs) {
      rejected.bad_date += 1;
      continue;
    }
    const fireId = `${layerKey}/${id}`;
    if (seen.has(fireId)) {
      rejected.duplicate_id += 1;
      continue;
    }
    seen.add(fireId);
    perimeters.push({ fireId, startMs, endMs, areaHa: area, rings });
  }
  perimeters.sort((a, b) => (a.fireId < b.fireId ? -1 : a.fireId > b.fireId ? 1 : 0));
  return { perimeters, rejected };
}

/** `YYYY-MM-DD[ HH:MM[:SS]]`, read as UTC; `null` when it is not that shape. */
export function effisDateMs(raw: string): number | null {
  const match = DATE_RE.exec(raw.trim());
  if (match === null) return null;
  const [, day, hh = '00', mm = '00', ss = '00'] = match;
  try {
    return epochMsFromIso(`${day as string}T${hh}:${mm}:${ss}Z`);
  } catch {
    return null;
  }
}

interface FeatureLike {
  readonly properties?: unknown;
  readonly geometry?: unknown;
}

function featuresOf(collection: unknown): readonly FeatureLike[] {
  if (!isRecord(collection) || !Array.isArray(collection['features'])) {
    throw new TypeError('EFFIS layer is not a GeoJSON FeatureCollection');
  }
  return (collection['features'] as unknown[]).filter(isRecord);
}

function outerRings(geometry: unknown): (readonly LonLat[])[] {
  if (!isRecord(geometry)) return [];
  if (geometry['type'] === 'GeometryCollection') {
    return Array.isArray(geometry['geometries']) ? geometry['geometries'].flatMap(outerRings) : [];
  }
  if (geometry['type'] === 'Polygon') {
    return ringFrom(
      Array.isArray(geometry['coordinates']) ? geometry['coordinates'][0] : undefined,
    );
  }
  if (geometry['type'] === 'MultiPolygon' && Array.isArray(geometry['coordinates'])) {
    return geometry['coordinates'].flatMap((polygon: unknown) =>
      ringFrom(Array.isArray(polygon) ? polygon[0] : undefined),
    );
  }
  return [];
}

/** A ring of at least three finite `[lon, lat]` positions, or nothing. */
function ringFrom(raw: unknown): (readonly LonLat[])[] {
  if (!Array.isArray(raw)) return [];
  const ring: LonLat[] = [];
  for (const position of raw) {
    if (!Array.isArray(position)) return [];
    const [lon, lat] = position as unknown[];
    if (typeof lon !== 'number' || typeof lat !== 'number') return [];
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) return [];
    ring.push([lon, lat]);
  }
  return ring.length >= 3 ? [ring] : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function text(props: Record<string, unknown>, key: string): string {
  const v = props[key];
  return typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '';
}

function numberOrNull(raw: string): number | null {
  if (raw.trim() === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}
