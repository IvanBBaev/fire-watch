/**
 * The wire boundary for `/snapshot.json` (ADR-003 D1). The snapshot travels as a GeoJSON
 * FeatureCollection with snake_case foreign members; this is the single place that guards
 * it and maps it into the flat `Snapshot` domain shape — nothing past the transport layer
 * ever sees wire JSON (`core/types.ts` header).
 *
 * The guards are deliberately cheap: types and required fields only, plus the two closed
 * vocabularies (`status` against `LIFECYCLE_STATES`, `score_bucket` against
 * `SCORE_BUCKETS`) whose drift would mean showing users a state the product does not
 * mean. Anything malformed throws a `ParseError`, and the caller treats the whole poll as
 * failed — a half-parsed snapshot fed to the store would corrupt the one authority on the
 * event set (ADR-003 D3 rule 1), so the only safe granularity is all-or-nothing.
 */

import type { LifecycleState, ScoreBucket } from '@fire-watch/contracts';
import { SCORE_BUCKETS, isLifecycleState } from '@fire-watch/contracts';

import type {
  FireEvent,
  Snapshot,
  SnapshotSourceRow,
  StaticSourceVerdictOnWire,
} from '../types.js';

/** Thrown on any structural defect in the wire body; the poll that got it has failed. */
export class ParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ParseError';
  }
}

type WireRecord = Record<string, unknown>;

function isRecord(value: unknown): value is WireRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function fail(path: string, expected: string, got: unknown): never {
  throw new ParseError(`${path}: expected ${expected}, got ${JSON.stringify(got) ?? 'undefined'}`);
}

function requireString(obj: WireRecord, key: string, path: string): string {
  const value = obj[key];
  if (typeof value !== 'string') fail(`${path}.${key}`, 'string', value);
  return value;
}

function requireStringOrNull(obj: WireRecord, key: string, path: string): string | null {
  const value = obj[key];
  if (value !== null && typeof value !== 'string') fail(`${path}.${key}`, 'string | null', value);
  return value;
}

function requireNumber(obj: WireRecord, key: string, path: string): number {
  const value = obj[key];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    fail(`${path}.${key}`, 'finite number', value);
  }
  return value;
}

function requireNumberOrNull(obj: WireRecord, key: string, path: string): number | null {
  const value = obj[key];
  if (value === null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    fail(`${path}.${key}`, 'finite number | null', value);
  }
  return value;
}

function requireBoolean(obj: WireRecord, key: string, path: string): boolean {
  const value = obj[key];
  if (typeof value !== 'boolean') fail(`${path}.${key}`, 'boolean', value);
  return value;
}

function requireArray(obj: WireRecord, key: string, path: string): readonly unknown[] {
  const value = obj[key];
  if (!Array.isArray(value)) fail(`${path}.${key}`, 'array', value);
  return value;
}

function parsePoint(value: unknown, path: string): { lon: number; lat: number } {
  if (!isRecord(value)) fail(path, 'Point geometry object', value);
  if (value['type'] !== 'Point') fail(`${path}.type`, '"Point"', value['type']);
  const coordinates = value['coordinates'];
  if (!Array.isArray(coordinates) || coordinates.length !== 2) {
    fail(`${path}.coordinates`, '[lon, lat]', coordinates);
  }
  const lon: unknown = coordinates[0];
  const lat: unknown = coordinates[1];
  if (typeof lon !== 'number' || !Number.isFinite(lon))
    fail(`${path}.coordinates[0]`, 'finite number', lon);
  if (typeof lat !== 'number' || !Number.isFinite(lat))
    fail(`${path}.coordinates[1]`, 'finite number', lat);
  return { lon, lat };
}

function parseStatus(obj: WireRecord, path: string): LifecycleState {
  const value = obj['status'];
  if (!isLifecycleState(value)) fail(`${path}.status`, 'a lifecycle state', value);
  return value;
}

function parseScoreBucket(obj: WireRecord, path: string): ScoreBucket {
  const value = obj['score_bucket'];
  if (typeof value !== 'string' || !(SCORE_BUCKETS as readonly string[]).includes(value)) {
    fail(`${path}.score_bucket`, 'a score bucket', value);
  }
  return value as ScoreBucket;
}

function parseNextPassWindow(
  obj: WireRecord,
  path: string,
): { readonly start: string; readonly end: string } | null {
  const value = obj['next_pass_window'];
  if (value === null) return null;
  if (!isRecord(value)) fail(`${path}.next_pass_window`, '{ start, end } | null', value);
  return {
    start: requireString(value, 'start', `${path}.next_pass_window`),
    end: requireString(value, 'end', `${path}.next_pass_window`),
  };
}

/**
 * The public id — the store key and the feature-state key — read from the GeoJSON feature
 * `id` and its `properties.id` twin (what `promoteId: 'id'` reads). Both are required and
 * must agree: a feature without an id could not be stored, and two ids that disagree would
 * key the store and the map on different events. Schema v2 carries no `uuid`; one on the
 * wire is ignored, never read.
 */
function parsePublicId(feature: WireRecord, properties: WireRecord, path: string): string {
  const id = feature['id'];
  if (typeof id !== 'string' || id === '') fail(`${path}.id`, 'non-empty string', id);
  const twin = requireString(properties, 'id', `${path}.properties`);
  if (twin !== id) fail(`${path}.properties.id`, JSON.stringify(id), twin);
  return id;
}

/**
 * Parse one wire `Feature` — shared with the stream guard, whose `data.feature` is the very
 * same shape (E2 frames carry a snapshot feature). Exported for that one caller.
 */
export function parseFeature(value: unknown, path: string): FireEvent {
  if (!isRecord(value)) fail(path, 'Feature object', value);
  if (value['type'] !== 'Feature') fail(`${path}.type`, '"Feature"', value['type']);
  const { lon, lat } = parsePoint(value['geometry'], `${path}.geometry`);
  const properties = value['properties'];
  if (!isRecord(properties)) fail(`${path}.properties`, 'properties object', properties);
  const p = `${path}.properties`;
  const id = parsePublicId(value, properties, path);
  return {
    id,
    seq: requireNumber(properties, 'seq', p),
    status: parseStatus(properties, p),
    scoreBucket: parseScoreBucket(properties, p),
    mergedInto: requireStringOrNull(properties, 'merged_into', p),
    lon,
    lat,
    firstObservedAt: requireString(properties, 'first_observed_at', p),
    lastObservedAt: requireString(properties, 'last_observed_at', p),
    detectionCount: requireNumber(properties, 'detection_count', p),
    placeNameBg: requireString(properties, 'place_name_bg', p),
    placeNameEn: requireString(properties, 'place_name_en', p),
    areaHa: requireNumberOrNull(properties, 'area_ha', p),
    nextPassWindow: parseNextPassWindow(properties, p),
    ...parseSourceIds(properties, p),
    ...parseStaticSourceVerdict(properties, p),
  };
}

/**
 * `source_ids` is additive and optional (Track F): absent or `null` leaves the field off
 * the event, so a feed that does not report it parses exactly as before. When present it
 * must be an array of strings — a malformed one is a wire defect like any other. The
 * strings themselves are *not* checked against the source registry: it is append-only, so
 * an id this bundle does not know means the server is newer, and rejecting the whole
 * snapshot for it would blank the map over a filter nicety. Unknown ids pass through and
 * the filter treats an event it cannot place in any family as unreported.
 */
function parseSourceIds(
  properties: WireRecord,
  path: string,
): { readonly sourceIds?: readonly string[] } {
  const raw = properties['source_ids'];
  if (raw === undefined || raw === null) return {};
  if (!Array.isArray(raw)) fail(`${path}.source_ids`, 'array of source id strings', raw);
  const ids: string[] = [];
  for (const id of raw as readonly unknown[]) {
    if (typeof id !== 'string') fail(`${path}.source_ids`, 'array of source id strings', raw);
    ids.push(id);
  }
  return { sourceIds: ids };
}

/**
 * `static_source_verdict` is additive and optional (F16): absent or `null` leaves the
 * field off. A string this bundle does not know is a newer server and is dropped the same
 * way — the caveat then falls back to the bundled mask — while a non-string is a wire
 * defect.
 */
function parseStaticSourceVerdict(
  properties: WireRecord,
  path: string,
): { readonly staticSourceVerdict?: StaticSourceVerdictOnWire } {
  const raw = properties['static_source_verdict'];
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== 'string') fail(`${path}.static_source_verdict`, 'verdict string', raw);
  return raw === 'annotated' || raw === 'clear' ? { staticSourceVerdict: raw } : {};
}

function parseSourceRow(value: unknown, path: string): SnapshotSourceRow {
  if (!isRecord(value)) fail(path, 'source row object', value);
  return {
    sourceId: requireString(value, 'source_id', path),
    lastObservedAt: requireStringOrNull(value, 'last_observed_at', path),
  };
}

/**
 * Parse and structurally guard a wire snapshot body. Throws `ParseError` on any defect;
 * never returns a partially-valid result.
 */
export function parseSnapshot(input: unknown): Snapshot {
  if (!isRecord(input)) fail('$', 'FeatureCollection object', input);
  if (input['type'] !== 'FeatureCollection') {
    fail('$.type', '"FeatureCollection"', input['type']);
  }
  return {
    schemaVersion: requireNumber(input, 'schema_version', '$'),
    generatedAt: requireString(input, 'generated_at', '$'),
    maxSeq: requireNumber(input, 'max_seq', '$'),
    partial: requireBoolean(input, 'partial', '$'),
    events: requireArray(input, 'features', '$').map((feature, i) =>
      parseFeature(feature, `$.features[${i}]`),
    ),
    sources: requireArray(input, 'sources', '$').map((row, i) =>
      parseSourceRow(row, `$.sources[${i}]`),
    ),
  };
}
