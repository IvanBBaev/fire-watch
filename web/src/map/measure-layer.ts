/**
 * The V2-D3 measure tool, the drawing half: the reader's points, the path or outline they
 * make, and the dashed link from a picked place to the nearest active fire
 * (`core/geo/measure.ts` builds the collection).
 *
 * {@link applyMeasureLayer} has the same contract as the other overlays: idempotent, total
 * over its input, called on every change and on every `style.load`.
 *
 * Stacking: on top of everything. The drawing is the reader's own and exists only while
 * the panel is open; a vertex hidden under a fire dot could not be seen to be undone. The
 * colours are a deep blue with a white halo: no red, no orange, and no `fire-`/`alert-`
 * prefix, so the fire-owns-red gate (CI-14) treats them as context.
 */

import type { AddLayerObject } from 'maplibre-gl';

import type { MeasureCollection } from '../core/geo/measure.js';

import type { FeatureCollectionOf } from './geojson.js';
import type { LayerHost } from './layer-host.js';

export const MEASURE_SOURCE_ID = 'measure-drawing';

/** The ink: a deep blue that reads on both the light and the dark basemap. */
export const MEASURE_INK = '#1d4ed8';
/** The halo under every stroke and dot, so the ink reads over hillshade and imagery. */
export const MEASURE_HALO = '#ffffff';

/** Bottom to top. Exported so the style-spec validator and CI-14 can read them. */
export const MEASURE_LAYERS: readonly AddLayerObject[] = [
  {
    id: 'measure-area-fill',
    type: 'fill',
    source: MEASURE_SOURCE_ID,
    filter: ['==', ['get', 'role'], 'area'],
    paint: { 'fill-color': MEASURE_INK, 'fill-opacity': 0.12 },
  },
  {
    id: 'measure-line-halo',
    type: 'line',
    source: MEASURE_SOURCE_ID,
    filter: ['in', ['get', 'role'], ['literal', ['path', 'area', 'link']]],
    layout: { 'line-join': 'round', 'line-cap': 'round' },
    paint: { 'line-color': MEASURE_HALO, 'line-width': 5, 'line-opacity': 0.85 },
  },
  {
    id: 'measure-line',
    type: 'line',
    source: MEASURE_SOURCE_ID,
    filter: ['in', ['get', 'role'], ['literal', ['path', 'area']]],
    layout: { 'line-join': 'round', 'line-cap': 'round' },
    paint: { 'line-color': MEASURE_INK, 'line-width': 2.5 },
  },
  {
    id: 'measure-link',
    type: 'line',
    source: MEASURE_SOURCE_ID,
    filter: ['==', ['get', 'role'], 'link'],
    paint: { 'line-color': MEASURE_INK, 'line-width': 2.5, 'line-dasharray': [2, 1.5] },
  },
  {
    id: 'measure-target',
    type: 'circle',
    source: MEASURE_SOURCE_ID,
    filter: ['==', ['get', 'role'], 'target'],
    // A ring around the fire dot, never a fill over it: the fire keeps its own colour.
    paint: {
      'circle-radius': 11,
      'circle-opacity': 0,
      'circle-stroke-color': MEASURE_INK,
      'circle-stroke-width': 2.5,
    },
  },
  {
    id: 'measure-vertices',
    type: 'circle',
    source: MEASURE_SOURCE_ID,
    filter: ['==', ['get', 'role'], 'vertex'],
    paint: {
      'circle-radius': 5,
      'circle-color': MEASURE_INK,
      'circle-stroke-color': MEASURE_HALO,
      'circle-stroke-width': 2,
    },
  },
];

export const MEASURE_LAYER_IDS: readonly string[] = MEASURE_LAYERS.map((layer) => layer.id);

/** What each host last received, so an unchanged drawing is not re-added. */
const applied = new WeakMap<object, MeasureCollection>();

function remove(host: LayerHost): void {
  for (const id of [...MEASURE_LAYER_IDS].reverse()) {
    if (host.getLayer(id) !== undefined) host.removeLayer(id);
  }
  if (host.getSource(MEASURE_SOURCE_ID) !== undefined) host.removeSource(MEASURE_SOURCE_ID);
}

/** Make the map show exactly `collection`, or nothing for `null`. Safe to call repeatedly. */
export function applyMeasureLayer(host: LayerHost, collection: MeasureCollection | null): void {
  if (collection === null) {
    remove(host);
    applied.delete(host);
    return;
  }
  const fresh = applied.get(host) === collection && host.getSource(MEASURE_SOURCE_ID) !== undefined;
  if (!fresh) {
    remove(host);
    // The cast only drops the readonly markers.
    const data = collection as unknown as FeatureCollectionOf<unknown>;
    host.addSource(MEASURE_SOURCE_ID, { type: 'geojson', data });
  }
  for (const layer of MEASURE_LAYERS) {
    if (host.getLayer(layer.id) === undefined) host.addLayer(layer);
  }
  applied.set(host, collection);
}
