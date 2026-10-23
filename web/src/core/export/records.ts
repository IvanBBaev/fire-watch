/**
 * Events and detections → {@link ExportDocument} (TASKS V2-D1).
 *
 * Two documents, built from what the web already holds:
 *
 * - **the listed events** — exactly the rows the list shows under its active time window,
 *   source and region filters and viewport scope, one point per event at its centre;
 * - **one event's detections** — the event's detections file (`detectionsUrlTemplate`),
 *   one point per satellite pixel centre, with the sensor and observation time.
 *
 * Column names are a stable machine schema in English (`first_observed_utc`, not a
 * translated header), so a script written against one language's file reads the other's.
 * The words a person reads — the title, the caveat, the place name — come from the
 * catalog. `score_bucket` and `status` carry the product's own ids; the caveat states that
 * a score band is not a ground confirmation, so the file cannot be read as a register of
 * confirmed fires.
 */

import type { RenderContext } from '@fire-watch/contracts';

import type { Messages } from '../i18n/messages.js';
import type { FireEvent, Locale } from '../types.js';
import { exportAttribution } from './attribution.js';
import type { ExportDocument, ExportRecord, ExportValue } from './export-document.js';
import { isoUtc, normaliseIso } from './export-document.js';

/** The catalog copy an export file carries. */
export type ExportMessages = Pick<Messages, 'dataExport' | 'eventNearPlace'>;

export interface ExportContext {
  readonly messages: ExportMessages;
  readonly locale: Locale;
  /** When the file is made, server time. */
  readonly generatedAtMs: number;
  /** The credits placeholders, resolved as every other credit surface resolves them. */
  readonly credit: RenderContext;
}

export const EVENT_COLUMNS = [
  'record_type',
  'place_bg',
  'place_en',
  'status',
  'score_bucket',
  'first_observed_utc',
  'last_observed_utc',
  'detection_count',
  'area_ha',
  'source_ids',
] as const;

export const DETECTION_COLUMNS = [
  'record_type',
  'event_id',
  'source_id',
  'observed_utc',
  'frp_mw',
  'scan_km',
  'track_km',
] as const;

/** What every event row says it is: a cluster of satellite detections. */
export const EVENT_RECORD_TYPE = 'satellite_detection_event';
/** What every detection row says it is: one satellite pixel, not a fire. */
export const DETECTION_RECORD_TYPE = 'satellite_detection';

function placeOf(event: FireEvent, locale: Locale): string {
  return locale === 'bg' ? event.placeNameBg : event.placeNameEn;
}

function isoOrRaw(value: string): string {
  return normaliseIso(value) ?? value;
}

function eventRecord(event: FireEvent, context: ExportContext): ExportRecord {
  const first = isoOrRaw(event.firstObservedAt);
  const last = isoOrRaw(event.lastObservedAt);
  const properties: readonly (readonly [(typeof EVENT_COLUMNS)[number], ExportValue])[] = [
    ['record_type', EVENT_RECORD_TYPE],
    ['place_bg', event.placeNameBg],
    ['place_en', event.placeNameEn],
    ['status', event.status],
    ['score_bucket', event.scoreBucket],
    ['first_observed_utc', first],
    ['last_observed_utc', last],
    ['detection_count', event.detectionCount],
    ['area_ha', event.areaHa],
    ['source_ids', event.sourceIds === undefined ? null : event.sourceIds.join(';')],
  ];
  return {
    id: event.id,
    name: context.messages.eventNearPlace(placeOf(event, context.locale)),
    lon: event.lon,
    lat: event.lat,
    time: { begin: first, end: last },
    properties,
  };
}

/** The listed events, in list order. */
export function eventsDocument(
  events: readonly FireEvent[],
  context: ExportContext,
): ExportDocument {
  return {
    title: context.messages.dataExport.eventsTitle,
    notice: context.messages.dataExport.notice,
    generatedAt: isoUtc(context.generatedAtMs),
    attribution: exportAttribution(
      events.map((event) => event.sourceIds ?? null),
      context.credit,
    ),
    columns: EVENT_COLUMNS,
    records: events.map((event) => eventRecord(event, context)),
  };
}

/** One row of an event's detections file, as the export needs it. */
export interface ExportDetection {
  readonly uid: string;
  readonly lon: number;
  readonly lat: number;
  /** ISO UTC. */
  readonly observedAt: string;
  readonly sourceId: string;
  readonly frpMw: number | null;
  readonly scanKm: number | null;
  readonly trackKm: number | null;
}

function finiteOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function detectionOf(feature: unknown): ExportDetection | null {
  if (typeof feature !== 'object' || feature === null) return null;
  const record = feature as Record<string, unknown>;
  const properties = record['properties'];
  const geometry = record['geometry'];
  if (typeof properties !== 'object' || properties === null) return null;
  if (typeof geometry !== 'object' || geometry === null) return null;
  const props = properties as Record<string, unknown>;
  const geom = geometry as Record<string, unknown>;
  const uid = props['uid'];
  const sourceId = props['source_id'];
  const observed = props['observed_at'];
  if (typeof uid !== 'string' || typeof sourceId !== 'string' || typeof observed !== 'string') {
    return null;
  }
  const observedAt = normaliseIso(observed);
  const coordinates = geom['coordinates'];
  if (observedAt === null || geom['type'] !== 'Point' || !Array.isArray(coordinates)) return null;
  const [lon, lat] = coordinates as unknown[];
  if (typeof lon !== 'number' || typeof lat !== 'number') return null;
  if (!Number.isFinite(lon) || !Number.isFinite(lat) || Math.abs(lon) > 180 || Math.abs(lat) > 90) {
    return null;
  }
  const frp = finiteOrNull(props['frp_mw']);
  return {
    uid,
    lon,
    lat,
    observedAt,
    sourceId,
    frpMw: frp !== null && frp >= 0 ? frp : null,
    scanKm: finiteOrNull(props['scan_km']),
    trackKm: finiteOrNull(props['track_km']),
  };
}

/**
 * An event's detections file → rows, oldest first (then by uid, so the order is stable).
 * A row without a usable point or time is dropped, never repaired — the export carries
 * only what the file actually says.
 */
export function parseExportDetections(input: unknown): ExportDetection[] {
  if (typeof input !== 'object' || input === null) return [];
  const features = (input as Record<string, unknown>)['features'];
  if (!Array.isArray(features)) return [];
  const rows: ExportDetection[] = [];
  for (const feature of features as unknown[]) {
    const row = detectionOf(feature);
    if (row !== null) rows.push(row);
  }
  return rows.sort(
    (a, b) =>
      a.observedAt.localeCompare(b.observedAt) || (a.uid < b.uid ? -1 : a.uid > b.uid ? 1 : 0),
  );
}

/** One event's detections. */
export function detectionsDocument(
  event: FireEvent,
  detections: readonly ExportDetection[],
  context: ExportContext,
): ExportDocument {
  const place = placeOf(event, context.locale);
  return {
    title: context.messages.dataExport.detectionsTitle(place),
    notice: context.messages.dataExport.notice,
    generatedAt: isoUtc(context.generatedAtMs),
    attribution: exportAttribution(
      detections.map((detection) => [detection.sourceId]),
      context.credit,
    ),
    columns: DETECTION_COLUMNS,
    records: detections.map((detection) => ({
      id: detection.uid,
      name: `${detection.sourceId} ${detection.observedAt}`,
      lon: detection.lon,
      lat: detection.lat,
      time: { begin: detection.observedAt, end: detection.observedAt },
      properties: [
        ['record_type', DETECTION_RECORD_TYPE],
        ['event_id', event.id],
        ['source_id', detection.sourceId],
        ['observed_utc', detection.observedAt],
        ['frp_mw', detection.frpMw],
        ['scan_km', detection.scanKm],
        ['track_km', detection.trackKm],
      ],
    })),
  };
}

/** `fire-watch-events-20261024T120000Z.csv` — sortable, and safe on every file system. */
export function exportFileName(stem: string, generatedAtMs: number, extension: string): string {
  const stamp = isoUtc(generatedAtMs).replaceAll(/[-:]/gu, '');
  const safeStem = stem.replaceAll(/[^A-Za-z0-9_-]+/gu, '-');
  return `fire-watch-${safeStem}-${stamp}.${extension}`;
}
