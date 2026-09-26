import { describe, expect, it } from 'vitest';

import type {
  AddLayerObject,
  LayerSpecification,
  SourceSpecification,
  StyleSpecification,
} from 'maplibre-gl';

import type { PatternImage } from './hatch.js';
import type { ImageHost, LayerHost } from './layer-registry.js';
import {
  DETECTION_DOT_LAYER_ID,
  DETECTION_MIN_ZOOM,
  FIRE_CELL_LAYER_ID,
  FIRE_CELL_OUTLINE_LAYER_ID,
  FIRE_DETECTIONS_SOURCE_ID,
  FIRE_DETECTION_CELLS_SOURCE_ID,
  FIRE_DOT_LAYER_ID,
  FIRE_EVENTS_SOURCE_ID,
  FIRE_HEAT_LAYER_ID,
  FIRE_HULL_LAYER_ID,
  FIRE_LAYER_IDS,
  FIRE_LAYER_ID_PREFIX,
  FIRE_SOURCE_IDS,
  FOOTPRINT_MIN_ZOOM,
  HATCH_IMAGE_IDS,
  HEAT_MAX_ZOOM,
  HULL_MIN_ZOOM,
  INTERACTIVE_FIRE_LAYER_IDS,
  SELECTED_RING_LAYER_ID,
  applyFireImages,
  applyFireLayers,
  preserveFireStyle,
} from './layer-registry.js';

/**
 * Records adds and throws on duplicates — a stricter host than MapLibre itself, so an
 * idempotence bug fails loudly instead of relying on MapLibre's own duplicate errors.
 * `reset()` simulates what `setStyle` does: wipes every runtime source and layer.
 */
class FakeMapHost implements LayerHost {
  readonly sources = new Map<string, SourceSpecification>();
  readonly layers = new Map<string, AddLayerObject>();
  addSourceCalls = 0;
  addLayerCalls = 0;

  getSource(id: string): unknown {
    return this.sources.get(id);
  }

  addSource(id: string, source: SourceSpecification): unknown {
    if (this.sources.has(id)) throw new Error(`duplicate source: ${id}`);
    this.addSourceCalls += 1;
    this.sources.set(id, source);
    return undefined;
  }

  getLayer(id: string): unknown {
    return this.layers.get(id);
  }

  addLayer(layer: AddLayerObject): unknown {
    if (this.layers.has(layer.id)) throw new Error(`duplicate layer: ${layer.id}`);
    this.addLayerCalls += 1;
    this.layers.set(layer.id, layer);
    return undefined;
  }

  /** Simulate a `setStyle` wipe of all runtime sources and layers. */
  reset(): void {
    this.sources.clear();
    this.layers.clear();
  }
}

/** The image half of the same fake — `setStyle` drops runtime images too, so it resets. */
class FakeImageHost implements ImageHost {
  readonly images = new Map<string, PatternImage>();
  addImageCalls = 0;

  hasImage(id: string): boolean {
    return this.images.has(id);
  }

  addImage(id: string, image: PatternImage): unknown {
    if (this.images.has(id)) throw new Error(`duplicate image: ${id}`);
    this.addImageCalls += 1;
    this.images.set(id, image);
    return undefined;
  }

  reset(): void {
    this.images.clear();
  }
}

describe('applyFireImages', () => {
  it('registers one hatch tile per colour the cells can take', () => {
    const host = new FakeImageHost();
    applyFireImages(host);

    expect([...host.images.keys()].sort()).toEqual([...Object.values(HATCH_IMAGE_IDS)].sort());
  });

  it('is idempotent — a second apply adds nothing (the strict host would throw)', () => {
    const host = new FakeImageHost();
    applyFireImages(host);
    const afterFirst = host.addImageCalls;

    applyFireImages(host);

    expect(host.addImageCalls).toBe(afterFirst);
  });

  it('re-adds every tile after a style wipe — transformStyle cannot carry images', () => {
    const host = new FakeImageHost();
    applyFireImages(host);
    host.reset();
    applyFireImages(host);

    expect(host.images.size).toBe(Object.values(HATCH_IMAGE_IDS).length);
  });

  it('gives each id a distinct tile, so status is readable from the hatch alone', () => {
    const host = new FakeImageHost();
    applyFireImages(host);

    const rendered = [...host.images.values()].map((image) => image.data.join(','));
    expect(new Set(rendered).size).toBe(rendered.length);
  });

  it('keeps every image id under the fire- prefix, away from the basemap sprite', () => {
    for (const id of Object.values(HATCH_IMAGE_IDS)) {
      expect(id.startsWith(FIRE_LAYER_ID_PREFIX)).toBe(true);
    }
  });
});

describe('applyFireLayers', () => {
  it('adds both sources and every layer on a fresh style, bottom-to-top', () => {
    const host = new FakeMapHost();
    applyFireLayers(host);

    expect([...host.sources.keys()].sort()).toEqual([...FIRE_SOURCE_IDS].sort());
    expect([...host.layers.keys()]).toEqual([...FIRE_LAYER_IDS]);
  });

  it('is idempotent — a second apply adds nothing (and the strict host does not throw)', () => {
    const host = new FakeMapHost();
    applyFireLayers(host);
    const sourcesAfterFirst = host.addSourceCalls;
    const layersAfterFirst = host.addLayerCalls;

    applyFireLayers(host);

    expect(host.addSourceCalls).toBe(sourcesAfterFirst);
    expect(host.addLayerCalls).toBe(layersAfterFirst);
  });

  it('re-adds everything after a style wipe (the style.load re-apply path)', () => {
    const host = new FakeMapHost();
    applyFireLayers(host);
    host.reset();
    applyFireLayers(host);

    expect(host.sources.size).toBe(FIRE_SOURCE_IDS.length);
    expect(host.layers.size).toBe(FIRE_LAYER_IDS.length);
  });

  it('fills in only what is missing when a partial set survives', () => {
    const host = new FakeMapHost();
    applyFireLayers(host);
    host.layers.delete(SELECTED_RING_LAYER_ID);

    applyFireLayers(host);

    expect(host.layers.has(SELECTED_RING_LAYER_ID)).toBe(true);
    expect(host.layers.size).toBe(FIRE_LAYER_IDS.length);
  });

  it('configures fire-events as geojson with promoteId "id" — feature-state keys on public ids', () => {
    const host = new FakeMapHost();
    applyFireLayers(host);

    const source = host.sources.get(FIRE_EVENTS_SOURCE_ID);
    expect(source).toMatchObject({ type: 'geojson', promoteId: 'id' });
    expect(host.sources.get(FIRE_DETECTIONS_SOURCE_ID)).toMatchObject({ type: 'geojson' });
    expect(host.sources.get(FIRE_DETECTION_CELLS_SOURCE_ID)).toMatchObject({ type: 'geojson' });
  });

  it('never hides the event dot behind a zoom bound — the vanishing-fire regression', () => {
    const host = new FakeMapHost();
    applyFireLayers(host);

    const dot = host.layers.get(FIRE_DOT_LAYER_ID) as LayerSpecification;
    expect(dot).toMatchObject({ type: 'circle', source: FIRE_EVENTS_SOURCE_ID });
    // Zooming into a fire used to make it disappear: the dot stopped at zoom 11 and the
    // layers meant to take over (detections, hull) have no geometry for most events.
    expect(dot).not.toHaveProperty('minzoom');
    expect(dot).not.toHaveProperty('maxzoom');
  });

  it('grows the dot with zoom so it stays a legible anchor when zoomed in', () => {
    const host = new FakeMapHost();
    applyFireLayers(host);

    const dot = host.layers.get(FIRE_DOT_LAYER_ID) as LayerSpecification;
    const radius = JSON.stringify(
      (dot as { paint: Record<string, unknown> }).paint['circle-radius'],
    );
    expect(radius).toContain('"zoom"');
  });

  it('wires the rest of the ladder: heat below 6, hull from 7.5, detections from 11', () => {
    const host = new FakeMapHost();
    applyFireLayers(host);

    const heat = host.layers.get(FIRE_HEAT_LAYER_ID) as LayerSpecification;
    expect(heat).toMatchObject({
      type: 'heatmap',
      source: FIRE_EVENTS_SOURCE_ID,
      maxzoom: HEAT_MAX_ZOOM,
    });
    // The heat band must fade out rather than pop: opacity reaches 0 at the band edge.
    expect(JSON.stringify(heat)).toContain(`"heatmap-opacity"`);

    const hull = host.layers.get(FIRE_HULL_LAYER_ID) as LayerSpecification;
    expect(hull).toMatchObject({
      type: 'fill',
      source: FIRE_EVENTS_SOURCE_ID,
      minzoom: HULL_MIN_ZOOM,
    });
    // A real footprint is most useful at the zoom where the user wants the shape.
    expect(hull).not.toHaveProperty('maxzoom');

    const detection = host.layers.get(DETECTION_DOT_LAYER_ID) as LayerSpecification;
    expect(detection).toMatchObject({
      type: 'circle',
      source: FIRE_DETECTIONS_SOURCE_ID,
      minzoom: DETECTION_MIN_ZOOM,
    });
  });

  it('opens the footprint band between the hull and the detection dots', () => {
    // The ladder only reads as one progression if each rung starts where it should:
    // hull (7.5) → cells (9) → detection centres (11), with the event dot under all of them.
    expect(HULL_MIN_ZOOM).toBeLessThan(FOOTPRINT_MIN_ZOOM);
    expect(FOOTPRINT_MIN_ZOOM).toBeLessThan(DETECTION_MIN_ZOOM);
  });

  it('draws the detection cells as a hatched fill from the footprint zoom up', () => {
    const host = new FakeMapHost();
    applyFireLayers(host);

    const cell = host.layers.get(FIRE_CELL_LAYER_ID) as LayerSpecification & {
      paint: Record<string, unknown>;
    };
    expect(cell).toMatchObject({
      type: 'fill',
      source: FIRE_DETECTION_CELLS_SOURCE_ID,
      minzoom: FOOTPRINT_MIN_ZOOM,
    });
    // Hatched, never solid: a solid polygon reads as a surveyed perimeter we never have.
    expect(cell.paint['fill-pattern']).toBeDefined();
    expect(cell.paint).not.toHaveProperty('fill-color');
    // No maxzoom — the cell is the answer to "where exactly", so it survives full zoom-in.
    expect(cell).not.toHaveProperty('maxzoom');
  });

  it('picks the hatch tile from the same status/bucket decision the dot colour uses', () => {
    const host = new FakeMapHost();
    applyFireLayers(host);

    const pattern = JSON.stringify(
      (host.layers.get(FIRE_CELL_LAYER_ID) as { paint: Record<string, unknown> }).paint[
        'fill-pattern'
      ],
    );
    expect(pattern).toContain('"status"');
    expect(pattern).toContain('"score_bucket"');
    for (const id of Object.values(HATCH_IMAGE_IDS)) expect(pattern).toContain(id);
  });

  it('gives the cells a separate line layer — fill-outline-color is inert under a pattern', () => {
    const host = new FakeMapHost();
    applyFireLayers(host);

    const outline = host.layers.get(FIRE_CELL_OUTLINE_LAYER_ID) as LayerSpecification;
    expect(outline).toMatchObject({
      type: 'line',
      source: FIRE_DETECTION_CELLS_SOURCE_ID,
      minzoom: FOOTPRINT_MIN_ZOOM,
    });
    // MapLibre draws a patterned fill's outline with the pattern itself, so the edge of a
    // cell would be invisible without this layer — and without edges the union of
    // overlapping cells reads as one blob rather than as several observations.
    const cell = host.layers.get(FIRE_CELL_LAYER_ID) as { paint: Record<string, unknown> };
    expect(cell.paint).not.toHaveProperty('fill-outline-color');
  });

  it('paints the cells under the event dot, so the anchor is never buried', () => {
    const ids = [...FIRE_LAYER_IDS];
    expect(ids.indexOf(FIRE_CELL_LAYER_ID)).toBeLessThan(ids.indexOf(FIRE_DOT_LAYER_ID));
    expect(ids.indexOf(FIRE_CELL_OUTLINE_LAYER_ID)).toBeLessThan(ids.indexOf(FIRE_DOT_LAYER_ID));
  });

  it('makes the cells tappable — the hatched area selects its event like the dot does', () => {
    expect(INTERACTIVE_FIRE_LAYER_IDS).toContain(FIRE_CELL_LAYER_ID);
  });

  it('paints the heatmap in fire hues and transparent where nothing burns', () => {
    const host = new FakeMapHost();
    applyFireLayers(host);

    const heat = JSON.stringify(host.layers.get(FIRE_HEAT_LAYER_ID));
    expect(heat).toContain('heatmap-density');
    // Zero density is fully transparent — no country-wide tint under an empty map.
    expect(heat).toContain('rgba(215, 48, 31, 0)');
    // Fire owns red/orange (ADR-001); a blue-green ramp would read as anything but fire.
    expect(heat).not.toMatch(/blue|green|#0{2}[0-9a-f]{2}ff/i);
  });

  it('keeps the density glow faint and tight so it never swallows the dots', () => {
    const host = new FakeMapHost();
    applyFireLayers(host);

    const paint = (
      host.layers.get(FIRE_HEAT_LAYER_ID) as LayerSpecification & {
        paint: Record<string, unknown>;
      }
    ).paint;

    // Every alpha in the density ramp stays translucent: the blob is a background
    // reading, and an opaque one hides the dot it is supposed to summarise.
    const alphas = [
      ...JSON.stringify(paint['heatmap-color']).matchAll(/rgba\([^)]*?([\d.]+)\)/g),
    ].map((match) => Number(match[1]));
    expect(alphas.length).toBeGreaterThan(0);
    for (const alpha of alphas) expect(alpha).toBeLessThanOrEqual(0.5);

    // A wide kernel smears one event across a whole province — a claim the data
    // does not support. The radius stays in single-to-low-double digits of pixels.
    const radii = [...JSON.stringify(paint['heatmap-radius']).matchAll(/(\d+(?:\.\d+)?)/g)].map(
      (match) => Number(match[1]),
    );
    expect(Math.max(...radii)).toBeLessThanOrEqual(16);
  });

  it('drives the selected ring purely from feature-state "selected"', () => {
    const host = new FakeMapHost();
    applyFireLayers(host);

    const ring = host.layers.get(SELECTED_RING_LAYER_ID) as LayerSpecification;
    expect(ring).toMatchObject({ type: 'circle', source: FIRE_EVENTS_SOURCE_ID });
    expect(JSON.stringify(ring)).toContain('"feature-state","selected"');
    // No zoom bounds: the ring survives every band of the zoom ladder.
    expect(ring).not.toHaveProperty('minzoom');
    expect(ring).not.toHaveProperty('maxzoom');
  });

  it('renders the hull only for polygon geometry — pure centroid data draws nothing there', () => {
    const host = new FakeMapHost();
    applyFireLayers(host);

    const hull = host.layers.get(FIRE_HULL_LAYER_ID) as LayerSpecification;
    expect(JSON.stringify(hull)).toContain('"geometry-type"');
    expect(JSON.stringify(hull)).toContain('Polygon');
  });

  it('keeps interactive layers a subset of the registry and honors the fire- prefix', () => {
    for (const layerId of INTERACTIVE_FIRE_LAYER_IDS) {
      expect(FIRE_LAYER_IDS).toContain(layerId);
      expect(layerId.startsWith(FIRE_LAYER_ID_PREFIX)).toBe(true);
    }
  });
});

function baseStyle(overrides: Partial<StyleSpecification> = {}): StyleSpecification {
  return {
    version: 8,
    sources: {
      basemap: { type: 'vector', url: 'https://tiles.example/base.json' },
    },
    layers: [
      { id: 'background', type: 'background', paint: { 'background-color': '#e8e6e0' } },
      { id: 'water', type: 'fill', source: 'basemap', 'source-layer': 'water' },
    ],
    ...overrides,
  };
}

function styleWithFireData(): StyleSpecification {
  const style = baseStyle();
  const host = new FakeMapHost();
  applyFireLayers(host);
  for (const [id, source] of host.sources) style.sources[id] = source;
  style.layers.push(...([...host.layers.values()] as LayerSpecification[]));
  return style;
}

describe('preserveFireStyle', () => {
  it('returns the next style unchanged when there is no previous style', () => {
    const next = baseStyle();
    expect(preserveFireStyle(undefined, next)).toBe(next);
  });

  it('carries our sources and layers from the previous style into the next', () => {
    const previous = styleWithFireData();
    const next = baseStyle();

    const merged = preserveFireStyle(previous, next);

    for (const sourceId of FIRE_SOURCE_IDS) {
      expect(merged.sources[sourceId]).toBe(previous.sources[sourceId]);
    }
    const mergedIds = merged.layers.map((layer) => layer.id);
    for (const layerId of FIRE_LAYER_IDS) expect(mergedIds).toContain(layerId);
  });

  it('appends our layers after the incoming basemap layers, in registry order', () => {
    const previous = styleWithFireData();
    const next = baseStyle();

    const merged = preserveFireStyle(previous, next);

    const ids = merged.layers.map((layer) => layer.id);
    expect(ids).toEqual(['background', 'water', ...FIRE_LAYER_IDS]);
  });

  it('does not duplicate layers or sources the next style already contains', () => {
    const previous = styleWithFireData();
    const next = styleWithFireData(); // pathological: next already has fire data

    const merged = preserveFireStyle(previous, next);

    const ids = merged.layers.map((layer) => layer.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const sourceId of FIRE_SOURCE_IDS) {
      // The next style's own copy wins; the previous one must not clobber it.
      expect(merged.sources[sourceId]).toBe(next.sources[sourceId]);
    }
  });

  it('keeps basemap sources and non-fire style members from the next style', () => {
    const previous = styleWithFireData();
    const next = baseStyle({ name: 'dark' });

    const merged = preserveFireStyle(previous, next);

    expect(merged.sources['basemap']).toBe(next.sources['basemap']);
    expect(merged.name).toBe('dark');
  });
});
