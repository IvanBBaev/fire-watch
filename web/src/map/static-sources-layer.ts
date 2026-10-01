/**
 * The F16 static hot-source mask, the drawing half: the solar parks, power plants, gas
 * flares and heavy industry the scorer checks against (11 §3.6), drawn so a reader can see
 * why an event carries the "may not be a fire" caveat.
 *
 * {@link applyStaticSourcesLayer} has the same contract as `applyEffisOverlays`: idempotent
 * and total over its input, called on every change and on every `style.load` (a theme swap
 * drops runtime sources).
 *
 * Stacking: above the EFFIS overlays, below the wind arrows and every fire layer — fire
 * stays the loudest thing on the map (06 §5.4, CI-14). Slate grey-blue, no red, no orange:
 * a mask is context, and a warm colour would read as heat.
 *
 * No attribution rides on the source: the mask is paid for by the OSM credit, which the
 * map corner carries always (contracts registry, `osm`, condition `always`).
 */

import type { AddLayerObject } from 'maplibre-gl';

import type { StaticSourceKind, StaticSourceMask } from '@fire-watch/contracts';

import type { LayerHost } from './layer-host.js';
import { FIRE_LAYER_IDS } from './layer-registry.js';
import { WIND_LAYER_ID } from './wind-layer.js';

export const STATIC_SOURCES_SOURCE_ID = 'static-sources';
export const STATIC_SOURCES_FILL_LAYER_ID = 'static-sources-fill';
export const STATIC_SOURCES_LINE_LAYER_ID = 'static-sources-line';
export const STATIC_SOURCES_POINT_LAYER_ID = 'static-sources-point';

/** Every mask layer, bottom to top. */
export const STATIC_SOURCES_LAYER_IDS = [
  STATIC_SOURCES_FILL_LAYER_ID,
  STATIC_SOURCES_LINE_LAYER_ID,
  STATIC_SOURCES_POINT_LAYER_ID,
] as const;

/** Slate: low chroma, far from fire's red–orange band (CI-14). */
export const STATIC_SOURCES_COLOR = '#475569';
export const STATIC_SOURCES_LINE_COLOR = '#334155';
export const STATIC_SOURCES_HALO_COLOR = '#f8fafc';
export const STATIC_SOURCES_FILL_OPACITY = 0.3;

type Position = [number, number];

export interface StaticSourceFeature {
  type: 'Feature';
  geometry:
    { type: 'Point'; coordinates: Position } | { type: 'Polygon'; coordinates: Position[][] };
  properties: { kind: StaticSourceKind };
}

export interface StaticSourceCollection {
  type: 'FeatureCollection';
  features: StaticSourceFeature[];
}

/** The mask as GeoJSON: a one-vertex source is a point, a ring is a closed polygon. */
export function staticSourcesGeoJson(mask: StaticSourceMask): StaticSourceCollection {
  return {
    type: 'FeatureCollection',
    features: mask.sources.map((source): StaticSourceFeature => {
      const ring = source.vertices.map((v): Position => [v.lon, v.lat]);
      const [first] = ring;
      if (ring.length === 1 && first !== undefined) {
        return {
          type: 'Feature',
          geometry: { type: 'Point', coordinates: first },
          properties: { kind: source.kind },
        };
      }
      return {
        type: 'Feature',
        geometry: { type: 'Polygon', coordinates: [first === undefined ? ring : [...ring, first]] },
        properties: { kind: source.kind },
      };
    }),
  };
}

/** What each host last received, so an unchanged mask is not re-added. */
const applied = new WeakMap<object, StaticSourceMask | null>();

function below(host: LayerHost, layerId: (typeof STATIC_SOURCES_LAYER_IDS)[number]) {
  const above = [
    ...STATIC_SOURCES_LAYER_IDS.slice(STATIC_SOURCES_LAYER_IDS.indexOf(layerId) + 1),
    WIND_LAYER_ID,
    ...FIRE_LAYER_IDS,
  ];
  return above.find((id) => host.getLayer(id) !== undefined);
}

function remove(host: LayerHost) {
  for (const id of STATIC_SOURCES_LAYER_IDS)
    if (host.getLayer(id) !== undefined) host.removeLayer(id);
  if (host.getSource(STATIC_SOURCES_SOURCE_ID) !== undefined)
    host.removeSource(STATIC_SOURCES_SOURCE_ID);
}

const LAYERS: Readonly<Record<(typeof STATIC_SOURCES_LAYER_IDS)[number], AddLayerObject>> = {
  [STATIC_SOURCES_FILL_LAYER_ID]: {
    id: STATIC_SOURCES_FILL_LAYER_ID,
    type: 'fill',
    source: STATIC_SOURCES_SOURCE_ID,
    filter: ['==', ['geometry-type'], 'Polygon'],
    paint: { 'fill-color': STATIC_SOURCES_COLOR, 'fill-opacity': STATIC_SOURCES_FILL_OPACITY },
  },
  [STATIC_SOURCES_LINE_LAYER_ID]: {
    id: STATIC_SOURCES_LINE_LAYER_ID,
    type: 'line',
    source: STATIC_SOURCES_SOURCE_ID,
    filter: ['==', ['geometry-type'], 'Polygon'],
    paint: { 'line-color': STATIC_SOURCES_LINE_COLOR, 'line-width': 1 },
  },
  [STATIC_SOURCES_POINT_LAYER_ID]: {
    id: STATIC_SOURCES_POINT_LAYER_ID,
    type: 'circle',
    source: STATIC_SOURCES_SOURCE_ID,
    filter: ['==', ['geometry-type'], 'Point'],
    paint: {
      'circle-color': STATIC_SOURCES_COLOR,
      'circle-radius': 4,
      'circle-stroke-color': STATIC_SOURCES_HALO_COLOR,
      'circle-stroke-width': 1,
    },
  },
};

/** Make the map show exactly this mask, or none for `null`. Safe to call repeatedly. */
export function applyStaticSourcesLayer(host: LayerHost, mask: StaticSourceMask | null): void {
  const fresh = applied.has(host) && applied.get(host) === mask;
  applied.set(host, mask);
  if (mask === null) {
    remove(host);
    return;
  }
  if (!fresh || host.getSource(STATIC_SOURCES_SOURCE_ID) === undefined) {
    remove(host);
    host.addSource(STATIC_SOURCES_SOURCE_ID, { type: 'geojson', data: staticSourcesGeoJson(mask) });
  }
  for (const id of STATIC_SOURCES_LAYER_IDS) {
    if (host.getLayer(id) === undefined) host.addLayer(LAYERS[id], below(host, id));
  }
}
