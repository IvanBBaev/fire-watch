/**
 * The Esri World Imagery layer (ADR-001 A1.3/A2.3, TASKS G6): one raster source and one
 * raster layer, present exactly while the shell asks for them.
 *
 * {@link applyImageryLayer} is idempotent and total over its input, the same contract as
 * `applyFireLayers`: the controller calls it on every toggle, every client-config change
 * and every `style.load` (a theme swap drops runtime sources, and this layer is not carried
 * by `preserveFireStyle` — for a frame or two after a swap the basemap shows, which is the
 * graceful direction to fail in). `null` removes the layer and then its source; a changed
 * tile URL (a rotated key) replaces them. Falling back is therefore nothing more than the
 * basemap style underneath becoming visible again — no error tile, no message (A2.3).
 *
 * The layer goes directly beneath the lowest fire layer, so fire data stays the loudest
 * thing on the map (the fire-owns-red rule) and the imagery covers the basemap's own
 * layers, labels included. Whether labels should instead sit over the imagery is an open
 * founder decision; covering them is the simpler, reversible default.
 *
 * Attribution rides on the source, so MapLibre's attribution control shows it exactly while
 * the layer is on (ADR-001 A1.4). The words come from the contracts credit registry rather
 * than being retyped here.
 */

import type { AddLayerObject, SourceSpecification } from 'maplibre-gl';

import { CREDITS } from '@fire-watch/contracts';

import { FIRE_LAYER_IDS } from './layer-registry.js';

export const IMAGERY_SOURCE_ID = 'imagery-esri';
export const IMAGERY_LAYER_ID = 'imagery-esri';
/** ArcGIS World Imagery serves 256-pixel raster tiles. */
export const IMAGERY_TILE_SIZE = 256;

/** The slice of `maplibregl.Map` this module drives, so node tests need no DOM. */
export interface ImageryLayerHost {
  getSource(id: string): unknown;
  addSource(id: string, source: SourceSpecification): unknown;
  removeSource(id: string): unknown;
  getLayer(id: string): unknown;
  addLayer(layer: AddLayerObject, beforeId?: string): unknown;
  removeLayer(id: string): unknown;
}

const ESRI_ATTRIBUTION = ((): string => {
  const credit = CREDITS.find((entry) => entry.id === 'esri-world-imagery');
  if (credit === undefined) throw new Error('credits registry has no esri-world-imagery entry');
  return credit.text;
})();

function currentTilesUrl(host: ImageryLayerHost): string | null {
  const source = host.getSource(IMAGERY_SOURCE_ID) as { readonly tiles?: unknown } | undefined;
  if (source === undefined) return null;
  const tiles = source.tiles;
  return Array.isArray(tiles) && typeof tiles[0] === 'string' ? tiles[0] : null;
}

function removeImagery(host: ImageryLayerHost): void {
  if (host.getLayer(IMAGERY_LAYER_ID) !== undefined) host.removeLayer(IMAGERY_LAYER_ID);
  if (host.getSource(IMAGERY_SOURCE_ID) !== undefined) host.removeSource(IMAGERY_SOURCE_ID);
}

/** Make the map show imagery from `tilesUrl`, or none for `null`. Safe to call repeatedly. */
export function applyImageryLayer(host: ImageryLayerHost, tilesUrl: string | null): void {
  if (tilesUrl === null) {
    removeImagery(host);
    return;
  }
  if (currentTilesUrl(host) !== tilesUrl) {
    removeImagery(host);
    host.addSource(IMAGERY_SOURCE_ID, {
      type: 'raster',
      tiles: [tilesUrl],
      tileSize: IMAGERY_TILE_SIZE,
      attribution: ESRI_ATTRIBUTION,
    });
  }
  if (host.getLayer(IMAGERY_LAYER_ID) === undefined) {
    const lowestFire = FIRE_LAYER_IDS.find((id) => host.getLayer(id) !== undefined);
    host.addLayer({ id: IMAGERY_LAYER_ID, type: 'raster', source: IMAGERY_SOURCE_ID }, lowestFire);
  }
}
