/**
 * The self-hosted outdoor basemap style (TASKS G3), built in code for light and dark.
 *
 * Reads the Protomaps basemap schema (v4 layers `earth`, `landcover`, `landuse`, `water`,
 * `roads`, `boundaries`, `places`, `pois`, `buildings`, each feature with a `kind`) from the
 * exploded tile tree `infra/tiles` uploads, plus an optional Terrarium DEM for hillshade.
 * No sprite: every label is text, so the only runtime dependencies are the three URL
 * templates, all on our own host (WP5: zero third-party tile or glyph requests).
 *
 * Labels read `name:bg` and fall back to `name` (ADR-001), in the fontstacks
 * `infra/tiles/label-contract.json` builds glyphs for — the style test holds the two
 * together, so a fontstack the glyph build never produced cannot ship (it would render as
 * nothing, not even tofu).
 *
 * Every layer id carries the `outdoor-` prefix: never `fire-` / `alert-`, which CI-14
 * reserves for the fire style, and distinct from the fire registry's ids so
 * `preserveFireStyle` can carry fire layers across a theme swap unambiguously.
 *
 * Pure: no MapLibre runtime import (types only), so the node test project and the CI-14
 * gate can build and read the style without a WebGL context.
 */

import type { MapOptions } from 'maplibre-gl';

import type { OutdoorStyleInputs } from '../core/basemap.js';
import { activeBasemap } from '../core/basemap.js';
import type { OutdoorBasemapConfig, ThemeName } from '../core/types.js';
import type { OutdoorPalette } from './outdoor-palette.js';
import { OUTDOOR_PALETTES } from './outdoor-palette.js';

/** MapLibre's style document type (not re-exported by `maplibre-gl` under its own name). */
export type StyleSpecification = Exclude<MapOptions['style'], string | undefined>;
export type LayerSpecification = StyleSpecification['layers'][number];

/** Must equal `infra/tiles/label-contract.json` `fontstacks` (asserted by the style test). */
export const OUTDOOR_FONTSTACKS = {
  regular: 'Noto Sans Regular',
  bold: 'Noto Sans Bold',
  italic: 'Noto Sans Italic',
} as const;

/** Must equal `infra/tiles/label-contract.json` `labelFields`, in fallback order. */
export const OUTDOOR_LABEL_FIELDS = ['name:bg', 'name'] as const;

export const OUTDOOR_VECTOR_SOURCE_ID = 'outdoor';
export const OUTDOOR_DEM_SOURCE_ID = 'outdoor-dem';
export const OUTDOOR_LAYER_PREFIX = 'outdoor-';

// The config check lives with the basemap decision in core; re-exported for the map's tests.
export { outdoorConfigProblem } from '../core/basemap.js';
export type { OutdoorStyleInputs } from '../core/basemap.js';

/** Terrarium tiles are 256 px; the mirror is planned to z12 (hillshade overzooms past it). */
const DEM_TILE_SIZE = 256;
const DEM_MAXZOOM = 12;

/**
 * The style the map should load for `theme`: the outdoor style when its config is complete
 * and well-formed, otherwise the external style URL — which is how the app runs today and
 * how it keeps running (CI-7 e2e included) until R2 hosts the tiles. The choice itself is
 * `activeBasemap` in `core/basemap.ts`, which the credits read too, so the attribution can
 * never describe a different basemap from the one drawn (TASKS G5).
 */
export function resolveBasemapStyle(
  theme: ThemeName,
  styleUrls: Readonly<Record<ThemeName, string>>,
  outdoor: OutdoorBasemapConfig | null | undefined,
): StyleSpecification | string {
  const basemap = activeBasemap(styleUrls, outdoor);
  return basemap.kind === 'outdoor'
    ? buildOutdoorStyle(theme, basemap.inputs)
    : basemap.styleUrls[theme];
}

/** `name:bg`, else `name` — the one label expression every text layer uses. */
const LABEL_TEXT = ['coalesce', ...OUTDOOR_LABEL_FIELDS.map((field) => ['get', field])];

const kindIn = (...kinds: string[]) => ['in', ['get', 'kind'], ['literal', kinds]];
/** MapLibre may report either spelling for line features; fill layers skip lines anyway. */
const isLine = ['in', ['geometry-type'], ['literal', ['LineString', 'MultiLineString']]];

/** Land classes shared by the low-zoom `landcover` and the detailed `landuse` layers. */
function landClassColor(p: OutdoorPalette): unknown[] {
  return [
    'match',
    ['get', 'kind'],
    ['forest', 'wood'],
    p.forest,
    ['park', 'nature_reserve', 'protected_area', 'national_park', 'garden'],
    p.park,
    ['grassland', 'grass', 'meadow', 'scrub', 'heath'],
    p.grass,
    ['farmland', 'farmyard', 'orchard', 'vineyard', 'allotments'],
    p.farmland,
    ['urban_area', 'residential'],
    p.urban,
    ['barren', 'bare_rock', 'scree', 'sand', 'beach'],
    p.barren,
    ['glacier'],
    p.glacier,
    p.land,
  ];
}

const LAND_KINDS = [
  'forest',
  'wood',
  'park',
  'nature_reserve',
  'protected_area',
  'national_park',
  'garden',
  'grassland',
  'grass',
  'meadow',
  'scrub',
  'heath',
  'farmland',
  'farmyard',
  'orchard',
  'vineyard',
  'allotments',
  'urban_area',
  'residential',
  'barren',
  'bare_rock',
  'scree',
  'sand',
  'beach',
  'glacier',
];

/** Road width by zoom, scaled per class. */
const roadWidth = (base: number): unknown[] => [
  'interpolate',
  ['exponential', 1.6],
  ['zoom'],
  6,
  base * 0.4,
  10,
  base,
  14,
  base * 4,
  18,
  base * 16,
];

/**
 * The outdoor style for one theme. The layer list is fixed apart from hillshade, which
 * exists only when a DEM mirror is configured — a hillshade source with nowhere to fetch
 * from would log a 404 per tile and add nothing.
 */
export function buildOutdoorStyle(
  theme: ThemeName,
  inputs: OutdoorStyleInputs,
): StyleSpecification {
  const p = OUTDOOR_PALETTES[theme];
  const source = OUTDOOR_VECTOR_SOURCE_ID;
  const regular = [OUTDOOR_FONTSTACKS.regular];
  const bold = [OUTDOOR_FONTSTACKS.bold];
  const italic = [OUTDOOR_FONTSTACKS.italic];
  const hasDem = inputs.demTilesUrl !== null;

  // Built loosely and typed once at the end: the expression arrays are ordinary JSON, and
  // MapLibre's per-property expression types do not survive being assembled by helpers.
  const layers: unknown[] = [
    { id: 'outdoor-background', type: 'background', paint: { 'background-color': p.land } },
    {
      id: 'outdoor-landcover',
      type: 'fill',
      source,
      'source-layer': 'landcover',
      maxzoom: 9,
      paint: { 'fill-color': landClassColor(p), 'fill-opacity': 0.9 },
    },
    {
      id: 'outdoor-landuse',
      type: 'fill',
      source,
      'source-layer': 'landuse',
      minzoom: 6,
      filter: kindIn(...LAND_KINDS),
      paint: { 'fill-color': landClassColor(p) },
    },
    ...(hasDem
      ? [
          {
            id: 'outdoor-hillshade',
            type: 'hillshade',
            source: OUTDOOR_DEM_SOURCE_ID,
            paint: {
              'hillshade-exaggeration': theme === 'light' ? 0.35 : 0.3,
              'hillshade-shadow-color': p.hillshadeShadow,
              'hillshade-highlight-color': p.hillshadeHighlight,
              'hillshade-accent-color': p.hillshadeAccent,
            },
          },
        ]
      : []),
    {
      id: 'outdoor-water',
      type: 'fill',
      source,
      'source-layer': 'water',
      paint: { 'fill-color': p.water },
    },
    {
      id: 'outdoor-waterway',
      type: 'line',
      source,
      'source-layer': 'water',
      minzoom: 8,
      filter: isLine,
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': p.waterway,
        'line-width': ['interpolate', ['linear'], ['zoom'], 8, 0.5, 12, 1.2, 16, 3],
      },
    },
    {
      id: 'outdoor-protected-outline',
      type: 'line',
      source,
      'source-layer': 'landuse',
      minzoom: 8,
      filter: kindIn('national_park', 'nature_reserve', 'protected_area'),
      paint: {
        'line-color': p.protectedOutline,
        'line-width': ['interpolate', ['linear'], ['zoom'], 8, 0.6, 14, 1.6],
        'line-dasharray': [3, 2],
        'line-opacity': 0.8,
      },
    },
    {
      id: 'outdoor-building',
      type: 'fill',
      source,
      'source-layer': 'buildings',
      minzoom: 13,
      paint: { 'fill-color': p.building },
    },
    {
      id: 'outdoor-road-path',
      type: 'line',
      source,
      'source-layer': 'roads',
      minzoom: 12,
      filter: kindIn('path'),
      paint: { 'line-color': p.path, 'line-width': 1, 'line-dasharray': [2, 1.5] },
    },
    {
      id: 'outdoor-road-minor',
      type: 'line',
      source,
      'source-layer': 'roads',
      minzoom: 11,
      filter: kindIn('minor_road', 'other'),
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': p.roadMinor, 'line-width': roadWidth(0.6) },
    },
    {
      id: 'outdoor-road-major-casing',
      type: 'line',
      source,
      'source-layer': 'roads',
      minzoom: 7,
      filter: kindIn('major_road'),
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': p.roadCasing, 'line-width': roadWidth(1.4) },
    },
    {
      id: 'outdoor-road-major',
      type: 'line',
      source,
      'source-layer': 'roads',
      minzoom: 7,
      filter: kindIn('major_road'),
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': p.roadMajor, 'line-width': roadWidth(1) },
    },
    {
      id: 'outdoor-road-highway-casing',
      type: 'line',
      source,
      'source-layer': 'roads',
      minzoom: 5,
      filter: kindIn('highway'),
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': p.highwayCasing, 'line-width': roadWidth(1.9) },
    },
    {
      id: 'outdoor-road-highway',
      type: 'line',
      source,
      'source-layer': 'roads',
      minzoom: 5,
      filter: kindIn('highway'),
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': p.highway, 'line-width': roadWidth(1.4) },
    },
    {
      id: 'outdoor-boundary-region',
      type: 'line',
      source,
      'source-layer': 'boundaries',
      minzoom: 5,
      filter: kindIn('region'),
      paint: {
        'line-color': p.boundaryRegion,
        'line-width': ['interpolate', ['linear'], ['zoom'], 5, 0.5, 12, 1.2],
        'line-dasharray': [3, 2],
      },
    },
    {
      id: 'outdoor-boundary-country',
      type: 'line',
      source,
      'source-layer': 'boundaries',
      filter: kindIn('country'),
      layout: { 'line-join': 'round' },
      paint: {
        'line-color': p.boundaryCountry,
        'line-width': ['interpolate', ['linear'], ['zoom'], 3, 0.8, 8, 1.6, 14, 3],
      },
    },
    {
      id: 'outdoor-label-water',
      type: 'symbol',
      source,
      'source-layer': 'water',
      minzoom: 8,
      filter: ['all', ['has', 'name'], ['!', isLine]],
      layout: {
        'text-field': LABEL_TEXT,
        'text-font': italic,
        'text-size': 12,
        'text-max-width': 8,
      },
      paint: { 'text-color': p.waterText, 'text-halo-color': p.halo, 'text-halo-width': 1.2 },
    },
    {
      id: 'outdoor-label-waterway',
      type: 'symbol',
      source,
      'source-layer': 'water',
      minzoom: 12,
      filter: ['all', ['has', 'name'], isLine],
      layout: {
        'symbol-placement': 'line',
        'text-field': LABEL_TEXT,
        'text-font': italic,
        'text-size': 11,
      },
      paint: { 'text-color': p.waterText, 'text-halo-color': p.halo, 'text-halo-width': 1.2 },
    },
    {
      id: 'outdoor-label-peak',
      type: 'symbol',
      source,
      'source-layer': 'pois',
      minzoom: 11,
      filter: kindIn('peak'),
      layout: {
        'text-field': LABEL_TEXT,
        'text-font': italic,
        'text-size': 11,
        'text-anchor': 'top',
        'text-max-width': 8,
      },
      paint: { 'text-color': p.textMuted, 'text-halo-color': p.halo, 'text-halo-width': 1.2 },
    },
    {
      id: 'outdoor-label-place',
      type: 'symbol',
      source,
      'source-layer': 'places',
      filter: kindIn('locality', 'neighbourhood'),
      layout: {
        'text-field': LABEL_TEXT,
        'text-font': regular,
        'text-size': ['interpolate', ['linear'], ['zoom'], 6, 11, 10, 13, 14, 16],
        'text-max-width': 8,
        // Protomaps ranks places by the zoom they first appear at; lower places first.
        'symbol-sort-key': ['coalesce', ['get', 'min_zoom'], 20],
      },
      paint: { 'text-color': p.text, 'text-halo-color': p.halo, 'text-halo-width': 1.4 },
    },
    {
      id: 'outdoor-label-country',
      type: 'symbol',
      source,
      'source-layer': 'places',
      maxzoom: 9,
      filter: kindIn('country'),
      layout: {
        'text-field': LABEL_TEXT,
        'text-font': bold,
        'text-size': ['interpolate', ['linear'], ['zoom'], 3, 11, 7, 15],
        'text-transform': 'uppercase',
        'text-letter-spacing': 0.1,
        'text-max-width': 10,
      },
      paint: { 'text-color': p.textMuted, 'text-halo-color': p.halo, 'text-halo-width': 1.6 },
    },
  ];

  const sources: Record<string, unknown> = {
    [OUTDOOR_VECTOR_SOURCE_ID]: {
      type: 'vector',
      tiles: [inputs.tilesUrl],
      minzoom: 0,
      maxzoom: inputs.maxzoom,
    },
  };
  if (inputs.demTilesUrl !== null) {
    sources[OUTDOOR_DEM_SOURCE_ID] = {
      type: 'raster-dem',
      encoding: 'terrarium',
      tiles: [inputs.demTilesUrl],
      tileSize: DEM_TILE_SIZE,
      maxzoom: DEM_MAXZOOM,
    };
  }

  return {
    version: 8,
    name: `fire-watch outdoor ${theme}`,
    glyphs: inputs.glyphsUrl,
    sources: sources as StyleSpecification['sources'],
    layers: layers as LayerSpecification[],
  };
}
