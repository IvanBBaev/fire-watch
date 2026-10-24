/**
 * `effis_layers_v3` — which EFFIS layers we proxy and how each one is judged
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
 * v3 (2026-10-24, V2-B1) adds the FWI forecast days +1 … +9 (`fwi-d1` … `fwi-d9`). The
 * EFFIS mapserver's `mf010.fwi` only reaches three days ahead (a later `TIME` answers a
 * fully transparent 3065-byte PNG, verified 2026-10-23), so the forecast days come from
 * the same Copernicus service's GWIS mapserver (`…/gwis`, layer `ecmwf.fwi`), which carries
 * the ECMWF-driven FWI forecast for D0 … D9 and paints it with a legend byte-identical to
 * `mf010.fwi`'s (same six classes, same colours). Each forecast day is its own layer with
 * a fixed `leadDays`, so the `TIME` it is asked for is decided here from the refresh's
 * clock — the file name a reader asks for is the whole allow-list; no reader-supplied
 * date or parameter ever reaches the upstream.
 *
 * The A2.2 knobs live *here* per layer because the two layers fail differently: a
 * one-colour FWI PNG compresses to almost nothing, and an empty burnt-area
 * FeatureCollection outside the season is a few dozen bytes of legitimate JSON — one
 * floor for both would either miss blank rasters or cry wolf every winter.
 */

import { POLLING_BBOX, assertBoundingBox, type BoundingBox } from './polling-bbox.js';
import { defineConfig, type VersionedConfig } from './versioned-config.js';

/** The forecast lead days the proxy publishes: +1 … +9 (V2-B1). */
export const FWI_FORECAST_LEAD_DAYS = [1, 2, 3, 4, 5, 6, 7, 8, 9] as const;

export type FwiForecastLeadDay = (typeof FWI_FORECAST_LEAD_DAYS)[number];

/** `fwi-d1` … `fwi-d9`: the FWI forecast for the UTC day `leadDays` after the refresh. */
export type FwiForecastLayerId = `fwi-d${FwiForecastLeadDay}`;

export type EffisLayerId = 'fwi' | 'ba' | FwiForecastLayerId;

/**
 * Which Copernicus mapserver answers a layer: `effis` (the EFFIS viewer's) or `gwis` (the
 * Global Wildfire Information System's, same operator and terms, which carries the
 * ten-day FWI forecast). The adapter owns the base URLs; the config only names the one.
 */
export type EffisEndpoint = 'effis' | 'gwis';

export interface EffisLayerSpec {
  readonly id: EffisLayerId;
  readonly endpoint: EffisEndpoint;
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
  /**
   * For a `daily` layer: how many UTC days after the refresh's own date the `TIME` is
   * (0 for "today", 1 … 9 for the forecast days). Always 0 for a "latest" layer.
   */
  readonly leadDays: number;
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

/**
 * One forecast day over GWIS `ecmwf.fwi`. Same A2.2 knobs as today's `fwi`: the real
 * forecast rasters over the polling bbox are 12–20 KB, and the beyond-horizon answer is a
 * fully transparent PNG the `png_fully_transparent` rule calls suspect, never good.
 */
function forecastDay(leadDays: FwiForecastLeadDay): EffisLayerSpec {
  return {
    id: `fwi-d${leadDays}`,
    endpoint: 'gwis',
    service: 'wms',
    layerName: 'ecmwf.fwi',
    requestFormat: 'image/png',
    acceptedMediaTypes: ['image/png'],
    byteFloorBytes: 1024,
    extension: 'png',
    servedMediaType: 'image/png',
    time: 'daily',
    leadDays,
  };
}

export const EFFIS_LAYERS: VersionedConfig<EffisLayersValues> = defineConfig(
  'effis_layers',
  'effis_layers_v3',
  {
    wmsWidth: 1100,
    wmsHeight: 700,
    layers: [
      {
        id: 'fwi',
        endpoint: 'effis',
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
        leadDays: 0,
      },
      {
        id: 'ba',
        endpoint: 'effis',
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
        leadDays: 0,
      },
      ...FWI_FORECAST_LEAD_DAYS.map(forecastDay),
    ],
  },
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

const DAY_MS = 86_400_000;

/**
 * The UTC date a daily layer is asked for (and valid for) when the refresh runs at
 * `epochMs`: the refresh's own date plus the layer's lead days. `null` for a "latest"
 * layer.
 */
export function effisLayerDate(spec: EffisLayerSpec, epochMs: number): string | null {
  return spec.time === 'daily' ? effisUtcDate(epochMs + spec.leadDays * DAY_MS) : null;
}
