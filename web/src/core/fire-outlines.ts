/**
 * V2-A4 estimated fire outlines, the pure half: what `/overlays/outlines/active.json` (or
 * the committed fixture) is, how it is validated, and what the map and the event panel
 * read from it.
 *
 * The body is the worker's outline pass over the events on the map
 * (`server/src/adapters/http/fire-outline-overlay-route.ts`): for each event, the union of
 * its own VIIRS/MODIS pixel footprints, closed over small gaps. It is an **estimate from
 * satellite detections** — never an official perimeter, never a forecast. Every feature
 * carries its area as a band (`area_low_ha`..`area_high_ha`) and how far any edge may sit
 * from where it is drawn (`edge_uncertainty_km`); the copy shows both.
 *
 * Every time shown comes from the body (`computed_at`, the pass that last confirmed it),
 * never from the fetch, so a revalidated copy cannot make an old outline look current.
 *
 * Colours avoid the red–orange band fire owns (CI-14): a violet dashed edge with a faint
 * violet fill, in a mid violet that holds about 4:1 against both the light and the dark
 * basemap, so no casing is needed.
 */

export interface FireOutlineProperties {
  readonly event_id: string;
  readonly area_ha: number;
  readonly area_low_ha: number;
  readonly area_high_ha: number;
  readonly edge_uncertainty_km: number;
  readonly footprints: number;
  readonly last_detection_at: string;
}

export type OutlinePosition = readonly [number, number];

export interface FireOutlineFeature {
  readonly type: 'Feature';
  readonly id: string;
  readonly geometry: {
    readonly type: 'MultiPolygon';
    readonly coordinates: readonly (readonly (readonly OutlinePosition[])[])[];
  };
  readonly properties: FireOutlineProperties;
}

export interface FireOutlineAttribution {
  readonly id: string;
  readonly source: string;
  readonly text: string;
  readonly href?: string;
}

/** The wire shape, as the route and the fixture spell it. */
export interface FireOutlineOverlayBody {
  readonly type: 'FeatureCollection';
  readonly schema_version: 1;
  readonly kind: 'estimated_outline';
  readonly params_version: string;
  readonly computed_at: string;
  readonly truncated: boolean;
  readonly features: readonly FireOutlineFeature[];
  readonly attribution: readonly FireOutlineAttribution[];
}

/** The violet edge and its faint fill — outside the band fire owns (CI-14). */
export const FIRE_OUTLINE_COLOR = '#a855f7';
/** Faint on purpose: the fire dots inside must stay the loudest thing on the map. */
export const FIRE_OUTLINE_FILL_OPACITY = 0.12;

/** A UTC instant (the route always writes `…Z`). */
function isInstant(value: unknown): value is string {
  return typeof value === 'string' && value.endsWith('Z') && Number.isFinite(Date.parse(value));
}

function isNonNegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

/** `[lon, lat]` on the Earth (a non-number fails every comparison). */
function isPosition(value: unknown): boolean {
  const [lon, lat] = value as number[];
  return (
    Array.isArray(value) && value.length === 2 && Math.abs(lon!) <= 180 && Math.abs(lat!) <= 90
  );
}

/** A closed ring of at least four positions. */
function isRing(value: unknown): boolean {
  return Array.isArray(value) && value.length >= 4 && value.every(isPosition);
}

function isMultiPolygon(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const geometry = value as Record<string, unknown>;
  const polygons = geometry['coordinates'];
  return (
    geometry['type'] === 'MultiPolygon' &&
    Array.isArray(polygons) &&
    polygons.length > 0 &&
    polygons.every(
      (polygon) => Array.isArray(polygon) && polygon.length > 0 && polygon.every(isRing),
    )
  );
}

function isProperties(value: unknown, id: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const p = value as Record<string, unknown>;
  const area = p['area_ha'];
  const low = p['area_low_ha'];
  const high = p['area_high_ha'];
  const footprints = p['footprints'];
  return (
    p['event_id'] === id &&
    isNonNegative(area) &&
    isNonNegative(low) &&
    isNonNegative(high) &&
    low <= area &&
    area <= high &&
    isNonNegative(p['edge_uncertainty_km']) &&
    typeof footprints === 'number' &&
    Number.isInteger(footprints) &&
    footprints > 0 &&
    isInstant(p['last_detection_at'])
  );
}

function isFeature(value: unknown): value is FireOutlineFeature {
  if (typeof value !== 'object' || value === null) return false;
  const feature = value as Record<string, unknown>;
  const id = feature['id'];
  return (
    feature['type'] === 'Feature' &&
    typeof id === 'string' &&
    id !== '' &&
    isMultiPolygon(feature['geometry']) &&
    isProperties(feature['properties'], id)
  );
}

/** The map's credit is rendered from the contracts registry, so only the shape is checked. */
function isAttribution(value: unknown): value is FireOutlineAttribution {
  return typeof (value as { id?: unknown } | null)?.id === 'string';
}

/**
 * The body, or `null` when it is not one this build can draw honestly: wrong schema or
 * kind, an unreadable time, a band that does not hold its own area, or a malformed ring.
 * Never throws.
 */
export function parseFireOutlineOverlay(value: unknown): FireOutlineOverlayBody | null {
  if (typeof value !== 'object' || value === null) return null;
  const body = value as Record<string, unknown>;
  if (body['type'] !== 'FeatureCollection') return null;
  if (body['schema_version'] !== 1 || body['kind'] !== 'estimated_outline') return null;
  if (typeof body['params_version'] !== 'string' || !isInstant(body['computed_at'])) return null;
  if (typeof body['truncated'] !== 'boolean') return null;
  const features = body['features'];
  const attribution = body['attribution'];
  if (!Array.isArray(features) || !features.every(isFeature)) return null;
  if (!Array.isArray(attribution) || !attribution.every(isAttribution)) return null;
  return value as FireOutlineOverlayBody;
}

/** One event's outline, or `null` when the body has none for it. */
export function fireOutlineFor(
  body: FireOutlineOverlayBody,
  eventId: string,
): FireOutlineProperties | null {
  return body.features.find((feature) => feature.id === eventId)?.properties ?? null;
}

/** What the map controller takes: the outlines plus the credit for their detections. */
export interface FireOutlineDraw {
  readonly collection: {
    readonly type: 'FeatureCollection';
    readonly features: readonly FireOutlineFeature[];
  };
  /** The FIRMS acknowledgement the outlines are drawn from (`firms-acknowledgement`). */
  readonly attribution: string;
}
