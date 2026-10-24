/**
 * V2-F1: drawing the Natura 2000 sites. Idempotent over its input, removable, stacked
 * under the static hot-source mask, the wind arrows and every fire layer, valid MapLibre,
 * and never in fire's colour band (CI-14).
 */

import { validateStyleMin } from '@maplibre/maplibre-gl-style-spec';
import type { StyleSpecification } from '@maplibre/maplibre-gl-style-spec';
import type { AddLayerObject, SourceSpecification } from 'maplibre-gl';
import { describe, expect, it } from 'vitest';

import { parseColor, toOklch } from '../core/color/color.js';
import {
  PROTECTED_SITES_FORMAT,
  parseProtectedSites,
  protectedSitesGeoJson,
} from '../core/geo/protected-sites.js';
import type { LayerHost } from './layer-host.js';
import { FIRE_LAYER_IDS } from './layer-registry.js';
import {
  PROTECTED_SITES_COLOR,
  PROTECTED_SITES_LAYER_IDS,
  PROTECTED_SITES_LINE_COLOR,
  PROTECTED_SITES_SOURCE_ID,
  applyProtectedSitesLayer,
} from './protected-sites-layer.js';
import { STATIC_SOURCES_LAYER_IDS } from './static-sources-layer.js';
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

const PARSED = parseProtectedSites({
  format: PROTECTED_SITES_FORMAT,
  version: 'natura2000_test',
  licence: 'CC-BY-4.0',
  attribution: 'test',
  scale: 1000,
  types: ['spa', 'sci', 'spa_sci'],
  sites: [['BG0000001', 'Alpha', 1, [[[24000, 42000, 500, 0, 0, 500, -500, 0]]]]],
});

const SITES = protectedSitesGeoJson(PARSED);

describe('applyProtectedSitesLayer', () => {
  it('adds under the mask, the wind arrows and the fire layers, once, and removes on null', () => {
    const host = new FakeHost();
    const above = [...STATIC_SOURCES_LAYER_IDS, WIND_LAYER_ID, ...FIRE_LAYER_IDS];
    host.layers = [...above];
    applyProtectedSitesLayer(host, SITES);
    applyProtectedSitesLayer(host, SITES);
    expect(host.layers).toEqual([...PROTECTED_SITES_LAYER_IDS, ...above]);
    applyProtectedSitesLayer(host, null);
    expect(host.layers).toEqual(above);
    expect(host.getSource(PROTECTED_SITES_SOURCE_ID)).toBeUndefined();
    applyProtectedSitesLayer(host, null);
  });

  it('puts itself back after a style swap drops everything', () => {
    const host = new FakeHost();
    applyProtectedSitesLayer(host, SITES);
    host.sources.clear();
    host.specs.clear();
    host.layers = [...FIRE_LAYER_IDS];
    applyProtectedSitesLayer(host, SITES);
    expect(host.layers.slice(0, 2)).toEqual([...PROTECTED_SITES_LAYER_IDS]);
  });

  it('assembles into a style MapLibre accepts', () => {
    const host = new FakeHost();
    applyProtectedSitesLayer(host, SITES);
    const style = {
      version: 8,
      sources: Object.fromEntries(host.sources),
      layers: host.layers.map((id) => host.specs.get(id)),
    } as unknown as StyleSpecification;
    expect(validateStyleMin(style)).toEqual([]);
  });

  it('paints outside the band fire owns (CI-14)', () => {
    for (const hex of [PROTECTED_SITES_COLOR, PROTECTED_SITES_LINE_COLOR]) {
      expect(isFireHue(parseColor(hex)), `${hex} ${JSON.stringify(toOklch(parseColor(hex)))}`).toBe(
        false,
      );
    }
  });
});
