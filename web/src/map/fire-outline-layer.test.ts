/**
 * V2-A4, the drawing half: the outlines' source and layers against a fake host with
 * MapLibre's duplicate and in-use errors, and the layers against MapLibre's own validator.
 */

import { validateStyleMin } from '@maplibre/maplibre-gl-style-spec';
import type { StyleSpecification } from '@maplibre/maplibre-gl-style-spec';
import type { AddLayerObject, SourceSpecification } from 'maplibre-gl';
import { describe, expect, it } from 'vitest';

import { parseColor } from '../core/color/color.js';
import { FIRE_OUTLINE_COLOR, type FireOutlineDraw } from '../core/fire-outlines.js';
import {
  FIRE_OUTLINE_FILL_LAYER_ID,
  FIRE_OUTLINE_LAYERS,
  FIRE_OUTLINE_LINE_LAYER_ID,
  FIRE_OUTLINE_SOURCE_ID,
  applyFireOutlineLayer,
} from './fire-outline-layer.js';
import { FIRE_LAYER_IDS, type LayerHost } from './layer-registry.js';
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

const RING: [number, number][] = [
  [25.1, 42.6],
  [25.11, 42.6],
  [25.11, 42.61],
  [25.1, 42.61],
  [25.1, 42.6],
];

function draw(ids: readonly string[] = ['fw-2026-aaaaa']): FireOutlineDraw {
  return {
    collection: {
      type: 'FeatureCollection',
      features: ids.map((id) => ({
        type: 'Feature',
        id,
        geometry: { type: 'MultiPolygon', coordinates: [[RING]] },
        properties: {
          event_id: id,
          area_ha: 100,
          area_low_ha: 0,
          area_high_ha: 300,
          edge_uncertainty_km: 0.375,
          footprints: 3,
          last_detection_at: '2026-08-09T09:00:00Z',
        },
      })),
    },
    attribution: 'We acknowledge the use of data from NASA FIRMS',
  };
}

function withFireLayers(): FakeHost {
  const host = new FakeHost();
  for (const id of FIRE_LAYER_IDS) host.layers.push(id);
  return host;
}

const OUTLINE_IDS = [FIRE_OUTLINE_FILL_LAYER_ID, FIRE_OUTLINE_LINE_LAYER_ID];

describe('applyFireOutlineLayer', () => {
  it('draws fill and edge in order under every fire layer, with the FIRMS credit', () => {
    const host = withFireLayers();
    applyFireOutlineLayer(host, draw());
    expect(host.layers.slice(0, 2)).toEqual(OUTLINE_IDS);
    expect(host.layers.slice(2)).toEqual([...FIRE_LAYER_IDS]);
    const source = host.sources.get(FIRE_OUTLINE_SOURCE_ID) as {
      attribution: string;
      data: { features: { id: string }[] };
    };
    expect(source.attribution).toBe('We acknowledge the use of data from NASA FIRMS');
    expect(source.data.features.map((feature) => feature.id)).toEqual(['fw-2026-aaaaa']);
  });

  it('is idempotent, replaces the source for a new draw, and removes everything for null', () => {
    const host = withFireLayers();
    const first = draw();
    applyFireOutlineLayer(host, first);
    const source = host.sources.get(FIRE_OUTLINE_SOURCE_ID);
    applyFireOutlineLayer(host, first);
    expect(host.sources.get(FIRE_OUTLINE_SOURCE_ID)).toBe(source);

    applyFireOutlineLayer(host, draw(['fw-2026-bbbbb']));
    expect(host.sources.get(FIRE_OUTLINE_SOURCE_ID)).not.toBe(source);
    for (const id of OUTLINE_IDS) {
      expect(host.layers.filter((layer) => layer === id)).toHaveLength(1);
    }

    applyFireOutlineLayer(host, null);
    for (const id of OUTLINE_IDS) expect(host.getLayer(id)).toBeUndefined();
    expect(host.getSource(FIRE_OUTLINE_SOURCE_ID)).toBeUndefined();
    applyFireOutlineLayer(host, null);
  });

  it('redraws after a style swap dropped its source and layers', () => {
    const host = withFireLayers();
    const wanted = draw();
    applyFireOutlineLayer(host, wanted);
    host.sources.clear();
    host.layers = [...FIRE_LAYER_IDS];
    applyFireOutlineLayer(host, wanted);
    for (const id of OUTLINE_IDS) expect(host.getLayer(id)).toBeDefined();
    expect(host.getSource(FIRE_OUTLINE_SOURCE_ID)).toBeDefined();
  });
});

describe('the estimated outline layer specs', () => {
  it('pass MapLibre’s style-spec validator', () => {
    const style = {
      version: 8,
      sources: {
        [FIRE_OUTLINE_SOURCE_ID]: {
          type: 'geojson',
          data: { type: 'FeatureCollection', features: [] },
        },
      },
      layers: FIRE_OUTLINE_LAYERS,
    } as unknown as StyleSpecification;
    expect(validateStyleMin(style).map((error) => error.message)).toEqual([]);
  });

  it('paint nothing in the red–orange band fire owns and claim no fire id (CI-14)', () => {
    expect(isFireHue(parseColor(FIRE_OUTLINE_COLOR))).toBe(false);
    for (const layer of FIRE_OUTLINE_LAYERS) {
      expect(layer.id.startsWith('fire-')).toBe(false);
      expect(layer.id.startsWith('alert-')).toBe(false);
    }
  });

  it('draws a dashed edge, so the outline never reads as a surveyed perimeter', () => {
    const line = FIRE_OUTLINE_LAYERS.find((layer) => layer.id === FIRE_OUTLINE_LINE_LAYER_ID) as {
      paint: Record<string, unknown>;
    };
    expect(line.paint['line-dasharray']).toBeDefined();
  });
});
