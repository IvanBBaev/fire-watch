import { describe, expect, it } from 'vitest';

import { NADIR_SCAN_KM, NADIR_TRACK_KM, footprintRing } from '../core/geo/footprint.js';
import type { Detection, FireEvent, StoreState } from '../core/types.js';
import type { DetectionGroup } from './geojson.js';
import {
  buildDetectionCellsCollection,
  buildDetectionsCollection,
  buildFireEventsCollection,
  emptyFeatureCollection,
  parseDetectionsGeoJson,
} from './geojson.js';

function makeEvent(overrides: Partial<FireEvent> & Pick<FireEvent, 'id'>): FireEvent {
  return {
    seq: 1042,
    status: 'active',
    scoreBucket: 'confirmed',
    mergedInto: null,
    lon: 25.9,
    lat: 41.93,
    firstObservedAt: '2026-08-07T11:14:00Z',
    lastObservedAt: '2026-08-09T09:47:00Z',
    detectionCount: 14,
    placeNameBg: 'Харманли',
    placeNameEn: 'Harmanli',
    areaHa: 320,
    nextPassWindow: null,
    ...overrides,
  };
}

function makeState(events: readonly FireEvent[]): StoreState {
  return {
    events: new Map(events.map((event) => [event.id, event])),
    maxSeq: 1042,
    lastSnapshotAt: '2026-08-09T09:58:00Z',
    freshness: null,
    feedStatus: 'live',
    needsSnapshot: false,
    sources: [],
  };
}

describe('buildFireEventsCollection', () => {
  it('keys features on the public id and carries no uuid', () => {
    const event = makeEvent({ id: 'fw-2026-q7f3d' });
    const collection = buildFireEventsCollection(makeState([event]));

    expect(collection.features).toHaveLength(1);
    const feature = collection.features[0];
    expect(feature?.id).toBe('fw-2026-q7f3d');
    expect(feature?.properties.id).toBe('fw-2026-q7f3d');
    expect(JSON.stringify(collection)).not.toContain('uuid');
  });

  it('carries status, score_bucket and area_ha as snake_case properties', () => {
    const event = makeEvent({
      id: 'fw-2026-b2n5c',
      status: 'signal_weakening',
      scoreBucket: 'likely',
      areaHa: 85,
      lon: 27.52,
      lat: 41.98,
    });
    const feature = buildFireEventsCollection(makeState([event])).features[0];

    expect(feature?.geometry).toEqual({ type: 'Point', coordinates: [27.52, 41.98] });
    expect(feature?.properties).toEqual({
      id: 'fw-2026-b2n5c',
      status: 'signal_weakening',
      score_bucket: 'likely',
      area_ha: 85,
    });
  });

  it('keeps a null area_ha as null (layer expressions coalesce it)', () => {
    const event = makeEvent({ id: 'fw-2026-x4k6m', areaHa: null });
    const feature = buildFireEventsCollection(makeState([event])).features[0];
    expect(feature?.properties.area_ha).toBeNull();
  });

  it('excludes plain archived events — history does not render', () => {
    const archived = makeEvent({ id: 'fw-2026-n6j5d', status: 'archived' });
    const active = makeEvent({ id: 'fw-2026-q7f3d' });
    const collection = buildFireEventsCollection(makeState([archived, active]));

    expect(collection.features.map((feature) => feature.id)).toEqual(['fw-2026-q7f3d']);
  });

  it('excludes merge tombstones — the survivor is the only rendered identity', () => {
    const tombstone = makeEvent({
      id: 'fw-2026-z7c3f',
      status: 'archived',
      mergedInto: 'fw-2026-q7f3d',
    });
    const survivor = makeEvent({ id: 'fw-2026-q7f3d' });
    const collection = buildFireEventsCollection(makeState([tombstone, survivor]));

    expect(collection.features.map((feature) => feature.id)).toEqual(['fw-2026-q7f3d']);
  });

  it('renders every non-archived lifecycle state', () => {
    const events = [
      makeEvent({ id: 'fw-2026-a', status: 'active' }),
      makeEvent({ id: 'fw-2026-b', status: 'signal_weakening' }),
      makeEvent({ id: 'fw-2026-c', status: 'no_longer_detected' }),
      makeEvent({ id: 'fw-2026-d', status: 'officially_contained' }),
      makeEvent({ id: 'fw-2026-e', status: 'officially_extinguished' }),
    ];
    expect(buildFireEventsCollection(makeState(events)).features).toHaveLength(5);
  });
});

function makeDetection(overrides: Partial<Detection> = {}): Detection {
  return {
    uid: 'det-q7f3d-001',
    lon: 25.897,
    lat: 41.928,
    observedAt: '2026-08-09T00:52:00Z',
    sourceId: 'firms:viirs:snpp',
    scanKm: null,
    trackKm: null,
    ...overrides,
  };
}

function makeGroup(overrides: Partial<DetectionGroup> = {}): DetectionGroup {
  return {
    eventId: 'fw-2026-q7f3d',
    status: 'active',
    scoreBucket: 'confirmed',
    detections: [makeDetection()],
    ...overrides,
  };
}

describe('buildDetectionsCollection', () => {
  it('maps detections to snake_case wire-shaped features', () => {
    const collection = buildDetectionsCollection([makeGroup()]);

    expect(collection.features).toEqual([
      {
        type: 'Feature',
        id: 'det-q7f3d-001',
        geometry: { type: 'Point', coordinates: [25.897, 41.928] },
        properties: {
          uid: 'det-q7f3d-001',
          id: 'fw-2026-q7f3d',
          status: 'active',
          score_bucket: 'confirmed',
          observed_at: '2026-08-09T00:52:00Z',
          source_id: 'firms:viirs:snpp',
        },
      },
    ]);
  });

  it('stamps each detection with its own parent, so two events never share a colour', () => {
    const collection = buildDetectionsCollection([
      makeGroup(),
      makeGroup({
        eventId: 'fw-2026-old',
        status: 'no_longer_detected',
        scoreBucket: 'likely',
        detections: [makeDetection({ uid: 'det-old-001' })],
      }),
    ]);

    expect(
      collection.features.map((feature) => [
        feature.properties.id,
        feature.properties.status,
        feature.properties.score_bucket,
      ]),
    ).toEqual([
      ['fw-2026-q7f3d', 'active', 'confirmed'],
      ['fw-2026-old', 'no_longer_detected', 'likely'],
    ]);
  });

  it('builds an empty collection from no groups', () => {
    expect(buildDetectionsCollection([])).toEqual(emptyFeatureCollection());
  });

  it('builds an empty collection from a group with no detections', () => {
    expect(buildDetectionsCollection([makeGroup({ detections: [] })])).toEqual(
      emptyFeatureCollection(),
    );
  });
});

describe('buildDetectionCellsCollection', () => {
  it('draws each detection as the cell the instrument integrated over', () => {
    const collection = buildDetectionCellsCollection([
      makeGroup({ detections: [makeDetection({ scanKm: 0.375, trackKm: 0.375 })] }),
    ]);

    expect(collection.features).toEqual([
      {
        type: 'Feature',
        id: 'det-q7f3d-001',
        geometry: {
          type: 'Polygon',
          coordinates: [footprintRing(25.897, 41.928, { scanKm: 0.375, trackKm: 0.375 })],
        },
        properties: {
          uid: 'det-q7f3d-001',
          id: 'fw-2026-q7f3d',
          status: 'active',
          score_bucket: 'confirmed',
          observed_at: '2026-08-09T00:52:00Z',
          source_id: 'firms:viirs:snpp',
        },
      },
    ]);
  });

  it('falls back to the nadir cell when the row carries no usable extent', () => {
    const collection = buildDetectionCellsCollection([makeGroup()]);

    expect(collection.features[0]?.geometry.coordinates).toEqual([
      footprintRing(25.897, 41.928, { scanKm: NADIR_SCAN_KM, trackKm: NADIR_TRACK_KM }),
    ]);
  });

  it('emits one cell per detection and never a hull over them', () => {
    const collection = buildDetectionCellsCollection([
      makeGroup({
        detections: [
          makeDetection({ uid: 'det-1' }),
          makeDetection({ uid: 'det-2', lon: 25.94, lat: 41.96 }),
          makeDetection({ uid: 'det-3', lon: 25.86, lat: 41.9 }),
        ],
      }),
    ]);

    expect(collection.features).toHaveLength(3);
    expect(collection.features.map((feature) => feature.id)).toEqual(['det-1', 'det-2', 'det-3']);
  });

  it('carries the same properties as the point layer, so both select the same event', () => {
    const [point] = buildDetectionsCollection([makeGroup()]).features;
    const [cell] = buildDetectionCellsCollection([makeGroup()]).features;

    expect(cell?.properties).toEqual(point?.properties);
  });

  it('builds an empty collection from no groups', () => {
    expect(buildDetectionCellsCollection([])).toEqual(emptyFeatureCollection());
  });
});

describe('parseDetectionsGeoJson', () => {
  const validFeature = {
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [25.897, 41.928] },
    properties: {
      uid: 'det-q7f3d-001',
      observed_at: '2026-08-09T00:52:00Z',
      source_id: 'firms:viirs:snpp',
    },
  };

  it('parses the wire fixture shape into flat detections', () => {
    const detections = parseDetectionsGeoJson({
      type: 'FeatureCollection',
      event_id: 'fw-2026-q7f3d',
      features: [
        {
          ...validFeature,
          properties: { ...validFeature.properties, scan_km: 0.42, track_km: 0.38 },
        },
      ],
    });

    expect(detections).toEqual([
      {
        uid: 'det-q7f3d-001',
        lon: 25.897,
        lat: 41.928,
        observedAt: '2026-08-09T00:52:00Z',
        sourceId: 'firms:viirs:snpp',
        scanKm: 0.42,
        trackKm: 0.38,
      },
    ]);
  });

  it('keeps a detection whose footprint fields are absent — a missing extent is ordinary', () => {
    const [detection] = parseDetectionsGeoJson({
      type: 'FeatureCollection',
      features: [validFeature],
    });

    expect(detection?.uid).toBe('det-q7f3d-001');
    expect(detection?.scanKm).toBeNull();
    expect(detection?.trackKm).toBeNull();
  });

  it.each<[unknown, string]>([
    [null, 'null'],
    ['0.42', 'a string'],
    [Number.NaN, 'NaN'],
    [Number.POSITIVE_INFINITY, 'Infinity'],
  ])('reads a non-numeric scan_km (%s, %s) as null rather than dropping the row', (value) => {
    const [detection] = parseDetectionsGeoJson({
      type: 'FeatureCollection',
      features: [{ ...validFeature, properties: { ...validFeature.properties, scan_km: value } }],
    });

    expect(detection?.uid).toBe('det-q7f3d-001');
    expect(detection?.scanKm).toBeNull();
  });

  it.each<[unknown, string]>([
    [null, 'null'],
    [undefined, 'undefined'],
    ['{}', 'a string'],
    [42, 'a number'],
    [{}, 'no features member'],
    [{ features: 'nope' }, 'features not an array'],
  ])('returns [] for a malformed document: %s (%s)', (input) => {
    expect(parseDetectionsGeoJson(input)).toEqual([]);
  });

  it('skips malformed features but keeps the valid ones', () => {
    const detections = parseDetectionsGeoJson({
      type: 'FeatureCollection',
      features: [
        null,
        { geometry: null, properties: {} },
        { geometry: { type: 'Polygon', coordinates: [] }, properties: validFeature.properties },
        { geometry: { type: 'Point', coordinates: [25.9] }, properties: validFeature.properties },
        {
          geometry: { type: 'Point', coordinates: ['25.9', '41.9'] },
          properties: validFeature.properties,
        },
        {
          geometry: validFeature.geometry,
          properties: { uid: 'x', observed_at: 42, source_id: 's' },
        },
        { geometry: validFeature.geometry, properties: null },
        validFeature,
      ],
    });

    expect(detections).toHaveLength(1);
    expect(detections[0]?.uid).toBe('det-q7f3d-001');
  });
});
