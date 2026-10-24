/**
 * V2-A1, the drawing half: the replay's source and layer against a fake host with MapLibre's
 * duplicate and in-use errors, the live layers hidden and restored around it, and the layer
 * against MapLibre's own validator and the fire palette (CI-14).
 */

import { validateStyleMin } from '@maplibre/maplibre-gl-style-spec';
import type { StyleSpecification } from '@maplibre/maplibre-gl-style-spec';
import type { AddLayerObject, FilterSpecification, SourceSpecification } from 'maplibre-gl';
import { describe, expect, it } from 'vitest';

import { PLAYBACK_AGE_CLASSES } from '../core/history-body.js';
import type { PlaybackDraw } from '../core/playback.js';
import {
  COLOR_CONFIRMED,
  COLOR_DETECTION,
  COLOR_LIKELY,
  COLOR_NO_LONGER_DETECTED,
  FIRE_LAYER_IDS,
} from './layer-registry.js';
import {
  PLAYBACK_LAYER_ID,
  PLAYBACK_SOURCE_ID,
  applyPlaybackLayer,
  playbackFilter,
  playbackLayer,
  type PlaybackHost,
} from './playback-layer.js';

class FakeHost implements PlaybackHost {
  readonly sources = new Map<string, SourceSpecification>();
  layers: string[] = [];
  readonly specs = new Map<string, AddLayerObject>();
  readonly filters = new Map<string, FilterSpecification | null>();
  readonly paint: { id: string; name: string; value: unknown }[] = [];
  readonly visibility = new Map<string, unknown>();

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
  setFilter(id: string, filter: FilterSpecification | null): unknown {
    if (!this.layers.includes(id)) throw new Error(`no layer: ${id}`);
    this.filters.set(id, filter);
    return undefined;
  }
  setPaintProperty(id: string, name: string, value: unknown): unknown {
    if (!this.layers.includes(id)) throw new Error(`no layer: ${id}`);
    this.paint.push({ id, name, value });
    return undefined;
  }
  getLayoutProperty(id: string, name: string): unknown {
    if (!this.layers.includes(id)) throw new Error(`no layer: ${id}`);
    return name === 'visibility' ? this.visibility.get(id) : undefined;
  }
  setLayoutProperty(id: string, name: string, value: unknown): unknown {
    if (!this.layers.includes(id)) throw new Error(`no layer: ${id}`);
    if (name === 'visibility') this.visibility.set(id, value);
    return undefined;
  }
}

function collection(): PlaybackDraw['collection'] {
  return {
    type: 'FeatureCollection',
    features: [5, 90, 600].map((t, index) => ({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [25 + index * 0.1, 42.5] },
      properties: { t, frp: index === 1 ? null : 12, e: -1 },
    })),
  };
}

const CREDIT = 'NASA FIRMS';

function withFireLayers(): FakeHost {
  const host = new FakeHost();
  for (const id of FIRE_LAYER_IDS) host.layers.push(id);
  return host;
}

describe('applyPlaybackLayer', () => {
  it('draws the replay on top with the credit on the source, and hides the live fire layers', () => {
    const host = withFireLayers();
    applyPlaybackLayer(host, { collection: collection(), attribution: CREDIT, cursor: 100 });
    expect(host.layers.at(-1)).toBe(PLAYBACK_LAYER_ID);
    const source = host.sources.get(PLAYBACK_SOURCE_ID) as { attribution: string };
    expect(source.attribution).toBe(CREDIT);
    for (const id of FIRE_LAYER_IDS) expect(host.visibility.get(id)).toBe('none');
  });

  it('moves the cursor with a filter and paint update, never a re-upload', () => {
    const host = withFireLayers();
    const points = collection();
    applyPlaybackLayer(host, { collection: points, attribution: CREDIT, cursor: 100 });
    const source = host.sources.get(PLAYBACK_SOURCE_ID);
    applyPlaybackLayer(host, { collection: points, attribution: CREDIT, cursor: 700 });
    expect(host.sources.get(PLAYBACK_SOURCE_ID)).toBe(source);
    expect(host.filters.get(PLAYBACK_LAYER_ID)).toEqual(playbackFilter(700));
    expect(host.paint.map((entry) => entry.name)).toEqual(['circle-color', 'circle-opacity']);

    applyPlaybackLayer(host, { collection: points, attribution: CREDIT, cursor: 700 });
    expect(host.paint).toHaveLength(2);
  });

  it('replaces the source for a new window and restores the live layers for null', () => {
    const host = withFireLayers();
    applyPlaybackLayer(host, { collection: collection(), attribution: CREDIT, cursor: 100 });
    const source = host.sources.get(PLAYBACK_SOURCE_ID);
    applyPlaybackLayer(host, { collection: collection(), attribution: CREDIT, cursor: 100 });
    expect(host.sources.get(PLAYBACK_SOURCE_ID)).not.toBe(source);
    expect(host.layers.filter((id) => id === PLAYBACK_LAYER_ID)).toHaveLength(1);

    applyPlaybackLayer(host, null);
    expect(host.getLayer(PLAYBACK_LAYER_ID)).toBeUndefined();
    expect(host.getSource(PLAYBACK_SOURCE_ID)).toBeUndefined();
    for (const id of FIRE_LAYER_IDS) expect(host.visibility.get(id)).toBe('visible');
    applyPlaybackLayer(host, null);
  });

  it('leaves a live map untouched when there never was a replay', () => {
    const host = withFireLayers();
    applyPlaybackLayer(host, null);
    expect(host.visibility.size).toBe(0);
  });

  it('redraws after a style swap dropped its source and layer', () => {
    const host = withFireLayers();
    const wanted = { collection: collection(), attribution: CREDIT, cursor: 100 };
    applyPlaybackLayer(host, wanted);
    host.sources.clear();
    host.layers = [...FIRE_LAYER_IDS];
    host.visibility.clear();
    applyPlaybackLayer(host, wanted);
    expect(host.getLayer(PLAYBACK_LAYER_ID)).toBeDefined();
    expect(host.getSource(PLAYBACK_SOURCE_ID)).toBeDefined();
    for (const id of FIRE_LAYER_IDS) expect(host.visibility.get(id)).toBe('none');
  });
});

describe('the playback layer spec', () => {
  it('passes MapLibre’s style-spec validator', () => {
    const style = {
      version: 8,
      sources: {
        [PLAYBACK_SOURCE_ID]: {
          type: 'geojson',
          data: { type: 'FeatureCollection', features: [] },
        },
      },
      layers: [playbackLayer(0), playbackLayer(10_080)],
    } as unknown as StyleSpecification;
    const messages = validateStyleMin(style).map((error) => error.message);
    // Two copies of one id are expected to clash; nothing else may.
    expect(messages.filter((message) => !message.includes('duplicate'))).toEqual([]);
  });

  it('is fire-owned and paints only the fire registry’s own colours (CI-14)', () => {
    expect(PLAYBACK_LAYER_ID.startsWith('fire-')).toBe(true);
    expect(PLAYBACK_AGE_CLASSES.map((entry) => entry.color)).toEqual([
      COLOR_CONFIRMED,
      COLOR_DETECTION,
      COLOR_LIKELY,
      COLOR_NO_LONGER_DETECTED,
    ]);
  });
});
