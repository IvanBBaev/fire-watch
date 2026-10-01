import type { AddLayerObject, SourceSpecification } from 'maplibre-gl';

/**
 * The slice of `maplibregl.Map` the overlay modules drive, so node tests need no
 * DOM. Its own module so `imagery-layer.ts` and `effis-overlays.ts` can share it
 * without importing each other.
 */
export interface LayerHost {
  getSource(id: string): unknown;
  addSource(id: string, source: SourceSpecification): unknown;
  removeSource(id: string): unknown;
  getLayer(id: string): unknown;
  addLayer(layer: AddLayerObject, beforeId?: string): unknown;
  removeLayer(id: string): unknown;
}
