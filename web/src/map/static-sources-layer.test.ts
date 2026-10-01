/**
 * TASKS F16: drawing the static hot-source mask. Idempotent over its input, removable,
 * stacked under the wind arrows and every fire layer, valid MapLibre, and never in fire's
 * colour band (CI-14).
 */

import { validateStyleMin } from '@maplibre/maplibre-gl-style-spec';
import type { StyleSpecification } from '@maplibre/maplibre-gl-style-spec';
import {
  STATIC_SOURCE_FORMAT,
  STATIC_SOURCE_KINDS,
  parseStaticSourceMask,
} from '@fire-watch/contracts';
import type { AddLayerObject, SourceSpecification } from 'maplibre-gl';
import { describe, expect, it } from 'vitest';

import { parseColor, toOklch } from '../core/color/color.js';
import type { LayerHost } from './layer-host.js';
import { FIRE_LAYER_IDS } from './layer-registry.js';
import {
  STATIC_SOURCES_COLOR,
  STATIC_SOURCES_HALO_COLOR,
  STATIC_SOURCES_LAYER_IDS,
  STATIC_SOURCES_LINE_COLOR,
  STATIC_SOURCES_SOURCE_ID,
  applyStaticSourcesLayer,
  staticSourcesGeoJson,
} from './static-sources-layer.js';
import { isFireHue } from './style-colors.js';
import { WIND_LAYER_ID } from './wind-layer.js';

/** An ordered layer stack with MapLibre's duplicate, missing-id and in-use errors. */
class FakeHost implements LayerHost {
  readonly sources = new Map<string, SourceSpecification>();
  readonly specs = new Map<string, AddLayerObject>();
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

const MASK = parseStaticSourceMask({
  format: STATIC_SOURCE_FORMAT,
  version: 'test',
  licence: 'ODbL-1.0',
  attribution: '© OpenStreetMap contributors',
  scale: 10_000,
  kinds: [...STATIC_SOURCE_KINDS],
  sources: [
    [0, 250_000, 420_000, 100, 0, 0, 100, -100, 0],
    [3, 260_000, 430_000],
  ],
});

describe('staticSourcesGeoJson', () => {
  it('turns a ring into a closed polygon and a single vertex into a point', () => {
    const [park, flare] = staticSourcesGeoJson(MASK).features;
    expect(park?.geometry).toEqual({
      type: 'Polygon',
      coordinates: [
        [
          [25, 42],
          [25.01, 42],
          [25.01, 42.01],
          [25, 42.01],
          [25, 42],
        ],
      ],
    });
    expect(park?.properties).toEqual({ kind: 'solar' });
    expect(flare?.geometry).toEqual({ type: 'Point', coordinates: [26, 43] });
    expect(flare?.properties).toEqual({ kind: 'flare' });
  });
});

describe('applyStaticSourcesLayer', () => {
  it('adds under the wind arrows and the fire layers, once, and removes on null', () => {
    const host = new FakeHost();
    host.layers = [WIND_LAYER_ID, ...FIRE_LAYER_IDS];
    applyStaticSourcesLayer(host, MASK);
    applyStaticSourcesLayer(host, MASK);
    expect(host.layers).toEqual([...STATIC_SOURCES_LAYER_IDS, WIND_LAYER_ID, ...FIRE_LAYER_IDS]);
    applyStaticSourcesLayer(host, null);
    expect(host.layers).toEqual([WIND_LAYER_ID, ...FIRE_LAYER_IDS]);
    expect(host.getSource(STATIC_SOURCES_SOURCE_ID)).toBeUndefined();
    applyStaticSourcesLayer(host, null);
  });

  it('puts itself back after a style swap drops everything', () => {
    const host = new FakeHost();
    applyStaticSourcesLayer(host, MASK);
    host.sources.clear();
    host.specs.clear();
    host.layers = [...FIRE_LAYER_IDS];
    applyStaticSourcesLayer(host, MASK);
    expect(host.layers.slice(0, 3)).toEqual([...STATIC_SOURCES_LAYER_IDS]);
  });

  it('assembles into a style MapLibre accepts', () => {
    const host = new FakeHost();
    applyStaticSourcesLayer(host, MASK);
    const style = {
      version: 8,
      sources: Object.fromEntries(host.sources),
      layers: host.layers.map((id) => host.specs.get(id)),
    } as unknown as StyleSpecification;
    expect(validateStyleMin(style)).toEqual([]);
  });

  it('paints outside the band fire owns (CI-14)', () => {
    for (const hex of [
      STATIC_SOURCES_COLOR,
      STATIC_SOURCES_LINE_COLOR,
      STATIC_SOURCES_HALO_COLOR,
    ]) {
      expect(isFireHue(parseColor(hex)), `${hex} ${JSON.stringify(toOklch(parseColor(hex)))}`).toBe(
        false,
      );
    }
  });
});
