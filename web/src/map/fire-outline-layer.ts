/**
 * V2-A4 estimated fire outlines, the drawing half: a faint violet fill and a dashed violet
 * edge per outline (`core/fire-outlines.ts`).
 *
 * {@link applyFireOutlineLayer} has the same contract as `applyLightningLayer`: idempotent
 * and total over its input, called on every change and on every `style.load` (a theme swap
 * drops runtime sources and layers).
 *
 * Stacking: below every fire layer — an outline is an estimate drawn around the detections,
 * and the fire dots inside it stay the loudest thing on the map (06 §5.4, CI-14). Violet and
 * nothing else, and no `fire-`/`alert-` id prefix, so the fire-owns-red gate treats the
 * outline as context. The dash says "estimated" before any copy does: a solid edge would
 * read as a surveyed perimeter.
 *
 * The FIRMS acknowledgement rides on the source's `attribution`, so MapLibre's corner shows
 * it exactly while an outline is drawn (CI-13); the Layers panel prints it too.
 */

import type { AddLayerObject } from 'maplibre-gl';

import {
  FIRE_OUTLINE_COLOR,
  FIRE_OUTLINE_FILL_OPACITY,
  type FireOutlineDraw,
} from '../core/fire-outlines.js';

import type { FeatureCollectionOf } from './geojson.js';
import type { LayerHost } from './layer-host.js';
import { FIRE_LAYER_IDS } from './layer-registry.js';

export const FIRE_OUTLINE_SOURCE_ID = 'estimated-outlines';
export const FIRE_OUTLINE_FILL_LAYER_ID = 'estimated-outlines-fill';
export const FIRE_OUTLINE_LINE_LAYER_ID = 'estimated-outlines-line';

/** The two layers, bottom to top. Exported so the style-spec validator can check them. */
export const FIRE_OUTLINE_LAYERS: readonly AddLayerObject[] = [
  {
    id: FIRE_OUTLINE_FILL_LAYER_ID,
    type: 'fill',
    source: FIRE_OUTLINE_SOURCE_ID,
    paint: {
      'fill-color': FIRE_OUTLINE_COLOR,
      'fill-opacity': FIRE_OUTLINE_FILL_OPACITY,
    },
  },
  {
    id: FIRE_OUTLINE_LINE_LAYER_ID,
    type: 'line',
    source: FIRE_OUTLINE_SOURCE_ID,
    layout: { 'line-join': 'round' },
    paint: {
      'line-color': FIRE_OUTLINE_COLOR,
      'line-width': 1.5,
      'line-dasharray': [2, 1.5],
    },
  },
];

/** What each host last received, so an unchanged draw is not re-added. */
const applied = new WeakMap<object, FireOutlineDraw>();

function firstFireLayer(host: LayerHost): string | undefined {
  return FIRE_LAYER_IDS.find((id) => host.getLayer(id) !== undefined);
}

function remove(host: LayerHost): void {
  for (const layer of [...FIRE_OUTLINE_LAYERS].reverse()) {
    if (host.getLayer(layer.id) !== undefined) host.removeLayer(layer.id);
  }
  if (host.getSource(FIRE_OUTLINE_SOURCE_ID) !== undefined) {
    host.removeSource(FIRE_OUTLINE_SOURCE_ID);
  }
}

/** Make the map show exactly `draw`'s outlines, or none for `null`. Safe to call repeatedly. */
export function applyFireOutlineLayer(host: LayerHost, draw: FireOutlineDraw | null): void {
  if (draw === null) {
    remove(host);
    applied.delete(host);
    return;
  }
  const fresh = applied.get(host) === draw && host.getSource(FIRE_OUTLINE_SOURCE_ID) !== undefined;
  if (!fresh) {
    remove(host);
    // The cast only drops the readonly markers.
    const data = draw.collection as unknown as FeatureCollectionOf<unknown>;
    host.addSource(FIRE_OUTLINE_SOURCE_ID, {
      type: 'geojson',
      data,
      attribution: draw.attribution,
    });
  }
  for (const layer of FIRE_OUTLINE_LAYERS) {
    if (host.getLayer(layer.id) === undefined) host.addLayer(layer, firstFireLayer(host));
  }
  applied.set(host, draw);
}
