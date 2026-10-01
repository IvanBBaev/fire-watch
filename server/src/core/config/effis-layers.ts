/**
 * `effis_layers_v2` — which EFFIS layers we proxy and how each one is judged
 * (TASKS C4; DATA-SOURCES §D1; ADR-001 A1.2/A2.2).
 *
 * v2 (2026-09-28) replaces the v1 layer names, which the live mapserver no longer routes:
 * `ecmwf007.fwi` answers `LayerNotDefined` (a ServiceException the A2.2 gate rejects on
 * every refresh) and `EFFIS:BurntAreas7Days` is a GeoServer name the mapserver answers
 * with a 502 — so v1 could never produce a servable copy. Resolved from the live
 * GetCapabilities, as review 03 §190 asks: the fire-danger layers are `mf010.*` and
 * require a `TIME` (without one the mapserver returns an empty 200), and the 7-day burnt
 * areas are `modis.ba.poly.week` over the mapserver's WFS 1.1.0 with its `geojson`
 * output format.
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
  /**
   * The media type the proxy serves the payload as. Not always `requestFormat`: the
   * mapserver's WFS names its GeoJSON output `geojson`, which is no media type.
   */
  readonly servedMediaType: string;
  /**
   * `daily` when the layer has a `TIME` dimension that must be asked for explicitly:
   * the query then carries the UTC date the refresh ran on, and that date is what the
   * payload is valid for. `null` for a layer that is simply "the latest".
   */
  readonly time: 'daily' | null;
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
  'effis_layers_v2',
  {
    wmsWidth: 1100,
    wmsHeight: 700,
    layers: [
      {
        id: 'fwi',
        service: 'wms',
        layerName: 'mf010.fwi',
        requestFormat: 'image/png',
        acceptedMediaTypes: ['image/png'],
        // The A2.2 default. A real FWI raster over an 11°×7° box is tens of kilobytes;
        // a blank or single-colour PNG compresses well under this.
        byteFloorBytes: 1024,
        extension: 'png',
        servedMediaType: 'image/png',
        time: 'daily',
      },
      {
        id: 'ba',
        service: 'wfs',
        layerName: 'modis.ba.poly.week',
        // The mapserver's own name for its GeoJSON output; it answers
        // `application/json; subtype=geojson`, which the media-type gate reads parameter-free.
        requestFormat: 'geojson',
        acceptedMediaTypes: ['application/json', 'application/geo+json'],
        // Deliberately low: an *empty* FeatureCollection is ~40 bytes of legitimate
        // off-season JSON. The floor only has to catch empty and near-empty bodies;
        // an HTML error page is caught by the media-type gate above it.
        byteFloorBytes: 32,
        extension: 'json',
        servedMediaType: 'application/json',
        time: null,
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
 * does not error; it asks for a box in the Indian Ocean and caches an empty layer. The
 * mapserver's WFS 1.1.0 honours the same latitude-first order under the URN (verified
 * against the live service: the longitude-first box returns zero features).
 *
 * A `daily` layer needs `date` (UTC `YYYY-MM-DD`, the refresh's own clock): without a
 * `TIME` the mapserver answers an empty 200 or its years-old default, never "today".
 */
export function effisLayerQuery(
  spec: EffisLayerSpec,
  values: EffisLayersValues = EFFIS_LAYERS.values,
  bbox: BoundingBox = POLLING_BBOX.values,
  date?: string,
): Readonly<Record<string, string>> {
  assertBoundingBox(bbox);
  if (spec.time === 'daily' && (date === undefined || !EFFIS_DATE_RE.test(date))) {
    throw new RangeError(
      `EFFIS layer ${spec.id} is daily and needs a YYYY-MM-DD date, got ${JSON.stringify(date)}`,
    );
  }
  const time = spec.time === 'daily' && date !== undefined ? { TIME: date } : {};
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
      ...time,
    });
  }
  return Object.freeze({
    SERVICE: 'WFS',
    // The mapserver's WFS speaks 1.0.0/1.1.0 only; a 2.0.0 GetFeature is answered 502.
    VERSION: '1.1.0',
    REQUEST: 'GetFeature',
    TYPENAME: spec.layerName,
    SRSNAME: 'urn:ogc:def:crs:EPSG::4326',
    BBOX: `${latLonBbox},urn:ogc:def:crs:EPSG::4326`,
    OUTPUTFORMAT: spec.requestFormat,
    ...time,
  });
}

/** A UTC calendar date, the form a daily layer's `TIME` takes. */
export const EFFIS_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** The UTC calendar date of an instant — what a daily layer is asked for. */
export function effisUtcDate(epochMs: number): string {
  return new Date(epochMs).toISOString().slice(0, 10);
}
