import type { AddLayerObject, SourceSpecification } from 'maplibre-gl';
import { describe, expect, it } from 'vitest';

import {
  IMAGERY_LAYER_ID,
  IMAGERY_SOURCE_ID,
  type ImageryLayerHost,
  applyImageryLayer,
} from './imagery-layer.js';
import { FIRE_LAYER_IDS } from './layer-registry.js';

const TILES = 'https://tiles.example.test/imagery/tile/{z}/{y}/{x}?token=AAPK-test';

/** An ordered layer stack with MapLibre's duplicate and missing-id errors. */
class FakeHost implements ImageryLayerHost {
  readonly sources = new Map<string, SourceSpecification>();
  layers: string[] = [];

  getSource(id: string): unknown {
    return this.sources.get(id);
  }
  addSource(id: string, source: SourceSpecification): unknown {
    if (this.sources.has(id)) throw new Error(`duplicate source: ${id}`);
    this.sources.set(id, source);
    return undefined;
  }
  removeSource(id: string): unknown {
    if (id === IMAGERY_SOURCE_ID && this.layers.includes(IMAGERY_LAYER_ID)) {
      throw new Error('source still in use');
    }
    if (!this.sources.delete(id)) throw new Error(`no source: ${id}`);
    return undefined;
  }
  getLayer(id: string): unknown {
    return this.layers.includes(id) ? { id } : undefined;
  }
  addLayer(layer: AddLayerObject, beforeId?: string): unknown {
    if (this.layers.includes(layer.id)) throw new Error(`duplicate layer: ${layer.id}`);
    const at = beforeId === undefined ? this.layers.length : this.layers.indexOf(beforeId);
    if (at < 0) throw new Error(`no layer: ${String(beforeId)}`);
    this.layers.splice(at, 0, layer.id);
    return undefined;
  }
  removeLayer(id: string): unknown {
    if (!this.layers.includes(id)) throw new Error(`no layer: ${id}`);
    this.layers = this.layers.filter((layer) => layer !== id);
    return undefined;
  }
}

describe('applyImageryLayer', () => {
  it('slides the imagery under the lowest fire layer and credits Esri on the source', () => {
    const host = new FakeHost();
    host.layers = ['basemap-land', 'basemap-labels', ...FIRE_LAYER_IDS];
    applyImageryLayer(host, TILES);
    expect(host.layers.slice(0, 4)).toEqual([
      'basemap-land',
      'basemap-labels',
      IMAGERY_LAYER_ID,
      FIRE_LAYER_IDS[0],
    ]);
    expect(host.sources.get(IMAGERY_SOURCE_ID)).toMatchObject({
      type: 'raster',
      tiles: [TILES],
      tileSize: 256,
      attribution: 'Powered by Esri',
    });
  });

  it('is idempotent, and goes on top when there are no fire layers yet', () => {
    const host = new FakeHost();
    host.layers = ['basemap-land'];
    applyImageryLayer(host, TILES);
    applyImageryLayer(host, TILES);
    expect(host.layers).toEqual(['basemap-land', IMAGERY_LAYER_ID]);
  });

  it('falls back to the basemap by removing layer then source, and tolerates nothing to remove', () => {
    const host = new FakeHost();
    host.layers = ['basemap-land'];
    applyImageryLayer(host, null);
    applyImageryLayer(host, TILES);
    applyImageryLayer(host, null);
    expect(host.layers).toEqual(['basemap-land']);
    expect(host.sources.size).toBe(0);
  });

  it('replaces the source when the tile URL changes (a rotated key)', () => {
    const host = new FakeHost();
    applyImageryLayer(host, TILES);
    const rotated = TILES.replace('AAPK-test', 'AAPK-next');
    applyImageryLayer(host, rotated);
    expect(host.sources.get(IMAGERY_SOURCE_ID)).toMatchObject({ tiles: [rotated] });
    expect(host.layers).toEqual([IMAGERY_LAYER_ID]);
  });

  it('comes back after a style swap wiped it', () => {
    const host = new FakeHost();
    applyImageryLayer(host, TILES);
    host.sources.clear();
    host.layers = [...FIRE_LAYER_IDS];
    applyImageryLayer(host, TILES);
    expect(host.layers[0]).toBe(IMAGERY_LAYER_ID);
  });
});
