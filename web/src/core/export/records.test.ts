import { describe, expect, it } from 'vitest';

import bg from '../i18n/bg.js';
import en from '../i18n/en.js';
import type { FireEvent } from '../types.js';
import {
  DETECTION_RECORD_TYPE,
  detectionsDocument,
  EVENT_RECORD_TYPE,
  eventsDocument,
  type ExportContext,
  exportFileName,
  parseExportDetections,
} from './records.js';
import { serialiseExport } from './serialise.js';

const EVENT: FireEvent = {
  id: 'fw-2026-q7f3d',
  seq: 4,
  status: 'active',
  scoreBucket: 'likely',
  mergedInto: null,
  lon: 25.9,
  lat: 41.9,
  firstObservedAt: '2026-08-09T11:02:00+03:00',
  lastObservedAt: '2026-08-09T11:14:00Z',
  detectionCount: 7,
  placeNameBg: 'Сакар',
  placeNameEn: 'Sakar',
  areaHa: null,
  nextPassWindow: null,
  sourceIds: ['firms:viirs:snpp'],
};

const context = (locale: 'bg' | 'en'): ExportContext => ({
  messages: locale === 'bg' ? bg : en,
  locale,
  generatedAtMs: Date.UTC(2026, 7, 9, 12, 0, 0, 500),
  credit: { year: 2026, productName: 'Fire Watch' },
});

const DETECTIONS_FILE = {
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [25.91, 41.91] },
      properties: {
        uid: 'b',
        observed_at: '2026-08-09T11:14:00Z',
        source_id: 'firms:viirs:snpp',
        scan_km: 0.4,
        track_km: 0.38,
        frp_mw: 12.5,
      },
    },
    {
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [25.92, 41.92] },
      properties: {
        uid: 'a',
        observed_at: '2026-08-09T11:14:00Z',
        source_id: 'firms:viirs:snpp',
        scan_km: null,
        track_km: null,
        frp_mw: -1,
      },
    },
    {
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [25.9, 41.9] },
      properties: {
        uid: 'c',
        observed_at: '2026-08-09T10:02:00+02:00',
        source_id: 'lsasaf:fci:frp-pixel',
        frp_mw: 30,
      },
    },
    // Unusable rows: dropped, never repaired.
    {
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [200, 41] },
      properties: { uid: 'x', observed_at: '2026-08-09T11:00:00Z', source_id: 's' },
    },
    {
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [25, 41] },
      properties: { uid: 'y', observed_at: 'later', source_id: 's' },
    },
    {
      type: 'Feature',
      geometry: null,
      properties: { uid: 'z', observed_at: '2026-08-09T11:00:00Z', source_id: 's' },
    },
    null,
  ],
};

describe('eventsDocument', () => {
  it('labels every row a satellite detection event and never a confirmed fire', () => {
    const document = eventsDocument([EVENT], context('en'));
    const values = new Map(document.records[0]?.properties);
    expect(values.get('record_type')).toBe(EVENT_RECORD_TYPE);
    expect(document.notice).toBe(en.dataExport.notice);
    expect(document.notice).toMatch(/not confirmed fires/u);
    for (const format of ['geojson', 'kml', 'csv'] as const) {
      const text = serialiseExport(document, format);
      expect(text).not.toMatch(/confirmed_fire|"confirmed"/u);
      expect(text).toContain(en.dataExport.notice.slice(0, 40));
    }
  });

  it('writes times as ISO UTC and the generation time without milliseconds', () => {
    const document = eventsDocument([EVENT], context('en'));
    const values = new Map(document.records[0]?.properties);
    expect(values.get('first_observed_utc')).toBe('2026-08-09T08:02:00Z');
    expect(values.get('last_observed_utc')).toBe('2026-08-09T11:14:00Z');
    expect(document.generatedAt).toBe('2026-08-09T12:00:00Z');
    expect(document.records[0]?.time).toEqual({
      begin: '2026-08-09T08:02:00Z',
      end: '2026-08-09T11:14:00Z',
    });
  });

  it('localises the title and name but keeps both place names and English column keys', () => {
    const document = eventsDocument([EVENT], context('bg'));
    expect(document.title).toBe(bg.dataExport.eventsTitle);
    expect(document.records[0]?.name).toBe(bg.eventNearPlace('Сакар'));
    const values = new Map(document.records[0]?.properties);
    expect(values.get('place_bg')).toBe('Сакар');
    expect(values.get('place_en')).toBe('Sakar');
    expect(document.columns).toEqual(eventsDocument([EVENT], context('en')).columns);
  });

  it('narrows the attribution to the sources the events name, failing open without them', () => {
    const narrowed = eventsDocument([EVENT], context('en')).attribution.map((line) => line.id);
    expect(narrowed).toContain('firms-acknowledgement');
    expect(narrowed).not.toContain('lsa-saf-long');
    const { sourceIds: _dropped, ...withoutSources } = EVENT;
    const full = eventsDocument([withoutSources], context('en')).attribution.map((l) => l.id);
    expect(full).toContain('lsa-saf-long');
    expect(eventsDocument([EVENT], context('en')).records[0]?.properties).toContainEqual([
      'source_ids',
      'firms:viirs:snpp',
    ]);
  });
});

describe('parseExportDetections', () => {
  it('keeps valid rows oldest first, uid as tiebreak, and drops the rest', () => {
    const rows = parseExportDetections(DETECTIONS_FILE);
    expect(rows.map((row) => row.uid)).toEqual(['c', 'a', 'b']);
    expect(rows[0]?.observedAt).toBe('2026-08-09T08:02:00Z');
  });

  it('keeps a missing or negative FRP empty rather than inventing a value', () => {
    const rows = parseExportDetections(DETECTIONS_FILE);
    expect(rows.find((row) => row.uid === 'a')?.frpMw).toBeNull();
    expect(rows.find((row) => row.uid === 'b')?.frpMw).toBe(12.5);
    expect(rows.find((row) => row.uid === 'c')?.scanKm).toBeNull();
  });

  it('returns nothing for a non-collection', () => {
    expect(parseExportDetections(null)).toEqual([]);
    expect(parseExportDetections({ features: 'no' })).toEqual([]);
  });
});

describe('detectionsDocument', () => {
  const rows = parseExportDetections(DETECTIONS_FILE);

  it('makes one satellite detection row per pixel, tied to the event', () => {
    const document = detectionsDocument(EVENT, rows, context('en'));
    expect(document.title).toBe(en.dataExport.detectionsTitle('Sakar'));
    expect(document.records).toHaveLength(3);
    for (const record of document.records) {
      const values = new Map(record.properties);
      expect(values.get('record_type')).toBe(DETECTION_RECORD_TYPE);
      expect(values.get('event_id')).toBe(EVENT.id);
      expect(record.time?.begin).toBe(record.time?.end);
    }
  });

  it('credits every source the detections came from', () => {
    const lines = detectionsDocument(EVENT, rows, context('en')).attribution.map((l) => l.id);
    expect(lines).toContain('firms-acknowledgement');
    expect(lines).toContain('lsa-saf-long');
    expect(lines).not.toContain('sentinel-modified');
  });

  it('is byte-for-byte deterministic', () => {
    const one = serialiseExport(detectionsDocument(EVENT, rows, context('bg')), 'csv');
    const two = serialiseExport(
      detectionsDocument(
        EVENT,
        parseExportDetections(structuredClone(DETECTIONS_FILE)),
        context('bg'),
      ),
      'csv',
    );
    expect(one).toBe(two);
  });
});

describe('exportFileName', () => {
  it('stamps the UTC time and keeps the name file-system safe', () => {
    expect(exportFileName('events', Date.UTC(2026, 7, 9, 12, 0, 0), 'csv')).toBe(
      'fire-watch-events-20260809T120000Z.csv',
    );
    expect(exportFileName('fw/2026 ../x', 0, 'kml')).toBe(
      'fire-watch-fw-2026-x-19700101T000000Z.kml',
    );
  });
});
