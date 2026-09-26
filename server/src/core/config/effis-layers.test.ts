import { describe, expect, it } from 'vitest';

import { EFFIS_LAYERS, effisLayerQuery } from './effis-layers.js';

const layer = (id: string) => {
  const found = EFFIS_LAYERS.values.layers.find((spec) => spec.id === id);
  if (found === undefined) throw new Error(`no layer ${id} in EFFIS_LAYERS`);
  return found;
};

describe('EFFIS_LAYERS', () => {
  it('names the layers DATA-SOURCES §D1 documents', () => {
    // The strings the EFFIS mapserver actually routes on. A typo here is not an error
    // response — it is a ServiceException the sanity gate rejects on every refresh.
    expect(layer('fwi').layerName).toBe('ecmwf007.fwi');
    expect(layer('ba').layerName).toBe('EFFIS:BurntAreas7Days');
  });

  it('is versioned so the provenance sidecars can cite it', () => {
    expect(EFFIS_LAYERS.version).toBe('effis_layers_v1');
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
    const query = effisLayerQuery(layer('fwi'));
    expect(query['BBOX']).toBe('39,20,46,31');
    expect(query['VERSION']).toBe('1.3.0');
    expect(query['CRS']).toBe('EPSG:4326');
    expect(query['LAYERS']).toBe('ecmwf007.fwi');
    expect(query['FORMAT']).toBe('image/png');
    expect(query['WIDTH']).toBe('1100');
    expect(query['HEIGHT']).toBe('700');
  });

  it('renders the WFS bbox latitude-first with the CRS URN attached', () => {
    const query = effisLayerQuery(layer('ba'));
    expect(query['BBOX']).toBe('39,20,46,31,urn:ogc:def:crs:EPSG::4326');
    expect(query['SRSNAME']).toBe('urn:ogc:def:crs:EPSG::4326');
    expect(query['TYPENAMES']).toBe('EFFIS:BurntAreas7Days');
    expect(query['OUTPUTFORMAT']).toBe('application/json');
  });

  it('refuses a malformed bounding box instead of asking EFFIS for one', () => {
    expect(() =>
      effisLayerQuery(layer('fwi'), EFFIS_LAYERS.values, {
        west: 31,
        south: 39,
        east: 20,
        north: 46,
      }),
    ).toThrow();
  });
});
