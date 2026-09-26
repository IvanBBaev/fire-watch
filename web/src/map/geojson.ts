/**
 * Pure builders between the store's flat shapes and the GeoJSON the map sources eat.
 *
 * Feature identity is the *public* id (`fw-<year>-<base32>`): together with
 * `promoteId: 'id'` on the `fire-events` source it is what MapLibre feature-state keys
 * on (spike B6), and the store keys on the same id. No internal UUID ever reaches the client.
 *
 * Feature `properties` stay snake_case on purpose: they are what the layer expressions
 * (`['get', 'score_bucket']`, …) address, and keeping them wire-shaped means a future
 * server-rendered snapshot can feed the same layers without a rename pass.
 */

import type { LifecycleState, ScoreBucket } from '@fire-watch/contracts';

import type { LinearRing } from '../core/geo/footprint.js';
import { footprintRing, resolveFootprintKm } from '../core/geo/footprint.js';
import { isWithinCutoff } from '../core/time/age-filter.js';
import type { Detection, StoreState } from '../core/types.js';

export interface FireEventFeature {
  type: 'Feature';
  /** Public id — promoted to the MapLibre feature id via `promoteId: 'id'`. */
  id: string;
  geometry: { type: 'Point'; coordinates: [number, number] };
  properties: {
    id: string;
    status: LifecycleState;
    score_bucket: ScoreBucket;
    area_ha: number | null;
  };
}

/**
 * Detections carry their parent event's `id`, `status` and `score_bucket` alongside their
 * own fields. They are not derived facts — they are the parent's, copied down so a
 * detection feature can be coloured and selected without a second source lookup inside a
 * layer expression, which MapLibre has no way to express.
 */
interface DetectionProperties {
  uid: string;
  /** Parent event's public id — what a tap on this feature selects. */
  id: string;
  status: LifecycleState;
  score_bucket: ScoreBucket;
  observed_at: string;
  source_id: string;
}

export interface DetectionFeature {
  type: 'Feature';
  id: string;
  geometry: { type: 'Point'; coordinates: [number, number] };
  properties: DetectionProperties;
}

/** One detection drawn as the cell the instrument integrated over (`core/geo/footprint.ts`). */
export interface DetectionCellFeature {
  type: 'Feature';
  id: string;
  geometry: { type: 'Polygon'; coordinates: LinearRing[] };
  properties: DetectionProperties;
}

export interface FeatureCollectionOf<F> {
  type: 'FeatureCollection';
  features: F[];
}

export type FireEventsCollection = FeatureCollectionOf<FireEventFeature>;
export type DetectionsCollection = FeatureCollectionOf<DetectionFeature>;
export type DetectionCellsCollection = FeatureCollectionOf<DetectionCellFeature>;

/**
 * The detections of one event, with the parent attributes their features inherit.
 *
 * Detections are fetched per event and drawn for *many* events at once, so the grouping
 * has to survive into the builders: without it the cells of a burning fire and those of one
 * the satellite stopped seeing a week ago would be indistinguishable on the map.
 */
export interface DetectionGroup {
  readonly eventId: string;
  readonly status: LifecycleState;
  readonly scoreBucket: ScoreBucket;
  readonly detections: readonly Detection[];
}

/** Fresh empty collection — `never[]` features make it assignable to either source. */
export function emptyFeatureCollection(): FeatureCollectionOf<never> {
  return { type: 'FeatureCollection', features: [] };
}

/**
 * The reader's time window, as the map applies it. Not a lifecycle judgement: `cutoffMs`
 * is a *display* bound the reader chose, while archival stays server-decided
 * (ADR-003 A1.4/R1). Both surfaces are handed the same instant so the map and the list
 * cannot disagree about what counts as recent.
 */
export interface FireEventsFilter {
  /** Hide events last observed before this instant; `null` applies no time bound. */
  readonly cutoffMs: number | null;
  /**
   * Public id kept regardless of the cutoff. An event opened from "show older" is the one
   * the reader is currently looking at — the map must not be blank where it is.
   */
  readonly keepId: string | null;
}

const NO_FILTER: FireEventsFilter = { cutoffMs: null, keepId: null };

/**
 * StoreState → the `fire-events` FeatureCollection.
 *
 * `archived` events never render: plain archived history and merge tombstones
 * (`mergedInto` set) both stay resident in the store so permalinks resolve, but on the
 * map they would only shadow the survivor. Exclusion by lifecycle state, decided
 * server-side (ADR-002 D6) — the client adds no lifecycle judgement of its own.
 */
export function buildFireEventsCollection(
  state: StoreState,
  filter: FireEventsFilter = NO_FILTER,
): FireEventsCollection {
  const features: FireEventFeature[] = [];
  for (const event of state.events.values()) {
    if (event.status === 'archived') continue;
    if (event.id !== filter.keepId && !isWithinCutoff(event, filter.cutoffMs)) continue;
    features.push({
      type: 'Feature',
      id: event.id,
      geometry: { type: 'Point', coordinates: [event.lon, event.lat] },
      properties: {
        id: event.id,
        status: event.status,
        score_bucket: event.scoreBucket,
        area_ha: event.areaHa,
      },
    });
  }
  return { type: 'FeatureCollection', features };
}

function detectionProperties(group: DetectionGroup, detection: Detection): DetectionProperties {
  return {
    uid: detection.uid,
    id: group.eventId,
    status: group.status,
    score_bucket: group.scoreBucket,
    observed_at: detection.observedAt,
    source_id: detection.sourceId,
  };
}

/**
 * Groups → the `fire-detections` FeatureCollection: one point per detection, at the pixel
 * centre the source published.
 *
 * The centre is the *anchor*, not the claim — {@link buildDetectionCellsCollection} draws
 * what the observation actually covers. The two layers are meant to be read together: the
 * cell says "in here", the dot says "and this is the middle of the pixel that saw it".
 */
export function buildDetectionsCollection(groups: readonly DetectionGroup[]): DetectionsCollection {
  const features: DetectionFeature[] = [];
  for (const group of groups) {
    for (const detection of group.detections) {
      features.push({
        type: 'Feature',
        id: detection.uid,
        geometry: { type: 'Point', coordinates: [detection.lon, detection.lat] },
        properties: detectionProperties(group, detection),
      });
    }
  }
  return { type: 'FeatureCollection', features };
}

/**
 * Groups → the `fire-detection-cells` FeatureCollection: one hatched polygon per detection.
 *
 * **The union of cells is the area, and there is no hull.** Drawing a convex or alpha hull
 * over the detections would be the shorter route to something that looks like a fire
 * perimeter, and it is exactly the mistake `DATA-SOURCES-EXTENDED.md` §"perimeter from
 * points" warns against: a hull over sparse detections describes where a fire *has been*,
 * and its interior asserts burning ground nobody observed. Every cell here is one
 * measurement, drawn at the size it was measured at; where cells overlap, the fire is
 * genuinely better observed, and the map says so by getting denser rather than by inventing
 * an outline.
 */
export function buildDetectionCellsCollection(
  groups: readonly DetectionGroup[],
): DetectionCellsCollection {
  const features: DetectionCellFeature[] = [];
  for (const group of groups) {
    for (const detection of group.detections) {
      const footprint = resolveFootprintKm(detection.scanKm, detection.trackKm);
      features.push({
        type: 'Feature',
        id: detection.uid,
        geometry: {
          type: 'Polygon',
          coordinates: [footprintRing(detection.lon, detection.lat, footprint)],
        },
        properties: detectionProperties(group, detection),
      });
    }
  }
  return { type: 'FeatureCollection', features };
}

function readString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === 'string' ? value : null;
}

/**
 * An optional numeric wire field. Absent, null and non-numeric all collapse to `null`,
 * which is the value the nadir substitution keys on — a missing footprint is an ordinary
 * state of the data, not a malformed feature, so it must never cost us the detection.
 */
function readOptionalNumber(record: Record<string, unknown>, key: string): number | null {
  const value = record[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function parseDetectionFeature(feature: unknown): Detection | null {
  if (typeof feature !== 'object' || feature === null) return null;
  const record = feature as Record<string, unknown>;

  const geometry = record['geometry'];
  if (typeof geometry !== 'object' || geometry === null) return null;
  const geometryRecord = geometry as Record<string, unknown>;
  if (geometryRecord['type'] !== 'Point') return null;
  const coordinates = geometryRecord['coordinates'];
  if (!Array.isArray(coordinates) || coordinates.length < 2) return null;
  const lon: unknown = coordinates[0];
  const lat: unknown = coordinates[1];
  if (typeof lon !== 'number' || !Number.isFinite(lon)) return null;
  if (typeof lat !== 'number' || !Number.isFinite(lat)) return null;

  const properties = record['properties'];
  if (typeof properties !== 'object' || properties === null) return null;
  const propertiesRecord = properties as Record<string, unknown>;
  const uid = readString(propertiesRecord, 'uid');
  const observedAt = readString(propertiesRecord, 'observed_at');
  const sourceId = readString(propertiesRecord, 'source_id');
  if (uid === null || observedAt === null || sourceId === null) return null;

  return {
    uid,
    lon,
    lat,
    observedAt,
    sourceId,
    scanKm: readOptionalNumber(propertiesRecord, 'scan_km'),
    trackKm: readOptionalNumber(propertiesRecord, 'track_km'),
  };
}

/**
 * Guard the wire GeoJSON of a per-event detections file
 * (`/fixtures/detections/<public-id>.json`: snake_case `uid`/`observed_at`/`source_id`, with
 * optional `scan_km`/`track_km`) into flat `Detection`s. Tolerant by feature: a malformed
 * feature is skipped, a
 * malformed document yields an empty list — detection detail is an inspection aid and
 * must never take the map down.
 */
export function parseDetectionsGeoJson(input: unknown): Detection[] {
  if (typeof input !== 'object' || input === null) return [];
  const features = (input as Record<string, unknown>)['features'];
  if (!Array.isArray(features)) return [];
  const detections: Detection[] = [];
  for (const feature of features) {
    const detection = parseDetectionFeature(feature);
    if (detection !== null) detections.push(detection);
  }
  return detections;
}
