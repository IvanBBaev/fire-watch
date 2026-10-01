/**
 * The F15 swath overlay, the drawing half: where each satellite's sensor looked in the last
 * six hours (a faint violet fill) and where it will look in the next twelve (a blue
 * outline), with the ground track dashed through each swath and a "<platform> <HH:MM>"
 * label where the track crosses the box.
 *
 * {@link applyPassSwathsLayer} has the same contract as `applyWindLayer`: idempotent and
 * total over its input, called on every change and on every `style.load` (a theme swap
 * drops runtime sources and layers).
 *
 * Stacking: every swath layer goes below every fire layer — a swath is context, fire stays
 * the loudest thing on the map (06 §5.4, CI-14). The colours are blue and violet: no red,
 * no orange, and no `fire-`/`alert-` id prefix, so the fire-owns-red gate treats them as
 * context.
 *
 * The CelesTrak credit rides on the source's `attribution`, so MapLibre's corner shows it
 * exactly while swaths are drawn (CI-13); the Layers panel prints it too.
 *
 * ## Labels only where the style can render text
 *
 * A symbol layer with `text-field` needs the style's glyphs and a font stack those glyphs
 * serve. The label layer borrows the `text-font` of the first symbol layer in the current
 * style that spells one literally; a style with no glyphs or no such layer (the e2e
 * stand-in basemap, a failed basemap) gets no label layer rather than a glyph error in the
 * console. The panel lists the same passes in words, so nothing is lost there.
 */

import type { AddLayerObject, ExpressionSpecification } from 'maplibre-gl';

import { PASS_NEXT_COLOR, PASS_RECENT_COLOR, type PassSwathsDraw } from '../core/pass-swaths.js';

import type { FeatureCollectionOf } from './geojson.js';
import type { LayerHost } from './layer-host.js';
import { FIRE_LAYER_IDS } from './layer-registry.js';

export const PASS_SWATHS_SOURCE_ID = 'pass-swaths';
export const PASS_SWATHS_FILL_LAYER_ID = 'pass-swaths-fill';
export const PASS_SWATHS_OUTLINE_LAYER_ID = 'pass-swaths-outline';
export const PASS_SWATHS_TRACK_LAYER_ID = 'pass-swaths-track';
export const PASS_SWATHS_LABEL_LAYER_ID = 'pass-swaths-label';

/** Near-white: the label halo that separates text from any basemap. */
const LABEL_HALO_COLOR = '#f8fafc';

/** The slice of a style the label layer needs to decide whether it can render text. */
interface StyleLike {
  readonly glyphs?: unknown;
  readonly layers?: readonly unknown[];
}

/** A {@link LayerHost} that may expose its style — `maplibregl.Map` does. */
export interface PassSwathsLayerHost extends LayerHost {
  getStyle?(): StyleLike | undefined;
}

const byKind = (next: string | number, recent: string | number): ExpressionSpecification => [
  'match',
  ['get', 'kind'],
  'next',
  next,
  recent,
];

/** The layers, bottom to top. Exported so the style-spec validator can check them. */
export const PASS_SWATHS_FILL_LAYER: AddLayerObject = {
  id: PASS_SWATHS_FILL_LAYER_ID,
  type: 'fill',
  source: PASS_SWATHS_SOURCE_ID,
  filter: ['all', ['==', ['get', 'part'], 'swath'], ['==', ['get', 'kind'], 'recent']],
  paint: { 'fill-color': PASS_RECENT_COLOR, 'fill-opacity': 0.07 },
};

export const PASS_SWATHS_OUTLINE_LAYER: AddLayerObject = {
  id: PASS_SWATHS_OUTLINE_LAYER_ID,
  type: 'line',
  source: PASS_SWATHS_SOURCE_ID,
  filter: ['==', ['get', 'part'], 'swath'],
  paint: {
    'line-color': byKind(PASS_NEXT_COLOR, PASS_RECENT_COLOR),
    'line-width': byKind(1.6, 0.8),
    'line-opacity': byKind(0.9, 0.55),
  },
};

export const PASS_SWATHS_TRACK_LAYER: AddLayerObject = {
  id: PASS_SWATHS_TRACK_LAYER_ID,
  type: 'line',
  source: PASS_SWATHS_SOURCE_ID,
  filter: ['==', ['get', 'part'], 'track'],
  paint: {
    'line-color': byKind(PASS_NEXT_COLOR, PASS_RECENT_COLOR),
    'line-width': 1,
    'line-opacity': 0.6,
    'line-dasharray': [2, 2],
  },
};

/** The label layer for a style whose symbol layers use `font`. */
export function passSwathsLabelLayer(font: readonly string[]): AddLayerObject {
  return {
    id: PASS_SWATHS_LABEL_LAYER_ID,
    type: 'symbol',
    source: PASS_SWATHS_SOURCE_ID,
    filter: ['==', ['get', 'part'], 'label'],
    layout: {
      'text-field': ['get', 'label'],
      'text-font': [...font],
      'text-size': 11,
      'text-allow-overlap': false,
    },
    paint: {
      'text-color': byKind(PASS_NEXT_COLOR, PASS_RECENT_COLOR),
      'text-halo-color': LABEL_HALO_COLOR,
      'text-halo-width': 1.4,
    },
  };
}

const isStringArray = (value: unknown): value is readonly string[] =>
  Array.isArray(value) && value.length > 0 && value.every((entry) => typeof entry === 'string');

/** The font stack the style can render, or `null` when it cannot render text at all. */
export function labelFontOf(host: PassSwathsLayerHost): readonly string[] | null {
  let style: StyleLike | undefined;
  try {
    style = host.getStyle?.();
  } catch {
    return null;
  }
  if (style === undefined || typeof style.glyphs !== 'string' || style.glyphs === '') return null;
  for (const layer of style.layers ?? []) {
    if (typeof layer !== 'object' || layer === null) continue;
    const layout = (layer as { layout?: unknown }).layout;
    if (typeof layout !== 'object' || layout === null) continue;
    const font = (layout as Record<string, unknown>)['text-font'];
    if (isStringArray(font)) return font;
  }
  return null;
}

const LAYER_IDS = [
  PASS_SWATHS_FILL_LAYER_ID,
  PASS_SWATHS_OUTLINE_LAYER_ID,
  PASS_SWATHS_TRACK_LAYER_ID,
  PASS_SWATHS_LABEL_LAYER_ID,
] as const;

/** What each host last received, so an unchanged draw is not re-added. */
const applied = new WeakMap<object, PassSwathsDraw>();

function firstFireLayer(host: LayerHost): string | undefined {
  return FIRE_LAYER_IDS.find((id) => host.getLayer(id) !== undefined);
}

function remove(host: LayerHost): void {
  for (const id of [...LAYER_IDS].reverse()) {
    if (host.getLayer(id) !== undefined) host.removeLayer(id);
  }
  if (host.getSource(PASS_SWATHS_SOURCE_ID) !== undefined) {
    host.removeSource(PASS_SWATHS_SOURCE_ID);
  }
}

/** Make the map show exactly `draw`'s swaths, or none for `null`. Safe to call repeatedly. */
export function applyPassSwathsLayer(host: PassSwathsLayerHost, draw: PassSwathsDraw | null): void {
  if (draw === null) {
    remove(host);
    applied.delete(host);
    return;
  }
  const fresh = applied.get(host) === draw && host.getSource(PASS_SWATHS_SOURCE_ID) !== undefined;
  if (!fresh) {
    remove(host);
    // The cast only drops the readonly markers.
    const data = draw.collection as unknown as FeatureCollectionOf<unknown>;
    host.addSource(PASS_SWATHS_SOURCE_ID, {
      type: 'geojson',
      data,
      attribution: draw.attribution,
    });
  }
  const layers: AddLayerObject[] = [
    PASS_SWATHS_FILL_LAYER,
    PASS_SWATHS_OUTLINE_LAYER,
    PASS_SWATHS_TRACK_LAYER,
  ];
  const font = labelFontOf(host);
  if (font !== null) layers.push(passSwathsLabelLayer(font));
  for (const layer of layers) {
    if (host.getLayer(layer.id) === undefined) host.addLayer(layer, firstFireLayer(host));
  }
  applied.set(host, draw);
}
