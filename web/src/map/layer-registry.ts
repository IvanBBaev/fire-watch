/**
 * The named-constant registry of every runtime source and layer the map owns.
 *
 * `map.setStyle()` rebuilds the style tree and drops every runtime source/layer, so the
 * registry is built for re-application (review 08 §5.3.5, spike B7): `applyFireLayers`
 * is idempotent (existence-checked adds), runs on every `style.load`, and
 * `preserveFireStyle` is the `transformStyle` merge that carries our sources/layers
 * across a theme swap atomically. Both defenses are used together.
 *
 * Color policy (ADR-001, QA 06 §5.4): red/orange belong EXCLUSIVELY to fire layers —
 * the basemap is muted so fire data is the loudest thing on the map. Confidence tier is
 * never conveyed by hue alone: `unverified` keeps the tier hue but drops to ~60 %
 * opacity and a smaller radius, and the event label/glyph carries the tier textually
 * (rendered elsewhere).
 *
 * Everything here is plain data + pure functions against the structural
 * {@link LayerHost} seam — `maplibre-gl` appears only as types, so node tests exercise
 * the registry against a fake host without a DOM.
 */

import type {
  AddLayerObject,
  ExpressionSpecification,
  LayerSpecification,
  SourceSpecification,
  StyleSpecification,
  TransformStyleFunction,
} from 'maplibre-gl';

import { emptyFeatureCollection } from './geojson.js';
import type { PatternImage } from './hatch.js';
import { createHatchImage } from './hatch.js';

/** GeoJSON source of fire events. Feature-state keys on PUBLIC ids (`fw-…`), never UUIDs. */
export const FIRE_EVENTS_SOURCE_ID = 'fire-events';

/** GeoJSON source of per-event detections, populated lazily on selection / slope zoom. */
export const FIRE_DETECTIONS_SOURCE_ID = 'fire-detections';

/**
 * The same detections as polygons — the pixel cells the instruments integrated over.
 *
 * A separate source rather than a geometry-type filter on {@link FIRE_DETECTIONS_SOURCE_ID}:
 * two shapes of the same rows in one source means every `setData` re-uploads both, and a
 * reader of the registry has to infer from a filter expression which layer draws what. Two
 * sources cost one more `setData` and say it outright.
 */
export const FIRE_DETECTION_CELLS_SOURCE_ID = 'fire-detection-cells';

/**
 * The `fire-` layer-id prefix is reserved for fire data. Nothing else — basemap,
 * overlays, future decorations — may claim an id under it.
 */
export const FIRE_LAYER_ID_PREFIX = 'fire-';

export const FIRE_HEAT_LAYER_ID = 'fire-heat';
export const FIRE_DOT_LAYER_ID = 'fire-dot';
export const FIRE_HULL_LAYER_ID = 'fire-hull';
export const FIRE_CELL_LAYER_ID = 'fire-cell';
export const FIRE_CELL_OUTLINE_LAYER_ID = 'fire-cell-outline';
export const DETECTION_DOT_LAYER_ID = 'detection-dot';
export const SELECTED_RING_LAYER_ID = 'selected-ring';

/** Bottom-to-top paint order. */
export const FIRE_LAYER_IDS = [
  FIRE_HEAT_LAYER_ID,
  FIRE_HULL_LAYER_ID,
  FIRE_CELL_LAYER_ID,
  FIRE_CELL_OUTLINE_LAYER_ID,
  FIRE_DOT_LAYER_ID,
  DETECTION_DOT_LAYER_ID,
  SELECTED_RING_LAYER_ID,
] as const;

export const FIRE_SOURCE_IDS = [
  FIRE_EVENTS_SOURCE_ID,
  FIRE_DETECTIONS_SOURCE_ID,
  FIRE_DETECTION_CELLS_SOURCE_ID,
] as const;

/**
 * The layers a tap selects an event through (review 08 §5.3.2). The footprint cells are in:
 * from {@link FOOTPRINT_MIN_ZOOM} up they are the largest thing an event owns on screen,
 * and a reader who taps the hatched area they can see and gets nothing has been told the
 * fire is not tappable. Every one of these layers carries `properties.id`, so the handler
 * resolves an event id the same way regardless of which one was hit.
 */
export const INTERACTIVE_FIRE_LAYER_IDS = [
  FIRE_DOT_LAYER_ID,
  FIRE_HULL_LAYER_ID,
  FIRE_CELL_LAYER_ID,
] as const;

/**
 * The zoom ladder (review 08 §5.3.3), with one rule above all the others: **the event dot
 * is never hidden by zoom.** The earlier ladder capped `fire-dot` at zoom 11 and handed
 * over to `detection-dot`, but detections only load for a *selected* event and hull
 * polygons do not exist yet — so zooming into a fire made it vanish, which reads as "the
 * fire is gone" exactly when the user is trying to find out where it is.
 *
 * What varies with zoom now is emphasis, not existence:
 * - below {@link HEAT_MAX_ZOOM} a faint heat glow answers "where is it burning" for a
 *   whole region, where individual dots would just overplot;
 * - the dot is always drawn, growing with zoom so it stays a legible anchor;
 * - from {@link FOOTPRINT_MIN_ZOOM} the hatched detection cells appear *under* it — the
 *   area the instruments actually integrated over;
 * - from {@link DETECTION_MIN_ZOOM} each cell also gets its centre dot.
 *
 * The heat band is deliberately narrow and faint. A wide, opaque one turns a handful of
 * events into county-sized smears that hide the very dots they are meant to summarise —
 * density is only ever the *background* reading, and the dot is always the foreground one.
 *
 * {@link FOOTPRINT_MIN_ZOOM} is where a cell stops being sub-pixel: at z9 a degree of
 * longitude at Balkan latitudes is roughly 230 m per pixel, so a MODIS cell is a visible
 * 5–20 px box while a 375 m VIIRS one is still barely more than the dot it sits under.
 * Below that the hatch would be noise around the anchor rather than information.
 *
 * MapLibre zoom bounds are half-open (hidden at `zoom >= maxzoom`, shown at
 * `zoom >= minzoom`), so the heat band ends exactly where its opacity ramp reaches zero.
 */
export const HEAT_MAX_ZOOM = 6;
export const HULL_MIN_ZOOM = 7.5;
export const FOOTPRINT_MIN_ZOOM = 9;
export const DETECTION_MIN_ZOOM = 11;

/** Confirmed — strong red. Fire-owned hue; nothing outside fire layers may use it. */
export const COLOR_CONFIRMED = '#d7301f';
/** Likely — orange. `unverified` shares this hue (tier is opacity/radius + label). */
export const COLOR_LIKELY = '#f16913';
/** No longer detected — gray. Never "out": the satellite just stopped seeing it. */
export const COLOR_NO_LONGER_DETECTED = '#8b9198';
/** Officially contained / extinguished — muted gray-blue (curated states, attributed). */
export const COLOR_OFFICIAL = '#7d93ab';
/** Raw detections at slope zoom — fire-owned red-orange. */
export const COLOR_DETECTION = '#e8590c';

/**
 * Color by decided state, never computed locally (ADR-002 D6): terminal statuses win,
 * otherwise the score bucket picks the tier hue. `archived` never reaches the map (the
 * GeoJSON builder excludes it), so the fallbacks are for defensive completeness only.
 */
const FIRE_COLOR: ExpressionSpecification = [
  'match',
  ['get', 'status'],
  'no_longer_detected',
  COLOR_NO_LONGER_DETECTED,
  ['officially_contained', 'officially_extinguished'],
  COLOR_OFFICIAL,
  [
    'match',
    ['get', 'score_bucket'],
    'confirmed',
    COLOR_CONFIRMED,
    'likely',
    COLOR_LIKELY,
    'unverified',
    COLOR_LIKELY,
    COLOR_NO_LONGER_DETECTED,
  ],
];

/**
 * One hatch image per colour the cells can take. Ids live under the `fire-` prefix for the
 * same reason layer ids do: the image namespace is shared with the basemap sprite, and a
 * generic `hatch` would be one style upgrade away from colliding with someone else's.
 *
 * They are registered at runtime by {@link applyFireImages} rather than shipped in the
 * sprite, and re-registered on every `style.load` — `setStyle` drops runtime images exactly
 * as it drops runtime sources.
 */
export const HATCH_IMAGE_IDS = {
  confirmed: 'fire-hatch-confirmed',
  likely: 'fire-hatch-likely',
  quiet: 'fire-hatch-quiet',
  official: 'fire-hatch-official',
} as const;

/**
 * Which hatch tile a cell gets — the same decision {@link FIRE_COLOR} makes for the dot,
 * expressed over images instead of colours. Kept as a parallel expression rather than
 * derived in the GeoJSON builder so that "what colour is this state" stays one question
 * answered in one file, in the same shape, for both surfaces.
 */
const HATCH_PATTERN: ExpressionSpecification = [
  'match',
  ['get', 'status'],
  'no_longer_detected',
  HATCH_IMAGE_IDS.quiet,
  ['officially_contained', 'officially_extinguished'],
  HATCH_IMAGE_IDS.official,
  [
    'match',
    ['get', 'score_bucket'],
    'confirmed',
    HATCH_IMAGE_IDS.confirmed,
    'likely',
    HATCH_IMAGE_IDS.likely,
    'unverified',
    HATCH_IMAGE_IDS.likely,
    HATCH_IMAGE_IDS.quiet,
  ],
];

/** ~60 % opacity is one of the two non-hue channels that mark `unverified`. */
const FIRE_OPACITY: ExpressionSpecification = [
  'case',
  ['==', ['get', 'score_bucket'], 'unverified'],
  0.6,
  0.9,
];

/**
 * Growth with zoom. A dot sized for a country view is a speck once the user is looking at
 * a hillside, so the radius scales up as they close in — the same fire, more of the screen
 * given to it. Kept modest above {@link DETECTION_MIN_ZOOM} so the centroid anchor never
 * swallows the individual detections drawn around it.
 *
 * Stops as data, `[zoom, factor]`, linearly interpolated between them — not a ready-made
 * expression: MapLibre accepts `["zoom"]` only as the input of a *top-level* `interpolate`
 * or `step`, so the factor cannot be multiplied into a data-driven radius from inside `*`.
 * {@link zoomScaledRadius} instead puts the zoom curve on top and multiplies at each stop.
 */
const ZOOM_RADIUS_STOPS: ReadonlyArray<readonly [zoom: number, factor: number]> = [
  [4, 0.9],
  [HEAT_MAX_ZOOM, 1],
  [DETECTION_MIN_ZOOM, 1.4],
  [16, 1.8],
];

/**
 * Per-feature base radius: scaled mildly by `area_ha` (null → smallest), with the
 * smaller-radius channel for `unverified`. Mild on purpose: area is an attributed
 * estimate, not a footprint.
 */
const FIRE_DOT_BASE_RADIUS: ExpressionSpecification = [
  '*',
  ['case', ['==', ['get', 'score_bucket'], 'unverified'], 0.75, 1],
  ['interpolate', ['linear'], ['coalesce', ['get', 'area_ha'], 0], 0, 5, 200, 7, 2000, 10],
];

/**
 * `offset + base × factor(zoom)` as MapLibre will parse it: a top-level zoom `interpolate`
 * whose stop outputs are the data-driven radius at that stop's factor. Linear
 * interpolation of `offset + base × kᵢ` between stops equals `offset + base × k(zoom)`, so
 * the drawn radius is the same at every zoom, not just at the stops.
 */
function zoomScaledRadius(offset: number): ExpressionSpecification {
  const stops = ZOOM_RADIUS_STOPS.flatMap(([zoom, factor]): [number, ExpressionSpecification] => {
    const scaled: ExpressionSpecification = ['*', factor, FIRE_DOT_BASE_RADIUS];
    return [zoom, offset === 0 ? scaled : ['+', offset, scaled]];
  });
  return ['interpolate', ['linear'], ['zoom'], ...stops] as ExpressionSpecification;
}

/** The fire dot: the per-feature radius, grown with zoom. */
const FIRE_DOT_RADIUS: ExpressionSpecification = zoomScaledRadius(0);

/** Selection emphasis ring sits just outside the dot it wraps (5 px, at every zoom). */
const SELECTED_RING_RADIUS: ExpressionSpecification = zoomScaledRadius(5);

/**
 * Density ramp for the overview heatmap. Fire-owned hues only (ADR-001): a conventional
 * blue→green heat ramp would put cool colors on the one thing that must read as fire, and
 * green on a wildfire map is actively misleading. Transparent at zero density so the
 * layer disappears where nothing burns instead of tinting the whole country.
 *
 * The alphas stay low across the whole ramp: this is a glow under the dots, and a single
 * event must never paint an opaque blob that reads as a burning region.
 */
const HEAT_COLOR: ExpressionSpecification = [
  'interpolate',
  ['linear'],
  ['heatmap-density'],
  0,
  'rgba(215, 48, 31, 0)',
  0.3,
  'rgba(241, 105, 19, 0.18)',
  0.7,
  'rgba(241, 105, 19, 0.32)',
  1,
  'rgba(215, 48, 31, 0.45)',
];

/**
 * A bigger fire pushes the blob harder, but only mildly — the heatmap answers "how much
 * is burning around here", and letting one 2000 ha event drown a cluster of small ones
 * would answer a different question. `unverified` contributes less for the same reason it
 * is drawn fainter: it may not be a fire at all.
 */
const HEAT_WEIGHT: ExpressionSpecification = [
  '*',
  ['case', ['==', ['get', 'score_bucket'], 'unverified'], 0.6, 1],
  ['interpolate', ['linear'], ['coalesce', ['get', 'area_ha'], 0], 0, 0.5, 500, 1],
];

/** Sources are built fresh per apply so a host can never see a shared mutable `data`. */
function fireSources(): ReadonlyArray<readonly [string, SourceSpecification]> {
  return [
    [
      FIRE_EVENTS_SOURCE_ID,
      // promoteId lifts properties.id — the PUBLIC id — into the feature id, which is
      // the key space setFeatureState/removeFeatureState use (spike B6).
      { type: 'geojson', promoteId: 'id', data: emptyFeatureCollection() },
    ],
    [FIRE_DETECTIONS_SOURCE_ID, { type: 'geojson', data: emptyFeatureCollection() }],
    [FIRE_DETECTION_CELLS_SOURCE_ID, { type: 'geojson', data: emptyFeatureCollection() }],
  ];
}

function fireLayers(): readonly LayerSpecification[] {
  return [
    {
      // Regional density (z < 6): at Balkan scale a cluster of dots overplots into one
      // blob anyway, so a faint glow carries "how much is burning where" and hands over
      // to the dots through an opacity ramp that hits zero exactly at the band edge.
      // Radius stays tight — a 30 px kernel at country zoom smears one fire across half
      // a province, which is a claim the data does not support.
      id: FIRE_HEAT_LAYER_ID,
      type: 'heatmap',
      source: FIRE_EVENTS_SOURCE_ID,
      maxzoom: HEAT_MAX_ZOOM,
      paint: {
        'heatmap-weight': HEAT_WEIGHT,
        'heatmap-intensity': ['interpolate', ['linear'], ['zoom'], 3, 0.7, HEAT_MAX_ZOOM, 1],
        'heatmap-radius': ['interpolate', ['linear'], ['zoom'], 3, 6, HEAT_MAX_ZOOM, 14],
        'heatmap-opacity': [
          'interpolate',
          ['linear'],
          ['zoom'],
          HEAT_MAX_ZOOM - 2,
          0.5,
          HEAT_MAX_ZOOM,
          0,
        ],
        'heatmap-color': HEAT_COLOR,
      },
    },
    {
      // Event footprint from z 7.5 up. Defined against `fire-events` now, but the backend
      // does not ship hull geometry yet (NOTBUILT, [v1]): every feature is a Point, a
      // fill layer draws nothing for points, so this layer renders nothing today and
      // `fire-dot` carries the event on its own. When hull polygons arrive the layer
      // lights up with no registry change — and it keeps no maxzoom, because a real
      // footprint is most useful at exactly the zoom where the user wants the shape.
      id: FIRE_HULL_LAYER_ID,
      type: 'fill',
      source: FIRE_EVENTS_SOURCE_ID,
      minzoom: HULL_MIN_ZOOM,
      filter: ['==', ['geometry-type'], 'Polygon'],
      paint: {
        'fill-color': FIRE_COLOR,
        'fill-opacity': 0.25,
        'fill-outline-color': FIRE_COLOR,
      },
    },
    {
      // The detection footprints — the answer to "where is the fire, exactly" that the
      // centroid dot cannot give (GLOSSARY §5.2). Hatched, never solid: the cell says an
      // instrument measured heat somewhere inside it, not that its whole area is burning
      // and not where inside it the flame front is. No maxzoom — the closer the reader
      // gets, the more this is the layer that carries the honest answer.
      id: FIRE_CELL_LAYER_ID,
      type: 'fill',
      source: FIRE_DETECTION_CELLS_SOURCE_ID,
      minzoom: FOOTPRINT_MIN_ZOOM,
      paint: {
        'fill-pattern': HATCH_PATTERN,
        // The tile itself is fully opaque where it paints (see hatch.ts); transparency is
        // applied here so overlapping cells build up density instead of one flat wash.
        'fill-opacity': 0.5,
      },
    },
    {
      // The cell edges, as their own line layer: MapLibre draws a patterned fill's outline
      // with the pattern, so `fill-outline-color` is inert once `fill-pattern` is set. The
      // edge is what makes a stack of overlapping cells read as several observations rather
      // than one amorphous blob, so it is worth the extra layer.
      id: FIRE_CELL_OUTLINE_LAYER_ID,
      type: 'line',
      source: FIRE_DETECTION_CELLS_SOURCE_ID,
      minzoom: FOOTPRINT_MIN_ZOOM,
      paint: {
        'line-color': FIRE_COLOR,
        'line-width': 1,
        'line-opacity': 0.55,
      },
    },
    {
      // The event itself, at every zoom. No maxzoom, deliberately: this is the only layer
      // guaranteed to have geometry for every event, so it is the one that answers "where
      // is the fire" — and it must still answer it after the user zooms in.
      id: FIRE_DOT_LAYER_ID,
      type: 'circle',
      source: FIRE_EVENTS_SOURCE_ID,
      paint: {
        'circle-color': FIRE_COLOR,
        'circle-opacity': FIRE_OPACITY,
        'circle-radius': FIRE_DOT_RADIUS,
        // The white outline is what separates a dot from the heat glow underneath it and
        // from the basemap in either theme; it thickens with zoom along with the dot.
        'circle-stroke-color': '#ffffff',
        'circle-stroke-width': ['interpolate', ['linear'], ['zoom'], 4, 1.25, 11, 2],
        'circle-stroke-opacity': 0.9,
      },
    },
    {
      // Individual detections at slope zoom (z >= 11), loaded lazily per event. They add
      // detail around the dot; they never replace it, so an event with no detections
      // fixture loaded is still visible up here. Kept small: the cell underneath already
      // carries the extent, and this dot only marks the centre of the pixel that saw it.
      id: DETECTION_DOT_LAYER_ID,
      type: 'circle',
      source: FIRE_DETECTIONS_SOURCE_ID,
      minzoom: DETECTION_MIN_ZOOM,
      paint: {
        'circle-color': COLOR_DETECTION,
        'circle-opacity': 0.85,
        'circle-radius': ['interpolate', ['linear'], ['zoom'], DETECTION_MIN_ZOOM, 2.5, 16, 5],
        'circle-stroke-color': '#ffffff',
        'circle-stroke-width': 1,
        'circle-stroke-opacity': 0.7,
      },
    },
    {
      // Selection emphasis, driven purely by feature-state {selected} on the PUBLIC id —
      // no data re-upload on selection (review 08 §5.3.2). Invisible until selected;
      // no zoom bounds, so the ring survives every band of the zoom ladder.
      id: SELECTED_RING_LAYER_ID,
      type: 'circle',
      source: FIRE_EVENTS_SOURCE_ID,
      paint: {
        'circle-color': 'rgba(0, 0, 0, 0)',
        'circle-radius': SELECTED_RING_RADIUS,
        'circle-stroke-color': '#ffffff',
        'circle-stroke-width': ['case', ['boolean', ['feature-state', 'selected'], false], 3, 0],
      },
    },
  ];
}

/**
 * The slice of `maplibregl.Map` the registry needs — structural, so node tests drive a
 * recording fake and never instantiate a real Map. `getSource`/`getLayer` must return
 * `undefined` (not `null`) when absent, which is what MapLibre does.
 */
export interface LayerHost {
  getSource(id: string): unknown;
  addSource(id: string, source: SourceSpecification): unknown;
  getLayer(id: string): unknown;
  addLayer(layer: AddLayerObject): unknown;
}

/** The image half of the same seam — `hasImage`/`addImage` off `maplibregl.Map`. */
export interface ImageHost {
  hasImage(id: string): boolean;
  addImage(id: string, image: PatternImage): unknown;
}

/** The hatch tile each image id carries, built from the same hues the dots use. */
function hatchImages(): ReadonlyArray<readonly [string, PatternImage]> {
  return [
    [HATCH_IMAGE_IDS.confirmed, createHatchImage(COLOR_CONFIRMED)],
    [HATCH_IMAGE_IDS.likely, createHatchImage(COLOR_LIKELY)],
    [HATCH_IMAGE_IDS.quiet, createHatchImage(COLOR_NO_LONGER_DETECTED)],
    [HATCH_IMAGE_IDS.official, createHatchImage(COLOR_OFFICIAL)],
  ];
}

/**
 * Idempotent image apply — must run *before* {@link applyFireLayers} on every `style.load`.
 * A `fill-pattern` naming an unregistered image paints nothing and logs a warning per
 * frame, so the ordering is not cosmetic: the cells would simply be missing.
 */
export function applyFireImages(host: ImageHost): void {
  for (const [id, image] of hatchImages()) {
    if (!host.hasImage(id)) host.addImage(id, image);
  }
}

/**
 * Idempotent apply: safe to call repeatedly, re-run on every `style.load`. Existence
 * checks make the second run a no-op and a run after a style rebuild a full re-add.
 * Layers are appended in registry order on top of the freshly loaded basemap style.
 */
export function applyFireLayers(host: LayerHost): void {
  for (const [id, source] of fireSources()) {
    if (host.getSource(id) === undefined) host.addSource(id, source);
  }
  for (const layer of fireLayers()) {
    if (host.getLayer(layer.id) === undefined) host.addLayer(layer);
  }
}

const OWN_LAYER_IDS: ReadonlySet<string> = new Set(FIRE_LAYER_IDS);

/**
 * `transformStyle` for `map.setStyle(url, { transformStyle: preserveFireStyle })`
 * (review 08 §5.3.5 defense 1): carries our sources and layers from the previous style
 * into the next one atomically, so a theme swap never flashes a map without fire data.
 * Our layers go on top of the incoming basemap layers; the following `style.load`
 * re-runs `applyFireLayers`, which then finds everything present and adds nothing.
 *
 * Runtime *images* are not part of a `StyleSpecification` and so cannot be carried here —
 * {@link applyFireImages} on `style.load` is their only defense. A theme swap therefore has
 * a frame or two in which the cell fill has no pattern; the outline layer keeps the cells
 * visible across it, which is part of why it is a separate layer.
 */
export const preserveFireStyle: TransformStyleFunction = (previous, next) => {
  if (previous === undefined) return next;

  const sources = { ...next.sources };
  for (const sourceId of FIRE_SOURCE_IDS) {
    const preserved = previous.sources[sourceId];
    if (preserved !== undefined && sources[sourceId] === undefined) {
      sources[sourceId] = preserved;
    }
  }

  const preservedLayers = previous.layers.filter((layer) => OWN_LAYER_IDS.has(layer.id));
  const baseLayers = next.layers.filter((layer) => !OWN_LAYER_IDS.has(layer.id));

  const merged: StyleSpecification = {
    ...next,
    sources,
    layers: [...baseLayers, ...preservedLayers],
  };
  return merged;
};
