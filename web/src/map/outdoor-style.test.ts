// Reads infra/tiles/label-contract.json from disk; node types scoped to this file.
/// <reference types="node" />

import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import type { Rgba } from '../core/color/color.js';
import { deltaE2000, formatHex, parseColor, toLab } from '../core/color/color.js';
import { DEFAULT_CONFIG } from '../core/config.js';
import type { OutdoorBasemapConfig, ThemeName } from '../core/types.js';
import { COLOR_CONFIRMED, COLOR_DETECTION, COLOR_LIKELY } from './layer-registry.js';
import { OUTDOOR_PALETTES } from './outdoor-palette.js';
import type { LayerSpecification, StyleSpecification } from './outdoor-style.js';
import {
  OUTDOOR_DEM_SOURCE_ID,
  OUTDOOR_FONTSTACKS,
  OUTDOOR_LABEL_FIELDS,
  OUTDOOR_LAYER_PREFIX,
  OUTDOOR_VECTOR_SOURCE_ID,
  outdoorConfigProblem,
  resolveBasemapStyle,
} from './outdoor-style.js';
import type { StyleLayerLike } from './style-colors.js';
import { hueViolations, isFireHue, isFireOwnedLayerId, paintedColors } from './style-colors.js';

const THEMES: readonly ThemeName[] = ['light', 'dark'];
const STYLE_URLS = DEFAULT_CONFIG.basemapStyleUrl;

const DEPLOYED: OutdoorBasemapConfig = {
  tilesUrl: 'https://tiles.example.org/tiles/20260924/{z}/{x}/{y}.mvt',
  glyphsUrl: 'https://tiles.example.org/fonts/20260924/{fontstack}/{range}.pbf',
  demTilesUrl: 'https://tiles.example.org/dem/terrarium/{z}/{x}/{y}.png',
  maxzoom: 14,
};

const contract = JSON.parse(
  readFileSync(new URL('../../../infra/tiles/label-contract.json', import.meta.url), 'utf8'),
) as { fontstacks: string[]; labelFields: string[] };

function built(theme: ThemeName, config: OutdoorBasemapConfig = DEPLOYED): StyleSpecification {
  const style = resolveBasemapStyle(theme, STYLE_URLS, config);
  if (typeof style === 'string') throw new Error(`expected a built style, got ${style}`);
  return style;
}

const asLayers = (style: StyleSpecification): StyleLayerLike[] => style.layers;

/** The fire palette's hot colours, taken from the registry's exported tokens. */
function fireHotColors(): Rgba[] {
  return [COLOR_CONFIRMED, COLOR_LIKELY, COLOR_DETECTION].map(parseColor).filter(isFireHue);
}

describe('resolveBasemapStyle — falls back until the tiles exist', () => {
  it('keeps the external style URL while the default config is unset', () => {
    expect(outdoorConfigProblem(DEFAULT_CONFIG.outdoorBasemap)).toBe('not deployed');
    for (const theme of THEMES) {
      expect(resolveBasemapStyle(theme, STYLE_URLS, DEFAULT_CONFIG.outdoorBasemap)).toBe(
        STYLE_URLS[theme],
      );
      expect(resolveBasemapStyle(theme, STYLE_URLS, undefined)).toBe(STYLE_URLS[theme]);
      expect(resolveBasemapStyle(theme, STYLE_URLS, null)).toBe(STYLE_URLS[theme]);
    }
  });

  it('falls back on a half-deployed or malformed config instead of a blank map', () => {
    const cases: Array<[Partial<OutdoorBasemapConfig>, RegExp]> = [
      [{ glyphsUrl: null }, /not deployed/u],
      [{ tilesUrl: 'http://tiles.example.org/{z}/{x}/{y}.mvt' }, /tilesUrl must be an https/u],
      [{ tilesUrl: 'https://tiles.example.org/{z}/{x}.mvt' }, /tilesUrl lacks \{y\}/u],
      [
        { glyphsUrl: 'https://tiles.example.org/fonts/{range}.pbf' },
        /glyphsUrl lacks \{fontstack\}/u,
      ],
      [{ demTilesUrl: '/dem/{z}/{x}/{y}.png' }, /demTilesUrl must be/u],
      [{ maxzoom: 15 }, /maxzoom/u],
    ];
    for (const [patch, reason] of cases) {
      const config = { ...DEPLOYED, ...patch };
      expect(outdoorConfigProblem(config)).toMatch(reason);
      expect(resolveBasemapStyle('light', STYLE_URLS, config)).toBe(STYLE_URLS.light);
    }
    expect(outdoorConfigProblem(DEPLOYED)).toBeNull();
    expect(
      outdoorConfigProblem({ ...DEPLOYED, tilesUrl: 'http://localhost:8080/t/{z}/{x}/{y}.mvt' }),
    ).toBeNull();
  });

  it('builds the outdoor style for each theme once the config is complete', () => {
    for (const theme of THEMES) {
      const style = built(theme);
      expect(style.version).toBe(8);
      expect(style.glyphs).toBe(DEPLOYED.glyphsUrl);
      expect(style.sprite).toBeUndefined();
      expect(style.sources[OUTDOOR_VECTOR_SOURCE_ID]).toMatchObject({
        type: 'vector',
        tiles: [DEPLOYED.tilesUrl],
        maxzoom: 14,
      });
    }
    expect(built('light')).not.toStrictEqual(built('dark'));
  });
});

describe('outdoor style — structure', () => {
  it('adds the Terrarium hillshade exactly when a DEM mirror is configured', () => {
    const withDem = built('light');
    expect(withDem.sources[OUTDOOR_DEM_SOURCE_ID]).toStrictEqual({
      type: 'raster-dem',
      encoding: 'terrarium',
      tiles: [DEPLOYED.demTilesUrl],
      tileSize: 256,
      maxzoom: 12,
    });
    const hillshade = withDem.layers.filter((layer) => layer.type === 'hillshade');
    expect(hillshade.map((layer) => layer.id)).toStrictEqual(['outdoor-hillshade']);
    // Under water and roads, over land fills — terrain shades the ground, not the labels.
    const ids = withDem.layers.map((layer) => layer.id);
    expect(ids.indexOf('outdoor-hillshade')).toBeGreaterThan(ids.indexOf('outdoor-landuse'));
    expect(ids.indexOf('outdoor-hillshade')).toBeLessThan(ids.indexOf('outdoor-water'));

    const withoutDem = built('light', { ...DEPLOYED, demTilesUrl: null });
    expect(withoutDem.sources[OUTDOOR_DEM_SOURCE_ID]).toBeUndefined();
    expect(withoutDem.layers.some((layer) => layer.type === 'hillshade')).toBe(false);
  });

  it('uses only its own sources, unique outdoor- ids, and never a fire-owned id', () => {
    for (const theme of THEMES) {
      const style = built(theme);
      const ids = style.layers.map((layer) => layer.id);
      expect(new Set(ids).size).toBe(ids.length);
      for (const layer of style.layers) {
        expect(layer.id.startsWith(OUTDOOR_LAYER_PREFIX), layer.id).toBe(true);
        expect(isFireOwnedLayerId(layer.id), layer.id).toBe(false);
        if ('source' in layer) expect(Object.keys(style.sources)).toContain(layer.source);
      }
    }
  });

  it('labels with name:bg → name, in fontstacks the glyph build produces', () => {
    expect([...OUTDOOR_LABEL_FIELDS]).toStrictEqual(contract.labelFields);
    expect(Object.values(OUTDOOR_FONTSTACKS).sort()).toStrictEqual([...contract.fontstacks].sort());
    const symbols = built('light').layers.filter(
      (layer): layer is Extract<LayerSpecification, { type: 'symbol' }> => layer.type === 'symbol',
    );
    expect(symbols.length).toBeGreaterThan(0);
    for (const layer of symbols) {
      expect(layer.layout?.['text-field'], layer.id).toStrictEqual([
        'coalesce',
        ['get', 'name:bg'],
        ['get', 'name'],
      ]);
      // One stack per layer: a fallback stack would be a second glyph tree to host.
      const font = layer.layout?.['text-font'];
      expect(Array.isArray(font) && font.length === 1, layer.id).toBe(true);
      expect(contract.fontstacks, layer.id).toContain((font as string[])[0]);
      expect(layer.layout?.['icon-image'], layer.id).toBeUndefined();
    }
  });

  it('emphasises forest over the other land classes', () => {
    for (const theme of THEMES) {
      const p = OUTDOOR_PALETTES[theme];
      const land = toLab(parseColor(p.land));
      const forestContrast = deltaE2000(toLab(parseColor(p.forest)), land);
      for (const other of [p.park, p.grass, p.farmland, p.urban, p.barren]) {
        expect(forestContrast, `${theme} forest vs ${other}`).toBeGreaterThan(
          deltaE2000(toLab(parseColor(other)), land),
        );
      }
    }
  });
});

describe('outdoor style — fire owns red (CI-14)', () => {
  it('paints no reserved fire hue in either theme', () => {
    for (const theme of THEMES) {
      const painted = paintedColors(asLayers(built(theme)), new Map());
      expect(painted.length).toBeGreaterThan(20);
      expect(
        hueViolations(painted).map(
          (entry) => `${entry.layerId} ${entry.property} ${formatHex(entry.color)}`,
        ),
      ).toStrictEqual([]);
    }
  });

  it('keeps every basemap colour far from the fire palette’s hot colours', () => {
    const hot = fireHotColors();
    expect(hot.length).toBeGreaterThanOrEqual(3);
    const MIN_DELTA_E00 = 25;
    for (const theme of THEMES) {
      for (const entry of paintedColors(asLayers(built(theme)), new Map())) {
        for (const fire of hot) {
          const distance = deltaE2000(toLab(entry.color), toLab(fire));
          expect(
            distance,
            `${theme} ${entry.layerId} ${entry.property} ${formatHex(entry.color)} vs ${formatHex(fire)}`,
          ).toBeGreaterThanOrEqual(MIN_DELTA_E00);
        }
      }
    }
  });
});
