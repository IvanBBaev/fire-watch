/**
 * `effis_layers_v1` — which EFFIS layers we proxy and how each one is judged
 * (TASKS C4; DATA-SOURCES §D1; ADR-001 A1.2/A2.2).
 *
 * Config-as-data for the same reason the polling bbox is: the refresh's provenance
 * sidecars record the version they ran under, and re-calibrating a byte floor (A2.2
 * says per-layer, calibrated against real minimal responses) must be a visible version
 * bump, not a silent edit that makes yesterday's "suspect" today's "good".
 *
 * The A2.2 knobs live *here* per layer because the two layers fail differently: a
 * one-colour FWI PNG compresses to almost nothing, and an empty burnt-area
 * FeatureCollection outside the season is a few dozen bytes of legitimate JSON — one
 * floor for both would either miss blank rasters or cry wolf every winter.
 */

import { POLLING_BBOX, assertBoundingBox, type BoundingBox } from './polling-bbox.js';
import { defineConfig, type VersionedConfig } from './versioned-config.js';

export type EffisLayerId = 'fwi' | 'ba';

export interface EffisLayerSpec {
  readonly id: EffisLayerId;
  readonly service: 'wms' | 'wfs';
  /** The layer name as the EFFIS mapserver knows it (DATA-SOURCES §D1). */
  readonly layerName: string;
  /** What we ask for — WMS `FORMAT` / WFS `OUTPUTFORMAT`. */
  readonly requestFormat: string;
  /**
   * Media types a good body may carry, lowercased and parameter-free. A2.2: a body
   * whose Content-Type is not in this list is treated exactly like an HTTP 5xx.
   */
  readonly acceptedMediaTypes: readonly string[];
  /** A2.2 byte floor: a 200 below it is never cached as good. */
  readonly byteFloorBytes: number;
  /** File extension of the recorded payload. */
  readonly extension: string;
}

export interface EffisLayersValues {
  /**
   * Raster size for WMS GetMap. ~0.01°/px over the polling bbox — comfortably finer
   * than the ~8 km FWI grid, so the raster never limits what the data can show.
   */
  readonly wmsWidth: number;
  readonly wmsHeight: number;
  readonly layers: readonly EffisLayerSpec[];
}

export const EFFIS_LAYERS: VersionedConfig<EffisLayersValues> = defineConfig(
  'effis_layers',
  'effis_layers_v1',
  {
    wmsWidth: 1100,
    wmsHeight: 700,
    layers: [
      {
        id: 'fwi',
        service: 'wms',
        layerName: 'ecmwf007.fwi',
        requestFormat: 'image/png',
        acceptedMediaTypes: ['image/png'],
        // The A2.2 default. A real FWI raster over an 11°×7° box is tens of kilobytes;
        // a blank or single-colour PNG compresses well under this.
        byteFloorBytes: 1024,
        extension: 'png',
      },
      {
        id: 'ba',
        service: 'wfs',
        layerName: 'EFFIS:BurntAreas7Days',
        requestFormat: 'application/json',
        // GeoServer labels GeoJSON either way depending on version.
        acceptedMediaTypes: ['application/json', 'application/geo+json'],
        // Deliberately low: an *empty* FeatureCollection is ~40 bytes of legitimate
        // off-season JSON. The floor only has to catch empty and near-empty bodies;
        // an HTML error page is caught by the media-type gate above it.
        byteFloorBytes: 32,
        extension: 'json',
      },
    ],
  } as const,
);

/**
 * The full query for one layer, as ordered pairs — the adapter serializes them in this
 * exact order, so the recorded query in the provenance sidecar is the query on the wire.
 *
 * Axis order is the classic WMS 1.3.0 trap and the reason this is rendered from config
 * rather than written at a call site: with `CRS=EPSG:4326` the 1.3.0 spec (and the WFS
 * 2.0 URN form) order the bbox **latitude first** — `south,west,north,east` — which is
 * the opposite of the FIRMS argument and of what most GIS tools print. Getting it wrong
 * does not error; it asks for a box in the Indian Ocean and caches an empty layer.
 */
export function effisLayerQuery(
  spec: EffisLayerSpec,
  values: EffisLayersValues = EFFIS_LAYERS.values,
  bbox: BoundingBox = POLLING_BBOX.values,
): Readonly<Record<string, string>> {
  assertBoundingBox(bbox);
  const latLonBbox = [bbox.south, bbox.west, bbox.north, bbox.east].map(String).join(',');
  if (spec.service === 'wms') {
    return Object.freeze({
      SERVICE: 'WMS',
      VERSION: '1.3.0',
      REQUEST: 'GetMap',
      LAYERS: spec.layerName,
      STYLES: '',
      CRS: 'EPSG:4326',
      BBOX: latLonBbox,
      WIDTH: String(values.wmsWidth),
      HEIGHT: String(values.wmsHeight),
      FORMAT: spec.requestFormat,
      TRANSPARENT: 'TRUE',
    });
  }
  return Object.freeze({
    SERVICE: 'WFS',
    VERSION: '2.0.0',
    REQUEST: 'GetFeature',
    TYPENAMES: spec.layerName,
    SRSNAME: 'urn:ogc:def:crs:EPSG::4326',
    BBOX: `${latLonBbox},urn:ogc:def:crs:EPSG::4326`,
    OUTPUTFORMAT: spec.requestFormat,
  });
}
