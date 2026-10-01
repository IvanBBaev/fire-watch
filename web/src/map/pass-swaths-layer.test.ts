/**
 * F15, the drawing half: the swath source and layers against a fake host with MapLibre's
 * duplicate and in-use errors, the stacking under the fire layers, the CelesTrak credit on
 * the source (CI-13), labels only where the style can render text, and the specs against
 * MapLibre's own validator and the fire-owns-red rule (CI-14).
 */

import { validateStyleMin } from '@maplibre/maplibre-gl-style-spec';
import type { StyleSpecification } from '@maplibre/maplibre-gl-style-spec';
import type { AddLayerObject, SourceSpecification } from 'maplibre-gl';
import { describe, expect, it } from 'vitest';

import { parseColor } from '../core/color/color.js';
import {
  PASS_NEXT_COLOR,
  PASS_RECENT_COLOR,
  type PassSwathsDraw,
  type SwathDisplay,
} from '../core/pass-swaths.js';
import { FIRE_LAYER_IDS } from './layer-registry.js';
import {
  PASS_SWATHS_FILL_LAYER,
  PASS_SWATHS_FILL_LAYER_ID,
  PASS_SWATHS_LABEL_LAYER_ID,
  PASS_SWATHS_OUTLINE_LAYER,
  PASS_SWATHS_OUTLINE_LAYER_ID,
  PASS_SWATHS_SOURCE_ID,
  PASS_SWATHS_TRACK_LAYER,
  PASS_SWATHS_TRACK_LAYER_ID,
  type PassSwathsLayerHost,
  applyPassSwathsLayer,
  labelFontOf,
  passSwathsLabelLayer,
} from './pass-swaths-layer.js';
import { isFireHue } from './style-colors.js';

class FakeHost implements PassSwathsLayerHost {
  readonly sources = new Map<string, SourceSpecification>();
  layers: string[] = [];
  readonly specs = new Map<string, AddLayerObject>();
  style: { glyphs?: unknown; layers?: unknown[] } | undefined = undefined;

  getStyle(): { glyphs?: unknown; layers?: unknown[] } | undefined {
    return this.style;
  }
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

const FONT = ['Noto Sans Regular'];

function withFireLayers(textStyle = false): FakeHost {
  const host = new FakeHost();
  for (const id of FIRE_LAYER_IDS) host.layers.push(id);
  if (textStyle) {
    host.style = {
      glyphs: 'https://tiles.example/fonts/{fontstack}/{range}.pbf',
      layers: [
        { id: 'bg', type: 'background' },
        { id: 'place', layout: { 'text-font': FONT } },
      ],
    };
  }
  return host;
}

const PROPS = {
  platform: 'noaa20',
  instrument: 'viirs',
  start: '2026-09-30T12:34:00Z',
  mid: '2026-09-30T12:38:30Z',
  end: '2026-09-30T12:43:00Z',
  label: 'NOAA-20 15:38',
} as const;

function draw(kind: 'next' | 'recent' = 'next'): PassSwathsDraw {
  const features: SwathDisplay['collection']['features'] = [
    {
      type: 'Feature',
      properties: { ...PROPS, kind, part: 'swath' },
      geometry: {
        type: 'Polygon',
        coordinates: [
          [
            [20, 40],
            [30, 40],
            [30, 45],
            [20, 45],
            [20, 40],
          ],
        ],
      },
    },
    {
      type: 'Feature',
      properties: { ...PROPS, kind, part: 'track' },
      geometry: {
        type: 'LineString',
        coordinates: [
          [25, 40],
          [25, 45],
        ],
      },
    },
    {
      type: 'Feature',
      properties: { ...PROPS, kind, part: 'label' },
      geometry: { type: 'Point', coordinates: [25, 42.5] },
    },
  ];
  return {
    collection: { type: 'FeatureCollection', features },
    attribution: 'Orbital elements: CelesTrak',
  };
}

const OWN_LAYERS = [
  PASS_SWATHS_FILL_LAYER_ID,
  PASS_SWATHS_OUTLINE_LAYER_ID,
  PASS_SWATHS_TRACK_LAYER_ID,
] as const;

describe('applyPassSwathsLayer', () => {
  it('draws fill, outline and track under every fire layer, bottom to top', () => {
    const host = withFireLayers();
    applyPassSwathsLayer(host, draw());
    expect(host.layers.slice(0, 3)).toEqual([...OWN_LAYERS]);
    expect(host.layers.slice(3)).toEqual([...FIRE_LAYER_IDS]);
  });

  it('carries the CelesTrak credit on the source, so the map corner shows it (CI-13)', () => {
    const host = withFireLayers();
    applyPassSwathsLayer(host, draw());
    const source = host.sources.get(PASS_SWATHS_SOURCE_ID) as { attribution?: string };
    expect(source.attribution).toBe('Orbital elements: CelesTrak');
  });

  it('adds no label layer where the style cannot render text', () => {
    const host = withFireLayers();
    applyPassSwathsLayer(host, draw());
    expect(host.getLayer(PASS_SWATHS_LABEL_LAYER_ID)).toBeUndefined();
  });

  it('labels in the style’s own font stack when it has glyphs', () => {
    const host = withFireLayers(true);
    applyPassSwathsLayer(host, draw());
    const label = host.specs.get(PASS_SWATHS_LABEL_LAYER_ID) as {
      layout: Record<string, unknown>;
    };
    expect(label.layout['text-font']).toEqual(FONT);
    expect(host.layers.indexOf(PASS_SWATHS_LABEL_LAYER_ID)).toBeLessThan(
      host.layers.indexOf(FIRE_LAYER_IDS[0]),
    );
  });

  it('is idempotent, replaces the source for a new draw, and removes everything for null', () => {
    const host = withFireLayers(true);
    const first = draw();
    applyPassSwathsLayer(host, first);
    const source = host.sources.get(PASS_SWATHS_SOURCE_ID);
    applyPassSwathsLayer(host, first);
    expect(host.sources.get(PASS_SWATHS_SOURCE_ID)).toBe(source);

    applyPassSwathsLayer(host, draw('recent'));
    expect(host.sources.get(PASS_SWATHS_SOURCE_ID)).not.toBe(source);
    expect(host.layers.filter((id) => id === PASS_SWATHS_FILL_LAYER_ID)).toHaveLength(1);

    applyPassSwathsLayer(host, null);
    expect(host.layers).toEqual([...FIRE_LAYER_IDS]);
    expect(host.getSource(PASS_SWATHS_SOURCE_ID)).toBeUndefined();
    applyPassSwathsLayer(host, null);
  });

  it('redraws after a style swap dropped its source and layers', () => {
    const host = withFireLayers();
    const wanted = draw();
    applyPassSwathsLayer(host, wanted);
    host.sources.clear();
    host.layers = [...FIRE_LAYER_IDS];
    applyPassSwathsLayer(host, wanted);
    expect(host.layers.slice(0, 3)).toEqual([...OWN_LAYERS]);
  });
});

describe('labelFontOf', () => {
  it('is null without glyphs, without a literal font stack, or when the style throws', () => {
    const host = new FakeHost();
    expect(labelFontOf(host)).toBeNull();
    host.style = { layers: [{ layout: { 'text-font': FONT } }] };
    expect(labelFontOf(host)).toBeNull();
    host.style = { glyphs: 'g', layers: [{ layout: { 'text-font': [1] } }, { id: 'x' }] };
    expect(labelFontOf(host)).toBeNull();
    host.getStyle = () => {
      throw new Error('style not loaded');
    };
    expect(labelFontOf(host)).toBeNull();
  });
});

describe('the swath layer specs', () => {
  it('pass MapLibre’s style-spec validator', () => {
    const style = {
      version: 8,
      glyphs: 'https://tiles.example/fonts/{fontstack}/{range}.pbf',
      sources: {
        [PASS_SWATHS_SOURCE_ID]: {
          type: 'geojson',
          data: { type: 'FeatureCollection', features: [] },
        },
      },
      layers: [
        PASS_SWATHS_FILL_LAYER,
        PASS_SWATHS_OUTLINE_LAYER,
        PASS_SWATHS_TRACK_LAYER,
        passSwathsLabelLayer(FONT),
      ],
    } as unknown as StyleSpecification;
    expect(validateStyleMin(style).map((error) => error.message)).toEqual([]);
  });

  it('paint nothing in the red–orange band fire owns, under no fire- or alert- id (CI-14)', () => {
    for (const color of [PASS_NEXT_COLOR, PASS_RECENT_COLOR]) {
      expect(isFireHue(parseColor(color))).toBe(false);
    }
    for (const id of [...OWN_LAYERS, PASS_SWATHS_LABEL_LAYER_ID]) {
      expect(id).not.toMatch(/^(fire|alert)-/u);
    }
  });
});
