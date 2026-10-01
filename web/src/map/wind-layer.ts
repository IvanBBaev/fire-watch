/**
 * The F14 wind context layer, the drawing half: one arrow per ECMWF grid point, pointing
 * where the wind blows *to*, coloured by speed class.
 *
 * {@link applyWindLayer} has the same contract as `applyEffisOverlays`: idempotent and total
 * over its input, called on every change and on every `style.load` (a theme swap drops
 * runtime sources, layers and images alike).
 *
 * The arrows are a MapLibre symbol layer. Each speed class gets its own pre-coloured arrow
 * image (`addImage` with raw RGBA, not SDF, so each arrow keeps a light halo that reads on
 * both the light and the dark basemap), and `icon-rotate` turns it to the bearing with
 * `icon-rotation-alignment: map`, so the arrows stay true when the map is rotated.
 *
 * Stacking: above the EFFIS context overlays (an arrow over the FWI raster still reads)
 * and below every fire layer — fire stays the loudest thing on the map (06 §5.4, CI-14).
 * The ramp (`WIND_SPEED_CLASSES`) is teal → blue → indigo → violet: no red, no orange.
 *
 * No attribution rides on the source: the ECMWF Terms owe five components together, too
 * long for MapLibre's corner control, so the Layers panel prints them whole while the
 * layer is on and the credits page lists them (contracts registry, `derived:ecmwf`).
 */

import type { AddLayerObject } from 'maplibre-gl';

import { WIND_SPEED_CLASSES, type WindOverlayBody, windArrows } from '../core/wind.js';

import type { FeatureCollectionOf } from './geojson.js';
import type { LayerHost } from './layer-host.js';
import { FIRE_LAYER_IDS } from './layer-registry.js';

export const WIND_SOURCE_ID = 'wind-arrows';
export const WIND_LAYER_ID = 'wind-arrows';

/** The image id for a speed class; `icon-image` builds the same string from the feature. */
export const WIND_ARROW_IMAGE_PREFIX = 'fw-wind-arrow-';

/** The arrow bitmap's side, in CSS pixels at `icon-size: 1` (drawn at 2× for sharpness). */
export const WIND_ARROW_SIZE = 20;
const PIXEL_RATIO = 2;

/** Near-white: the halo that separates an arrow from a dark raster or basemap. */
const HALO_COLOR = '#f8fafc';

export interface WindImage {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8Array;
}

/** A {@link LayerHost} that can also hold images — `maplibregl.Map` is one. */
export interface WindLayerHost extends LayerHost {
  hasImage(id: string): boolean;
  addImage(id: string, image: WindImage, options?: { pixelRatio?: number }): unknown;
}

function hexRgb(hex: string): readonly [number, number, number] {
  const value = Number.parseInt(hex.slice(1), 16);
  return [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
}

/**
 * Where the arrow is, in unit coordinates (x right, y down, both 0–1), pointing north:
 * a shaft from the bottom up to a triangular head.
 */
function insideArrow(x: number, y: number): boolean {
  const headBase = 0.45;
  if (y >= 0.08 && y <= headBase) {
    // Head: apex at (0.5, 0.08), base 0.56 wide at y = headBase.
    const halfWidth = ((y - 0.08) / (headBase - 0.08)) * 0.28;
    return Math.abs(x - 0.5) <= halfWidth;
  }
  return y > headBase && y <= 0.92 && Math.abs(x - 0.5) <= 0.07;
}

/** An RGBA arrow in `color` with a one-pixel halo, pointing north. Pure. */
export function windArrowImage(color: string): WindImage {
  const side = WIND_ARROW_SIZE * PIXEL_RATIO;
  const fill = hexRgb(color);
  const halo = hexRgb(HALO_COLOR);
  const inside = (px: number, py: number) =>
    px >= 0 &&
    py >= 0 &&
    px < side &&
    py < side &&
    insideArrow((px + 0.5) / side, (py + 0.5) / side);
  const data = new Uint8Array(side * side * 4);
  for (let py = 0; py < side; py += 1) {
    for (let px = 0; px < side; px += 1) {
      const offset = (py * side + px) * 4;
      let rgb: readonly [number, number, number] | null = null;
      let alpha = 0;
      if (inside(px, py)) {
        rgb = fill;
        alpha = 255;
      } else if (
        inside(px - 1, py) ||
        inside(px + 1, py) ||
        inside(px, py - 1) ||
        inside(px, py + 1) ||
        inside(px - 1, py - 1) ||
        inside(px + 1, py + 1) ||
        inside(px - 1, py + 1) ||
        inside(px + 1, py - 1)
      ) {
        rgb = halo;
        alpha = 200;
      }
      if (rgb !== null) {
        data[offset] = rgb[0];
        data[offset + 1] = rgb[1];
        data[offset + 2] = rgb[2];
        data[offset + 3] = alpha;
      }
    }
  }
  return { width: side, height: side, data };
}

function ensureImages(host: WindLayerHost): void {
  WIND_SPEED_CLASSES.forEach((speedClass, index) => {
    const id = `${WIND_ARROW_IMAGE_PREFIX}${String(index)}`;
    if (!host.hasImage(id)) {
      host.addImage(id, windArrowImage(speedClass.color), { pixelRatio: PIXEL_RATIO });
    }
  });
}

/** The symbol layer. Exported so the style-spec validator can check it. */
export const WIND_LAYER: AddLayerObject = {
  id: WIND_LAYER_ID,
  type: 'symbol',
  source: WIND_SOURCE_ID,
  layout: {
    'icon-image': ['concat', WIND_ARROW_IMAGE_PREFIX, ['to-string', ['get', 'speedClass']]],
    'icon-rotate': ['get', 'bearing'],
    'icon-rotation-alignment': 'map',
    'icon-allow-overlap': true,
    'icon-ignore-placement': true,
    // A 0.5° grid is ~11 px apart at zoom 4 and ~90 px at zoom 7: shrink the arrows out.
    'icon-size': ['interpolate', ['linear'], ['zoom'], 4, 0.55, 7, 1],
  },
  paint: { 'icon-opacity': 0.9 },
};

/** What each host last received, so an unchanged body is not re-added. */
const applied = new WeakMap<object, WindOverlayBody>();

function firstFireLayer(host: LayerHost): string | undefined {
  return FIRE_LAYER_IDS.find((id) => host.getLayer(id) !== undefined);
}

function remove(host: LayerHost): void {
  if (host.getLayer(WIND_LAYER_ID) !== undefined) host.removeLayer(WIND_LAYER_ID);
  if (host.getSource(WIND_SOURCE_ID) !== undefined) host.removeSource(WIND_SOURCE_ID);
}

/** Make the map show exactly `body`'s arrows, or none for `null`. Safe to call repeatedly. */
export function applyWindLayer(host: WindLayerHost, body: WindOverlayBody | null): void {
  if (body === null) {
    remove(host);
    applied.delete(host);
    return;
  }
  const fresh = applied.get(host) === body && host.getSource(WIND_SOURCE_ID) !== undefined;
  if (!fresh) {
    remove(host);
    // The arrows are plain points; the cast only drops the readonly markers.
    const data = windArrows(body) as unknown as FeatureCollectionOf<unknown>;
    host.addSource(WIND_SOURCE_ID, { type: 'geojson', data });
  }
  ensureImages(host);
  if (host.getLayer(WIND_LAYER_ID) === undefined) {
    host.addLayer(WIND_LAYER, firstFireLayer(host));
  }
  applied.set(host, body);
}
