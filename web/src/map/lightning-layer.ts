/**
 * The F18 lightning context layer, the drawing half: one small ringed circle per recent
 * flash, coloured by age class (`core/lightning.ts`).
 *
 * {@link applyLightningLayer} has the same contract as `applyPassSwathsLayer`: idempotent and
 * total over its input, called on every change and on every `style.load` (a theme swap
 * drops runtime sources and layers).
 *
 * Stacking: below every fire layer — a flash is context, fire stays the loudest thing on
 * the map (06 §5.4, CI-14). The colours are yellow, white and blue: no red, no orange, and
 * no `fire-`/`alert-` id prefix, so the fire-owns-red gate treats them as context.
 *
 * The EUMETSAT credit rides on the source's `attribution`, so MapLibre's corner shows it
 * exactly while flashes are drawn (CI-13); the Layers panel prints it too.
 */

import type { AddLayerObject, ExpressionSpecification } from 'maplibre-gl';

import {
  LIGHTNING_AGE_CLASSES,
  LIGHTNING_RING_COLOR,
  type LightningDraw,
} from '../core/lightning.js';

import type { FeatureCollectionOf } from './geojson.js';
import type { LayerHost } from './layer-host.js';
import { FIRE_LAYER_IDS } from './layer-registry.js';

export const LIGHTNING_SOURCE_ID = 'lightning-flashes';
export const LIGHTNING_LAYER_ID = 'lightning-flashes';

const byAge = (values: readonly [string | number, string | number, string | number]) =>
  ['match', ['get', 'ageClass'], 0, values[0], 1, values[1], values[2]] as ExpressionSpecification;

/** The circle layer. Exported so the style-spec validator can check it. */
export const LIGHTNING_LAYER: AddLayerObject = {
  id: LIGHTNING_LAYER_ID,
  type: 'circle',
  source: LIGHTNING_SOURCE_ID,
  paint: {
    'circle-color': byAge([
      LIGHTNING_AGE_CLASSES[0].color,
      LIGHTNING_AGE_CLASSES[1].color,
      LIGHTNING_AGE_CLASSES[2].color,
    ]),
    // Smaller than a fire dot at every zoom, and the newest a little larger than the rest.
    'circle-radius': [
      'interpolate',
      ['linear'],
      ['zoom'],
      5,
      byAge([3, 2.5, 2]),
      9,
      byAge([5, 4, 3.5]),
    ],
    'circle-opacity': byAge([0.95, 0.85, 0.7]),
    'circle-stroke-color': LIGHTNING_RING_COLOR,
    'circle-stroke-width': 0.8,
    'circle-stroke-opacity': byAge([0.9, 0.8, 0.6]),
  },
};

/** What each host last received, so an unchanged draw is not re-added. */
const applied = new WeakMap<object, LightningDraw>();

function firstFireLayer(host: LayerHost): string | undefined {
  return FIRE_LAYER_IDS.find((id) => host.getLayer(id) !== undefined);
}

function remove(host: LayerHost): void {
  if (host.getLayer(LIGHTNING_LAYER_ID) !== undefined) host.removeLayer(LIGHTNING_LAYER_ID);
  if (host.getSource(LIGHTNING_SOURCE_ID) !== undefined) host.removeSource(LIGHTNING_SOURCE_ID);
}

/** Make the map show exactly `draw`'s flashes, or none for `null`. Safe to call repeatedly. */
export function applyLightningLayer(host: LayerHost, draw: LightningDraw | null): void {
  if (draw === null) {
    remove(host);
    applied.delete(host);
    return;
  }
  const fresh = applied.get(host) === draw && host.getSource(LIGHTNING_SOURCE_ID) !== undefined;
  if (!fresh) {
    remove(host);
    // The cast only drops the readonly markers.
    const data = draw.collection as unknown as FeatureCollectionOf<unknown>;
    host.addSource(LIGHTNING_SOURCE_ID, { type: 'geojson', data, attribution: draw.attribution });
  }
  if (host.getLayer(LIGHTNING_LAYER_ID) === undefined) {
    host.addLayer(LIGHTNING_LAYER, firstFireLayer(host));
  }
  applied.set(host, draw);
}
