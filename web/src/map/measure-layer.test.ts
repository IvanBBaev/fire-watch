/**
 * V2-D3, the drawing half: the measure source and layers against a fake host with
 * MapLibre's duplicate and in-use errors, and the layers against MapLibre's own validator.
 */

import { validateStyleMin } from '@maplibre/maplibre-gl-style-spec';
import type { StyleSpecification } from '@maplibre/maplibre-gl-style-spec';
import type { AddLayerObject, SourceSpecification } from 'maplibre-gl';
import { describe, expect, it } from 'vitest';

import { parseColor } from '../core/color/color.js';
import { measureCollection, measureResult } from '../core/geo/measure.js';
import { FIRE_LAYER_IDS, type LayerHost } from './layer-registry.js';
import {
  MEASURE_HALO,
  MEASURE_INK,
  MEASURE_LAYERS,
  MEASURE_LAYER_IDS,
  MEASURE_SOURCE_ID,
  applyMeasureLayer,
} from './measure-layer.js';
import { isFireHue } from './style-colors.js';

class FakeHost implements LayerHost {
  readonly sources = new Map<string, SourceSpecification>();
  layers: string[] = [];
  readonly specs = new Map<string, AddLayerObject>();

  getSource(id: string): unknown {
    return this.sources.get(id);
  }
  addSource(id: string, source: SourceSpecification): unknown {
    if (this.sources.has(id)) throw new Error(`duplicate source: ${id}`);
    this.sources.set(id, source);
    return undefined;
  }
  removeSource(id: string): unknown {
    for (const layer of this.layers) {
      const spec = this.specs.get(layer) as { source?: unknown } | undefined;
      if (spec?.source === id) throw new Error(`source ${id} still in use by ${layer}`);
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
    this.specs.set(layer.id, layer);
    return undefined;
  }
  removeLayer(id: string): unknown {
    if (!this.layers.includes(id)) throw new Error(`no layer: ${id}`);
    this.layers = this.layers.filter((layer) => layer !== id);
    this.specs.delete(id);
    return undefined;
  }
}

const POINTS = [
  { lon: 23.32, lat: 42.7 },
  { lon: 24.75, lat: 42.14 },
  { lon: 27.91, lat: 43.21 },
];

function drawing(points = POINTS) {
  return measureCollection('area', points, measureResult('area', points, []));
}

function withFireLayers(): FakeHost {
  const host = new FakeHost();
  for (const id of FIRE_LAYER_IDS) host.layers.push(id);
  return host;
}

describe('applyMeasureLayer', () => {
  it('draws above every fire layer, in its own order', () => {
    const host = withFireLayers();
    applyMeasureLayer(host, drawing());
    expect(host.layers.slice(-MEASURE_LAYER_IDS.length)).toEqual([...MEASURE_LAYER_IDS]);
    const source = host.sources.get(MEASURE_SOURCE_ID) as { data: { features: unknown[] } };
    expect(source.data.features).toHaveLength(4);
  });

  it('is idempotent, replaces the source for a new drawing, and removes everything for null', () => {
    const host = withFireLayers();
    const first = drawing();
    applyMeasureLayer(host, first);
    const source = host.sources.get(MEASURE_SOURCE_ID);
    applyMeasureLayer(host, first);
    expect(host.sources.get(MEASURE_SOURCE_ID)).toBe(source);

    applyMeasureLayer(host, drawing(POINTS.slice(0, 2)));
    expect(host.sources.get(MEASURE_SOURCE_ID)).not.toBe(source);
    for (const id of MEASURE_LAYER_IDS) {
      expect(host.layers.filter((layer) => layer === id)).toHaveLength(1);
    }

    applyMeasureLayer(host, null);
    expect(host.layers).toEqual([...FIRE_LAYER_IDS]);
    expect(host.getSource(MEASURE_SOURCE_ID)).toBeUndefined();
    applyMeasureLayer(host, null);
  });

  it('redraws after a style swap dropped its source and layers', () => {
    const host = withFireLayers();
    const wanted = drawing();
    applyMeasureLayer(host, wanted);
    host.sources.clear();
    host.layers = [...FIRE_LAYER_IDS];
    applyMeasureLayer(host, wanted);
    expect(host.getSource(MEASURE_SOURCE_ID)).toBeDefined();
    for (const id of MEASURE_LAYER_IDS) expect(host.getLayer(id)).toBeDefined();
  });
});

describe('the measure layer specs', () => {
  it('pass MapLibre’s style-spec validator', () => {
    const style = {
      version: 8,
      sources: {
        [MEASURE_SOURCE_ID]: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } },
      },
      layers: MEASURE_LAYERS,
    } as unknown as StyleSpecification;
    expect(validateStyleMin(style).map((error) => error.message)).toEqual([]);
  });

  it('paint nothing in the red–orange band fire owns, under no fire id (CI-14)', () => {
    expect(isFireHue(parseColor(MEASURE_INK))).toBe(false);
    expect(isFireHue(parseColor(MEASURE_HALO))).toBe(false);
    for (const id of MEASURE_LAYER_IDS) {
      expect(id.startsWith('fire-') || id.startsWith('alert-')).toBe(false);
    }
  });
});
