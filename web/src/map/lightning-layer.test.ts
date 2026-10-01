/**
 * F18, the drawing half: the flashes' source and layer against a fake host with MapLibre's
 * duplicate and in-use errors, and the layer against MapLibre's own validator.
 */

import { validateStyleMin } from '@maplibre/maplibre-gl-style-spec';
import type { StyleSpecification } from '@maplibre/maplibre-gl-style-spec';
import type { AddLayerObject, SourceSpecification } from 'maplibre-gl';
import { describe, expect, it } from 'vitest';

import { parseColor } from '../core/color/color.js';
import {
  LIGHTNING_AGE_CLASSES,
  LIGHTNING_RING_COLOR,
  type LightningDraw,
} from '../core/lightning.js';
import { FIRE_LAYER_IDS, type LayerHost } from './layer-registry.js';
import {
  LIGHTNING_LAYER,
  LIGHTNING_LAYER_ID,
  LIGHTNING_SOURCE_ID,
  applyLightningLayer,
} from './lightning-layer.js';
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

function draw(classes: readonly (0 | 1 | 2)[] = [2, 1, 0]): LightningDraw {
  return {
    collection: {
      type: 'FeatureCollection',
      features: classes.map((ageClass, index) => ({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [24 + index * 0.1, 42.5] },
        properties: { ageClass },
      })),
    },
    attribution: 'Contains modified EUMETSAT Meteosat data 2026',
  };
}

function withFireLayers(): FakeHost {
  const host = new FakeHost();
  for (const id of FIRE_LAYER_IDS) host.layers.push(id);
  return host;
}

describe('applyLightningLayer', () => {
  it('draws the flashes under every fire layer, with the EUMETSAT credit on the source', () => {
    const host = withFireLayers();
    applyLightningLayer(host, draw());
    expect(host.layers.indexOf(LIGHTNING_LAYER_ID)).toBe(0);
    const source = host.sources.get(LIGHTNING_SOURCE_ID) as {
      attribution: string;
      data: { features: { properties: { ageClass: number } }[] };
    };
    expect(source.attribution).toBe('Contains modified EUMETSAT Meteosat data 2026');
    expect(source.data.features.map((feature) => feature.properties.ageClass)).toEqual([2, 1, 0]);
  });

  it('is idempotent, replaces the source for a new draw, and removes everything for null', () => {
    const host = withFireLayers();
    const first = draw();
    applyLightningLayer(host, first);
    const source = host.sources.get(LIGHTNING_SOURCE_ID);
    applyLightningLayer(host, first);
    expect(host.sources.get(LIGHTNING_SOURCE_ID)).toBe(source);

    applyLightningLayer(host, draw([0]));
    expect(host.sources.get(LIGHTNING_SOURCE_ID)).not.toBe(source);
    expect(host.layers.filter((id) => id === LIGHTNING_LAYER_ID)).toHaveLength(1);

    applyLightningLayer(host, null);
    expect(host.getLayer(LIGHTNING_LAYER_ID)).toBeUndefined();
    expect(host.getSource(LIGHTNING_SOURCE_ID)).toBeUndefined();
    applyLightningLayer(host, null);
  });

  it('redraws after a style swap dropped its source and layer', () => {
    const host = withFireLayers();
    const wanted = draw();
    applyLightningLayer(host, wanted);
    host.sources.clear();
    host.layers = [...FIRE_LAYER_IDS];
    applyLightningLayer(host, wanted);
    expect(host.getLayer(LIGHTNING_LAYER_ID)).toBeDefined();
    expect(host.getSource(LIGHTNING_SOURCE_ID)).toBeDefined();
  });
});

describe('the lightning layer spec', () => {
  it('passes MapLibre’s style-spec validator', () => {
    const style = {
      version: 8,
      sources: {
        [LIGHTNING_SOURCE_ID]: {
          type: 'geojson',
          data: { type: 'FeatureCollection', features: [] },
        },
      },
      layers: [LIGHTNING_LAYER],
    } as unknown as StyleSpecification;
    expect(validateStyleMin(style).map((error) => error.message)).toEqual([]);
  });

  it('paints no age class, and no ring, in the red–orange band fire owns (CI-14)', () => {
    for (const entry of LIGHTNING_AGE_CLASSES) {
      expect(isFireHue(parseColor(entry.color))).toBe(false);
    }
    expect(isFireHue(parseColor(LIGHTNING_RING_COLOR))).toBe(false);
    expect(LIGHTNING_LAYER_ID.startsWith('fire-')).toBe(false);
  });
});
