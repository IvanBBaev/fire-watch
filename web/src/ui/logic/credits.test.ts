import { describe, expect, it } from 'vitest';

import { DEFAULT_CONFIG } from '../../core/config.js';
import type { OutdoorBasemapConfig } from '../../core/types.js';
import { activeCreditConditions } from './credits.js';

const OUTDOOR: OutdoorBasemapConfig = {
  tilesUrl: 'https://tiles.example.org/tiles/v1/{z}/{x}/{y}.mvt',
  glyphsUrl: 'https://tiles.example.org/fonts/v1/{fontstack}/{range}.pbf',
  demTilesUrl: null,
  maxzoom: 14,
};
const DEM_URL = 'https://tiles.example.org/dem/terrarium/{z}/{x}/{y}.png';

describe('activeCreditConditions', () => {
  it('detects the OpenFreeMap basemap in the default config', () => {
    expect(activeCreditConditions(DEFAULT_CONFIG)).toEqual(['basemap:openfreemap']);
  });

  it('detects a Protomaps basemap', () => {
    expect(
      activeCreditConditions({
        basemapStyleUrl: {
          light: 'https://example.org/protomaps/light.json',
          dark: 'https://example.org/protomaps/dark.json',
        },
      }),
    ).toEqual(['basemap:protomaps']);
  });

  it('owes no basemap credit for an unknown tile host', () => {
    expect(
      activeCreditConditions({
        basemapStyleUrl: {
          light: 'https://tiles.example.org/light.json',
          dark: 'https://tiles.example.org/dark.json',
        },
      }),
    ).toEqual([]);
  });

  it('owes the Esri credit only while imagery is switched on', () => {
    expect(activeCreditConditions(DEFAULT_CONFIG, { imageryOn: true })).toEqual([
      'basemap:openfreemap',
      'toggle:esri',
    ]);
    expect(activeCreditConditions(DEFAULT_CONFIG, { imageryOn: false })).toEqual([
      'basemap:openfreemap',
    ]);
    expect(activeCreditConditions(DEFAULT_CONFIG)).not.toContain('toggle:esri');
  });

  it('credits the outdoor style, not the external fallback it replaces', () => {
    // DEFAULT_CONFIG still names OpenFreeMap underneath; the outdoor style is what draws.
    expect(activeCreditConditions({ ...DEFAULT_CONFIG, outdoorBasemap: OUTDOOR })).toEqual([
      'basemap:protomaps',
    ]);
  });

  it('owes the terrain credits exactly when the outdoor style draws hillshade', () => {
    expect(
      activeCreditConditions({
        ...DEFAULT_CONFIG,
        outdoorBasemap: { ...OUTDOOR, demTilesUrl: DEM_URL },
      }),
    ).toEqual(['basemap:protomaps', 'layer:terrain']);
  });

  it('keeps the external credits while the outdoor config would fall back', () => {
    const outdoors: OutdoorBasemapConfig[] = [
      // The shipped default: not deployed.
      { ...OUTDOOR, tilesUrl: null, glyphsUrl: null },
      { ...OUTDOOR, glyphsUrl: null },
      // A DEM on a style that is not drawn draws no terrain either.
      { ...OUTDOOR, tilesUrl: 'http://tiles.example.org/{z}/{x}/{y}.mvt', demTilesUrl: DEM_URL },
    ];
    expect(activeCreditConditions(DEFAULT_CONFIG)).toEqual(['basemap:openfreemap']);
    for (const outdoorBasemap of outdoors) {
      expect(activeCreditConditions({ ...DEFAULT_CONFIG, outdoorBasemap })).toEqual([
        'basemap:openfreemap',
      ]);
    }
  });
});
