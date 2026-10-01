/**
 * F14, the drawing half: the arrows' source, images and layer against a fake host with
 * MapLibre's duplicate and in-use errors, and the layer against MapLibre's own validator.
 */

import { validateStyleMin } from '@maplibre/maplibre-gl-style-spec';
import type { StyleSpecification } from '@maplibre/maplibre-gl-style-spec';
import type { AddLayerObject, SourceSpecification } from 'maplibre-gl';
import { describe, expect, it } from 'vitest';

import { parseColor } from '../core/color/color.js';
import { WIND_SPEED_CLASSES, type WindOverlayBody } from '../core/wind.js';
import { EFFIS_FWI_LAYER_ID, applyEffisOverlays } from './effis-overlays.js';
import { FIRE_LAYER_IDS } from './layer-registry.js';
import { isFireHue } from './style-colors.js';
import {
  WIND_ARROW_IMAGE_PREFIX,
  WIND_LAYER,
  WIND_LAYER_ID,
  WIND_SOURCE_ID,
  type WindImage,
  type WindLayerHost,
  applyWindLayer,
  windArrowImage,
} from './wind-layer.js';

class FakeHost implements WindLayerHost {
  readonly sources = new Map<string, SourceSpecification>();
  readonly images = new Map<string, WindImage>();
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
  hasImage(id: string): boolean {
    return this.images.has(id);
  }
  addImage(id: string, image: WindImage): unknown {
    if (this.images.has(id)) throw new Error(`duplicate image: ${id}`);
    this.images.set(id, image);
    return undefined;
  }
}

function body(speeds: readonly number[] = [1, 3, 6, 9, 14, 0]): WindOverlayBody {
  return {
    schema_version: 1,
    provider: 'ecmwf-open-data',
    model: 'ifs',
    run_at: '2026-09-30T00:00:00Z',
    step_hours: 3,
    valid_at: '2026-09-30T03:00:00Z',
    available_at: '2026-09-30T07:40:00Z',
    grid: {
      west: 20,
      south: 45.5,
      east: 21,
      north: 46,
      resolution_deg: 0.5,
      cols: 3,
      rows: 2,
      order: 'north_to_south_west_to_east',
    },
    speed_ms: speeds,
    direction_from_deg: [0, 90, 180, 270, 45, 315],
    wind_overlay_version: 'wind_overlay_v1',
  };
}

function withFireLayers(): FakeHost {
  const host = new FakeHost();
  for (const id of FIRE_LAYER_IDS) host.layers.push(id);
  return host;
}

describe('applyWindLayer', () => {
  it('draws one arrow per cell, with an image per speed class, under every fire layer', () => {
    const host = withFireLayers();
    applyWindLayer(host, body());
    expect(host.layers.indexOf(WIND_LAYER_ID)).toBe(0);
    expect([...host.images.keys()]).toEqual(
      WIND_SPEED_CLASSES.map((_, index) => `${WIND_ARROW_IMAGE_PREFIX}${String(index)}`),
    );
    const source = host.sources.get(WIND_SOURCE_ID) as {
      data: { features: { properties: { speedClass: number; bearing: number } }[] };
    };
    expect(source.data.features.map((feature) => feature.properties.speedClass)).toEqual([
      0, 1, 2, 3, 4, 0,
    ]);
    expect(source.data.features.map((feature) => feature.properties.bearing)).toEqual([
      180, 270, 0, 90, 225, 135,
    ]);
  });

  it('sits above the EFFIS overlays', () => {
    const host = withFireLayers();
    applyEffisOverlays(host, { fwiImageUrl: 'blob:x', burntAreas: null, attribution: '' });
    applyWindLayer(host, body());
    expect(host.layers.indexOf(WIND_LAYER_ID)).toBeGreaterThan(
      host.layers.indexOf(EFFIS_FWI_LAYER_ID),
    );
    expect(host.layers.indexOf(WIND_LAYER_ID)).toBeLessThan(host.layers.indexOf(FIRE_LAYER_IDS[0]));
  });

  it('is idempotent, replaces the source for a new step, and removes everything for null', () => {
    const host = withFireLayers();
    const first = body();
    applyWindLayer(host, first);
    const source = host.sources.get(WIND_SOURCE_ID);
    applyWindLayer(host, first);
    expect(host.sources.get(WIND_SOURCE_ID)).toBe(source);

    applyWindLayer(host, body([2, 2, 2, 2, 2, 2]));
    expect(host.sources.get(WIND_SOURCE_ID)).not.toBe(source);
    expect(host.layers.filter((id) => id === WIND_LAYER_ID)).toHaveLength(1);

    applyWindLayer(host, null);
    expect(host.getLayer(WIND_LAYER_ID)).toBeUndefined();
    expect(host.getSource(WIND_SOURCE_ID)).toBeUndefined();
    applyWindLayer(host, null);
  });

  it('redraws after a style swap dropped sources, layers and images', () => {
    const host = withFireLayers();
    const wanted = body();
    applyWindLayer(host, wanted);
    // What `setStyle` leaves behind: the fire layers re-added, nothing of ours.
    host.sources.clear();
    host.images.clear();
    host.layers = [...FIRE_LAYER_IDS];
    applyWindLayer(host, wanted);
    expect(host.getLayer(WIND_LAYER_ID)).toBeDefined();
    expect(host.images.size).toBe(WIND_SPEED_CLASSES.length);
  });
});

describe('the wind layer spec', () => {
  it('passes MapLibre’s style-spec validator', () => {
    const style = {
      version: 8,
      sources: {
        [WIND_SOURCE_ID]: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } },
      },
      layers: [WIND_LAYER],
    } as unknown as StyleSpecification;
    expect(validateStyleMin(style).map((error) => error.message)).toEqual([]);
  });

  it('paints no speed in the red–orange band fire owns (CI-14)', () => {
    for (const entry of WIND_SPEED_CLASSES) expect(isFireHue(parseColor(entry.color))).toBe(false);
  });
});

describe('windArrowImage', () => {
  it('is an opaque arrow in its colour on a transparent square, pointing north', () => {
    const image = windArrowImage('#3fa7b5');
    expect(image.width).toBe(image.height);
    expect(image.data).toHaveLength(image.width * image.height * 4);
    const pixel = (x: number, y: number) => {
      const at = (y * image.width + x) * 4;
      return [...image.data.slice(at, at + 4)];
    };
    const mid = image.width / 2;
    // The shaft's centre, below the head.
    expect(pixel(mid, Math.round(image.height * 0.7))).toEqual([0x3f, 0xa7, 0xb5, 255]);
    // The head is wide near the top-middle and absent at the bottom corners.
    expect(pixel(Math.round(mid - image.width * 0.2), Math.round(image.height * 0.42))[3]).toBe(
      255,
    );
    expect(pixel(0, image.height - 1)).toEqual([0, 0, 0, 0]);
  });
});
