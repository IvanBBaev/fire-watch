import { describe, expect, it } from 'vitest';

import { EFFIS_LAYERS, effisLayerQuery, effisUtcDate } from './effis-layers.js';

const layer = (id: string) => {
  const found = EFFIS_LAYERS.values.layers.find((spec) => spec.id === id);
  if (found === undefined) throw new Error(`no layer ${id} in EFFIS_LAYERS`);
  return found;
};

describe('EFFIS_LAYERS', () => {
  it('names the layers DATA-SOURCES §D1 documents', () => {
    // The strings the EFFIS mapserver actually routes on. A typo here is not an error
    // response — it is a ServiceException the sanity gate rejects on every refresh.
    // v2: `ecmwf007.fwi` / `EFFIS:BurntAreas7Days` (v1) are not routed by the live
    // mapserver (LayerNotDefined / 502) — resolved from GetCapabilities on 2026-09-28.
    expect(layer('fwi').layerName).toBe('mf010.fwi');
    expect(layer('ba').layerName).toBe('modis.ba.poly.week');
  });

  it('is versioned so the provenance sidecars can cite it', () => {
    expect(EFFIS_LAYERS.version).toBe('effis_layers_v2');
    expect(EFFIS_LAYERS.digest).toMatch(/^[0-9a-f]{8}$/);
  });

  it('keeps the BA floor below an empty off-season FeatureCollection', () => {
    // `{"type":"FeatureCollection","features":[]}` is ~42 bytes of legitimate winter.
    // The floor must sit under it, or every quiet week becomes a suspect-size alert.
    expect(layer('ba').byteFloorBytes).toBeLessThan(
      '{"type":"FeatureCollection","features":[]}'.length,
    );
  });
});

describe('effisLayerQuery', () => {
  it('renders the WMS 1.3.0 bbox latitude-first', () => {
    // The classic axis-order trap: EPSG:4326 under WMS 1.3.0 is south,west,north,east.
    // Getting it wrong is not an error — it is an empty raster over the Indian Ocean,
    // cached as good forever. This is the regression test for that.
    const query = effisLayerQuery(layer('fwi'), undefined, undefined, '2026-09-28');
    expect(query['BBOX']).toBe('39,20,46,31');
    expect(query['VERSION']).toBe('1.3.0');
    expect(query['CRS']).toBe('EPSG:4326');
    expect(query['LAYERS']).toBe('mf010.fwi');
    expect(query['TIME']).toBe('2026-09-28');
    expect(query['FORMAT']).toBe('image/png');
    expect(query['WIDTH']).toBe('1100');
    expect(query['HEIGHT']).toBe('700');
  });

  it('renders the WFS bbox latitude-first with the CRS URN attached', () => {
    const query = effisLayerQuery(layer('ba'));
    expect(query['BBOX']).toBe('39,20,46,31,urn:ogc:def:crs:EPSG::4326');
    expect(query['SRSNAME']).toBe('urn:ogc:def:crs:EPSG::4326');
    // The mapserver's WFS speaks 1.1.0 (TYPENAME, singular); 2.0.0 is answered 502.
    expect(query['VERSION']).toBe('1.1.0');
    expect(query['TYPENAME']).toBe('modis.ba.poly.week');
    expect(query['OUTPUTFORMAT']).toBe('geojson');
    expect(query['TIME']).toBeUndefined();
  });

  it('refuses a daily layer without a date — no TIME means an empty or years-old answer', () => {
    expect(() => effisLayerQuery(layer('fwi'))).toThrow(RangeError);
    expect(() => effisLayerQuery(layer('fwi'), undefined, undefined, '28.09.2026')).toThrow(
      RangeError,
    );
  });

  it('serves the WFS output as a real media type, not the mapserver format name', () => {
    expect(layer('ba').servedMediaType).toBe('application/json');
    expect(layer('fwi').servedMediaType).toBe('image/png');
  });

  it('asks a daily layer for the UTC calendar date of the refresh', () => {
    // 23:30 in Sofia on the 28th is still the 28th in UTC; 00:30 Sofia on the 29th is not.
    expect(effisUtcDate(Date.UTC(2026, 8, 28, 20, 30))).toBe('2026-09-28');
    expect(effisUtcDate(Date.UTC(2026, 8, 28, 21, 30))).toBe('2026-09-28');
  });

  it('refuses a malformed bounding box instead of asking EFFIS for one', () => {
    expect(() =>
      effisLayerQuery(
        layer('fwi'),
        EFFIS_LAYERS.values,
        { west: 31, south: 39, east: 20, north: 46 },
        '2026-09-28',
      ),
    ).toThrow();
  });
});
