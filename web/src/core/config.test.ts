import { describe, expect, it } from 'vitest';

import { parseDetectionsGeoJson } from '../map/geojson.js';
import { parseDetectionDetail } from '../ui/event/detection-detail.js';
import { activeBasemap } from './basemap.js';
import {
  DEFAULT_CONFIG,
  LIVE_DETECTIONS_URL_TEMPLATE,
  readLocalTiles,
  withDataSource,
  withLocalTiles,
} from './config.js';

/**
 * A body exactly as `GET /api/v1/events/:publicId/detections` writes it (server
 * `event-detections-route.ts`): a 64-hex uid, `confidence`, and a member without FRP or
 * footprint, which the route omits rather than sending `null`.
 */
const ROUTE_BODY = {
  type: 'FeatureCollection',
  schema_version: 1,
  event_id: 'fw-2026-b2n5c',
  merged_into: null,
  generated_at: '2026-08-05T12:00:00Z',
  truncated: false,
  features: [
    {
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [27.51634, 41.97712] },
      properties: {
        uid: '0'.repeat(63) + '1',
        observed_at: '2026-08-05T03:01:00Z',
        source_id: 'firms:viirs:noaa21',
        confidence: 'nominal',
      },
    },
    {
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [27.5171, 41.9779] },
      properties: {
        uid: '0'.repeat(63) + '2',
        observed_at: '2026-08-05T03:02:00Z',
        source_id: 'firms:viirs:noaa21',
        confidence: 'high',
        scan_km: 0.42,
        track_km: 0.41,
        frp_mw: 9.8,
      },
    },
  ],
  attribution: [],
};

describe('withDataSource', () => {
  it('leaves the fixture config untouched', () => {
    expect(withDataSource(DEFAULT_CONFIG, 'fixtures')).toBe(DEFAULT_CONFIG);
  });

  it('points live mode at the API snapshot and the per-event detections route', () => {
    const live = withDataSource(DEFAULT_CONFIG, 'live');
    expect(live.snapshotUrl).toBe('/snapshot.json');
    expect(live.detectionsUrlTemplate).toBe(LIVE_DETECTIONS_URL_TEMPLATE);
    expect(LIVE_DETECTIONS_URL_TEMPLATE.replace('{id}', 'fw-2026-b2n5c')).toBe(
      '/api/v1/events/fw-2026-b2n5c/detections',
    );
  });
});

describe('local tiles (TASKS G3)', () => {
  const origin = 'http://localhost:5173';

  it('leaves the config untouched without the env value, so the default basemap stays', () => {
    expect(readLocalTiles(undefined, origin)).toBeNull();
    expect(readLocalTiles('', origin)).toBeNull();
    expect(withLocalTiles(DEFAULT_CONFIG, null)).toBe(DEFAULT_CONFIG);
    expect(activeBasemap(DEFAULT_CONFIG.basemapStyleUrl, DEFAULT_CONFIG.outdoorBasemap).kind).toBe(
      'external',
    );
  });

  it('draws the outdoor style from the dev server when the prefix is set on loopback', () => {
    const local = readLocalTiles('/__local-tiles', origin);
    expect(local).toEqual({
      tilesUrl: 'http://localhost:5173/__local-tiles/tiles/{z}/{x}/{y}.mvt',
      glyphsUrl: 'http://localhost:5173/__local-tiles/fonts/{fontstack}/{range}.pbf',
      demTilesUrl: null,
      maxzoom: 14,
    });
    const config = withLocalTiles(DEFAULT_CONFIG, local);
    expect(activeBasemap(config.basemapStyleUrl, config.outdoorBasemap).kind).toBe('outdoor');
    expect(readLocalTiles('/__local-tiles', 'http://127.0.0.1:4173')?.tilesUrl).toMatch(
      /^http:\/\/127\.0\.0\.1:4173\//,
    );
  });

  it('never points a non-loopback page, or a value that is not a plain path, at local tiles', () => {
    expect(readLocalTiles('/__local-tiles', 'https://firewatch.example')).toBeNull();
    expect(readLocalTiles('/__local-tiles', 'http://192.168.1.5:5173')).toBeNull();
    expect(readLocalTiles('https://evil.example/x', origin)).toBeNull();
    expect(readLocalTiles('/a/../b', origin)).toBeNull();
    expect(readLocalTiles('/__local-tiles', 'https://firewatch.example', '1')).toBeNull();
  });

  it('adds the local DEM only when the dev server says it serves one, and the terrain credit follows', () => {
    expect(readLocalTiles('/__local-tiles', origin)?.demTilesUrl).toBeNull();
    expect(readLocalTiles('/__local-tiles', origin, 'yes')?.demTilesUrl).toBeNull();
    const local = readLocalTiles('/__local-tiles', origin, '1');
    expect(local?.demTilesUrl).toBe(
      'http://localhost:5173/__local-tiles/dem/terrarium/{z}/{x}/{y}.png',
    );
    const config = withLocalTiles(DEFAULT_CONFIG, local);
    expect(activeBasemap(config.basemapStyleUrl, config.outdoorBasemap)).toMatchObject({
      kind: 'outdoor',
      terrain: true,
    });
  });
});

describe('the live detections route body', () => {
  it('parses into map detections, every member kept', () => {
    const detections = parseDetectionsGeoJson(ROUTE_BODY);
    expect(detections).toHaveLength(2);
    expect(detections[0]).toMatchObject({
      uid: '0'.repeat(63) + '1',
      sourceId: 'firms:viirs:noaa21',
    });
  });

  it('parses into detail rows, with FRP only where the route sent it', () => {
    const rows = parseDetectionDetail(ROUTE_BODY);
    expect(rows.map((row) => row.frpMw)).toEqual([null, 9.8]);
  });
});
