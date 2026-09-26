/**
 * The registry against MapLibre's own style-spec validator.
 *
 * The fake hosts in `layer-registry.test.ts` accept any object shaped like a layer, so a
 * paint expression MapLibre refuses at `addLayer` time passed them all — the fire dots and
 * the selection ring shipped with a `["zoom"]` interpolate nested inside `*`, which MapLibre
 * rejects ("zoom" may only feed a top-level step/interpolate) and so never drew. Here every
 * source and layer the registry applies is assembled into a style and run through
 * `validateStyleMin` — the same parser (`createPropertyExpression`) MapLibre uses — so
 * that whole class of error fails a unit test instead of a map.
 */

import {
  createPropertyExpression,
  latest,
  validateStyleMin,
} from '@maplibre/maplibre-gl-style-spec';
import type { StyleSpecification } from '@maplibre/maplibre-gl-style-spec';
import { describe, expect, it } from 'vitest';

import type { AddLayerObject, SourceSpecification } from 'maplibre-gl';

import type { LayerHost } from './layer-registry.js';
import {
  FIRE_DOT_LAYER_ID,
  FIRE_LAYER_IDS,
  SELECTED_RING_LAYER_ID,
  applyFireLayers,
} from './layer-registry.js';

/** Collects what `applyFireLayers` adds, in order. */
function registryStyle(): StyleSpecification {
  const sources: Record<string, SourceSpecification> = {};
  const layers: AddLayerObject[] = [];
  const host: LayerHost = {
    getSource: (id) => sources[id],
    addSource: (id, source) => {
      sources[id] = source;
    },
    getLayer: (id) => layers.find((layer) => layer.id === id),
    addLayer: (layer) => {
      layers.push(layer);
    },
  };
  applyFireLayers(host);
  // The registry adds no inline-source layers and no custom layers, so every layer it adds
  // is a plain LayerSpecification; the cast only narrows AddLayerObject's union.
  return { version: 8, sources, layers } as unknown as StyleSpecification;
}

function messages(style: StyleSpecification): string[] {
  return validateStyleMin(style).map((error) => error.message);
}

describe('layer registry — MapLibre style-spec validity', () => {
  const style = registryStyle();

  it('assembles every registry layer into the validated style', () => {
    expect(style.layers.map((layer) => layer.id)).toStrictEqual([...FIRE_LAYER_IDS]);
  });

  it('passes validateStyleMin with no errors — every layer, every expression', () => {
    expect(messages(style)).toStrictEqual([]);
  });

  it.each([FIRE_DOT_LAYER_ID, SELECTED_RING_LAYER_ID])(
    '%s validates on its own (its circle-radius is zoom- and data-driven)',
    (layerId) => {
      const layer = style.layers.find((candidate) => candidate.id === layerId);
      expect(layer).toBeDefined();
      expect(messages({ ...style, layers: layer === undefined ? [] : [layer] })).toStrictEqual([]);
    },
  );

  /**
   * The restructure must not move a single pixel: the radius the old nested form meant —
   * `offset + unverified × area(ha) × k(zoom)`, `k` linear between its stops and clamped
   * outside them — computed independently here and compared across zooms between and
   * beyond the stops.
   */
  it.each([
    [FIRE_DOT_LAYER_ID, 0],
    [SELECTED_RING_LAYER_ID, 5],
  ] as const)('%s radius equals offset + base × zoom factor at every zoom', (layerId, offset) => {
    const layer = style.layers.find((candidate) => candidate.id === layerId);
    const paint = layer?.type === 'circle' ? layer.paint : undefined;
    const parsed = createPropertyExpression(
      paint?.['circle-radius'],
      'circle-radius',
      latest.paint_circle['circle-radius'] as Parameters<typeof createPropertyExpression>[2],
    );
    if (parsed.result !== 'success') throw new Error(JSON.stringify(parsed.value));

    const lerp = (x: number, stops: readonly (readonly [number, number])[]): number => {
      const first = stops[0]!;
      const last = stops[stops.length - 1]!;
      if (x <= first[0]) return first[1];
      if (x >= last[0]) return last[1];
      for (let i = 1; i < stops.length; i += 1) {
        const [x1, y1] = stops[i]!;
        const [x0, y0] = stops[i - 1]!;
        if (x <= x1) return y0 + ((y1 - y0) * (x - x0)) / (x1 - x0);
      }
      return last[1];
    };
    const zoomFactor = [
      [4, 0.9],
      [6, 1],
      [11, 1.4],
      [16, 1.8],
    ] as const;
    const areaRadius = [
      [0, 5],
      [200, 7],
      [2000, 10],
    ] as const;

    for (const zoom of [2, 4, 5, 6, 7.5, 9, 11, 13.25, 16, 20]) {
      for (const bucket of ['confirmed', 'unverified']) {
        for (const area of [null, 0, 50, 200, 900, 2000, 9000]) {
          const actual = parsed.value.evaluate(
            { zoom },
            { type: 'Point', properties: { score_bucket: bucket, area_ha: area } },
          ) as number;
          const expected =
            offset +
            (bucket === 'unverified' ? 0.75 : 1) *
              lerp(area ?? 0, areaRadius) *
              lerp(zoom, zoomFactor);
          expect(actual, `z${zoom} ${bucket} ${String(area)} ha`).toBeCloseTo(expected, 9);
        }
      }
    }
  });

  it('is a validator that catches a zoom interpolate nested below the top level', () => {
    // The exact shape of the defect — proves the gate above is not vacuous.
    const broken: StyleSpecification = {
      ...style,
      layers: [
        {
          id: 'nested-zoom',
          type: 'circle',
          source: 'fire-events',
          paint: {
            'circle-radius': [
              '*',
              ['get', 'r'],
              ['interpolate', ['linear'], ['zoom'], 4, 1, 16, 2],
            ],
          },
        },
      ],
    };
    expect(messages(broken).join('\n')).toMatch(/"zoom" expression may only be used/);
  });
});
