import { validateStyleMin } from '@maplibre/maplibre-gl-style-spec';
import type { StyleSpecification } from '@maplibre/maplibre-gl-style-spec';
import type { AddLayerObject, SourceSpecification } from 'maplibre-gl';
import { describe, expect, it } from 'vitest';

import { parseColor, toOklch } from '../core/color/color.js';
import {
  EFFIS_BA_FILL_COLOR,
  EFFIS_BA_FILL_LAYER_ID,
  EFFIS_BA_LINE_COLOR,
  EFFIS_BA_LINE_LAYER_ID,
  EFFIS_BA_SOURCE_ID,
  EFFIS_FWI_LAYER_ID,
  EFFIS_FWI_SOURCE_ID,
  EFFIS_OVERLAY_LAYER_IDS,
  type EffisOverlayState,
  NO_EFFIS_OVERLAYS,
  applyEffisOverlays,
} from './effis-overlays.js';
import { IMAGERY_LAYER_ID, type ImageryLayerHost, applyImageryLayer } from './imagery-layer.js';
import { FIRE_LAYER_IDS } from './layer-registry.js';
import { isFireHue } from './style-colors.js';

/** An ordered layer stack with MapLibre's duplicate, missing-id and in-use errors. */
class FakeHost implements ImageryLayerHost {
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

const BURNT: EffisOverlayState['burntAreas'] = {
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature',
      properties: { FIREDATE: '2026-09-20', AREA_HA: 42 },
      geometry: {
        type: 'Polygon',
        coordinates: [
          [
            [23.1, 42.1],
            [23.2, 42.1],
            [23.2, 42.2],
            [23.1, 42.1],
          ],
        ],
      },
    },
  ],
};

const CREDIT = '© European Union, 2026, European Forest Fire Information System (EFFIS)';
const BOTH: EffisOverlayState = {
  fwiImageUrl: 'blob:http://localhost/fwi-1',
  burntAreas: BURNT,
  attribution: CREDIT,
};

describe('applyEffisOverlays', () => {
  it('stacks FWI under the burnt areas, all under the lowest fire layer', () => {
    const host = new FakeHost();
    host.layers = ['basemap-land', 'basemap-labels', ...FIRE_LAYER_IDS];
    applyEffisOverlays(host, BOTH);
    expect(host.layers.slice(0, 6)).toEqual([
      'basemap-land',
      'basemap-labels',
      EFFIS_FWI_LAYER_ID,
      EFFIS_BA_FILL_LAYER_ID,
      EFFIS_BA_LINE_LAYER_ID,
      FIRE_LAYER_IDS[0],
    ]);
    expect(host.sources.get(EFFIS_FWI_SOURCE_ID)).toMatchObject({
      type: 'image',
      url: BOTH.fwiImageUrl,
      coordinates: [
        [20, 46],
        [31, 46],
        [31, 39],
        [20, 39],
      ],
    });
    expect(host.sources.get(EFFIS_BA_SOURCE_ID)).toMatchObject({
      type: 'geojson',
      data: BURNT,
      attribution: CREDIT,
    });
  });

  it('keeps the order whichever overlay is switched on first', () => {
    const host = new FakeHost();
    host.layers = [...FIRE_LAYER_IDS];
    applyEffisOverlays(host, { ...NO_EFFIS_OVERLAYS, burntAreas: BURNT, attribution: CREDIT });
    applyEffisOverlays(host, BOTH);
    expect(host.layers.slice(0, 3)).toEqual([...EFFIS_OVERLAY_LAYER_IDS]);
  });

  it('puts the imagery beneath the overlays, whichever comes first', () => {
    const host = new FakeHost();
    host.layers = ['basemap-land', ...FIRE_LAYER_IDS];
    applyEffisOverlays(host, BOTH);
    applyImageryLayer(host, 'https://tiles.example.test/{z}/{y}/{x}');
    expect(host.layers.slice(0, 5)).toEqual([
      'basemap-land',
      IMAGERY_LAYER_ID,
      ...EFFIS_OVERLAY_LAYER_IDS,
    ]);
  });

  it('is idempotent and removes layers before their sources', () => {
    const host = new FakeHost();
    applyEffisOverlays(host, BOTH);
    applyEffisOverlays(host, BOTH);
    expect(host.layers).toEqual([...EFFIS_OVERLAY_LAYER_IDS]);
    applyEffisOverlays(host, NO_EFFIS_OVERLAYS);
    applyEffisOverlays(host, NO_EFFIS_OVERLAYS);
    expect(host.layers).toEqual([]);
    expect(host.sources.size).toBe(0);
  });

  it('replaces a source whose payload changed', () => {
    const host = new FakeHost();
    applyEffisOverlays(host, BOTH);
    const next = { ...BOTH, fwiImageUrl: 'blob:http://localhost/fwi-2' };
    applyEffisOverlays(host, next);
    expect(host.sources.get(EFFIS_FWI_SOURCE_ID)).toMatchObject({ url: next.fwiImageUrl });
    expect(host.layers).toEqual([...EFFIS_OVERLAY_LAYER_IDS]);
  });

  it('comes back after a style swap wiped it', () => {
    const host = new FakeHost();
    applyEffisOverlays(host, BOTH);
    host.sources.clear();
    host.specs.clear();
    host.layers = [...FIRE_LAYER_IDS];
    applyEffisOverlays(host, BOTH);
    expect(host.layers.slice(0, 3)).toEqual([...EFFIS_OVERLAY_LAYER_IDS]);
  });

  it('assembles into a style MapLibre accepts', () => {
    const host = new FakeHost();
    applyEffisOverlays(host, BOTH);
    const style = {
      version: 8,
      sources: Object.fromEntries(host.sources),
      layers: host.layers.map((id) => host.specs.get(id)),
    } as unknown as StyleSpecification;
    expect(validateStyleMin(style)).toEqual([]);
  });

  it('paints the burnt areas outside the band fire owns (CI-14)', () => {
    for (const hex of [EFFIS_BA_FILL_COLOR, EFFIS_BA_LINE_COLOR]) {
      expect(isFireHue(parseColor(hex)), `${hex} ${JSON.stringify(toOklch(parseColor(hex)))}`).toBe(
        false,
      );
    }
  });
});
