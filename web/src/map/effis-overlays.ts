/**
 * The EFFIS context overlays (TASKS G4; ADR-001 A1.2): the Fire Weather Index raster and
 * the 7-day burnt-area polygons, present exactly while the shell hands them data.
 *
 * The browser never talks to EFFIS. The shell fetches the server's proxy copies
 * (`/overlays/effis/fwi.png`, `/overlays/effis/ba.json`) and passes the results in: the
 * FWI PNG as an object URL, the burnt areas as parsed GeoJSON. This module only draws.
 *
 * {@link applyEffisOverlays} has the same contract as `applyImageryLayer`: idempotent and
 * total over its input, called on every change and on every `style.load` (a theme swap
 * drops runtime sources, and `preserveFireStyle` carries only the fire ids).
 *
 * Stacking, bottom to top: basemap → imagery → FWI → burnt-area fill → burnt-area outline
 * → fire layers. Context stays under the fire data so fire remains the loudest thing on
 * the map (06 §5.4, CI-14): the FWI raster is drawn translucent, and the burnt areas are
 * violet — outside the red–orange band fire owns.
 *
 * The EFFIS credit is owed on the credits page (contracts registry, `layer:effis`), and the
 * Layers panel prints it beside the legend. It also rides on the burnt-area source, so
 * MapLibre's control shows it while that layer is drawn; an `image` source carries no
 * attribution in MapLibre, so the FWI raster relies on the panel. The shell renders the
 * credit from the registry and passes it in; nothing is retyped here.
 */

import type { AddLayerObject } from 'maplibre-gl';

import type { EffisOverlayDraw } from '../core/types.js';

import type { FeatureCollectionOf } from './geojson.js';
import type { LayerHost } from './layer-host.js';
import { FIRE_LAYER_IDS } from './layer-registry.js';

export const EFFIS_FWI_SOURCE_ID = 'effis-fwi';
export const EFFIS_FWI_LAYER_ID = 'effis-fwi';
export const EFFIS_BA_SOURCE_ID = 'effis-ba';
export const EFFIS_BA_FILL_LAYER_ID = 'effis-ba-fill';
export const EFFIS_BA_LINE_LAYER_ID = 'effis-ba-line';

/** Every overlay layer, bottom to top. */
export const EFFIS_OVERLAY_LAYER_IDS = [
  EFFIS_FWI_LAYER_ID,
  EFFIS_BA_FILL_LAYER_ID,
  EFFIS_BA_LINE_LAYER_ID,
] as const;

/**
 * Where the FWI raster sits: the server asks EFFIS for exactly the polling bbox
 * (`server/src/core/config/polling-bbox.ts`, W20 S39 E31 N46) and the proxy does not
 * republish the query (it promises nothing about the upstream but the dates). A change to
 * that bbox must change these corners too. Order: top-left, top-right, bottom-right,
 * bottom-left, as `[lon, lat]`.
 */
export const EFFIS_FWI_CORNERS: readonly [
  [number, number],
  [number, number],
  [number, number],
  [number, number],
] = [
  [20, 46],
  [31, 46],
  [31, 39],
  [20, 39],
];

/** Translucent enough that the basemap's roads and towns still read through it. */
export const EFFIS_FWI_OPACITY = 0.55;

/** Violet, well outside fire's red–orange band (CI-14). */
export const EFFIS_BA_FILL_COLOR = '#7b4bb3';
export const EFFIS_BA_LINE_COLOR = '#5a2f91';
export const EFFIS_BA_FILL_OPACITY = 0.3;

export type EffisBurntAreas = FeatureCollectionOf<unknown>;

/** What the shell wants drawn. `null` for an overlay removes it. */
export type EffisOverlayState = EffisOverlayDraw;

export const NO_EFFIS_OVERLAYS: EffisOverlayState = {
  fwiImageUrl: null,
  burntAreas: null,
  attribution: '',
};

/** What each host last received, so an unchanged payload is not re-added. */
const applied = new WeakMap<
  object,
  { fwi: string | null; ba: object | null; attribution: string }
>();

function below(host: LayerHost, layerId: (typeof EFFIS_OVERLAY_LAYER_IDS)[number]) {
  const above = [
    ...EFFIS_OVERLAY_LAYER_IDS.slice(EFFIS_OVERLAY_LAYER_IDS.indexOf(layerId) + 1),
    ...FIRE_LAYER_IDS,
  ];
  return above.find((id) => host.getLayer(id) !== undefined);
}

function removeLayers(host: LayerHost, layerIds: readonly string[], sourceId: string) {
  for (const id of layerIds) if (host.getLayer(id) !== undefined) host.removeLayer(id);
  if (host.getSource(sourceId) !== undefined) host.removeSource(sourceId);
}

function applyFwi(host: LayerHost, url: string | null, fresh: boolean) {
  if (url === null) {
    removeLayers(host, [EFFIS_FWI_LAYER_ID], EFFIS_FWI_SOURCE_ID);
    return;
  }
  if (!fresh || host.getSource(EFFIS_FWI_SOURCE_ID) === undefined) {
    removeLayers(host, [EFFIS_FWI_LAYER_ID], EFFIS_FWI_SOURCE_ID);
    const [a, b, c, d] = EFFIS_FWI_CORNERS;
    host.addSource(EFFIS_FWI_SOURCE_ID, {
      type: 'image',
      url,
      coordinates: [[...a], [...b], [...c], [...d]],
    });
  }
  if (host.getLayer(EFFIS_FWI_LAYER_ID) === undefined) {
    const layer: AddLayerObject = {
      id: EFFIS_FWI_LAYER_ID,
      type: 'raster',
      source: EFFIS_FWI_SOURCE_ID,
      paint: { 'raster-opacity': EFFIS_FWI_OPACITY, 'raster-fade-duration': 0 },
    };
    host.addLayer(layer, below(host, EFFIS_FWI_LAYER_ID));
  }
}

function applyBurntAreas(
  host: LayerHost,
  data: object | null,
  attribution: string,
  fresh: boolean,
) {
  const layerIds = [EFFIS_BA_FILL_LAYER_ID, EFFIS_BA_LINE_LAYER_ID];
  if (data === null) {
    removeLayers(host, layerIds, EFFIS_BA_SOURCE_ID);
    return;
  }
  if (!fresh || host.getSource(EFFIS_BA_SOURCE_ID) === undefined) {
    removeLayers(host, layerIds, EFFIS_BA_SOURCE_ID);
    host.addSource(EFFIS_BA_SOURCE_ID, {
      type: 'geojson',
      // Parsed by the shell from the proxy's GeoJSON; MapLibre validates it on add.
      data: data as EffisBurntAreas,
      ...(attribution === '' ? {} : { attribution }),
    });
  }
  if (host.getLayer(EFFIS_BA_FILL_LAYER_ID) === undefined) {
    host.addLayer(
      {
        id: EFFIS_BA_FILL_LAYER_ID,
        type: 'fill',
        source: EFFIS_BA_SOURCE_ID,
        paint: { 'fill-color': EFFIS_BA_FILL_COLOR, 'fill-opacity': EFFIS_BA_FILL_OPACITY },
      },
      below(host, EFFIS_BA_FILL_LAYER_ID),
    );
  }
  if (host.getLayer(EFFIS_BA_LINE_LAYER_ID) === undefined) {
    host.addLayer(
      {
        id: EFFIS_BA_LINE_LAYER_ID,
        type: 'line',
        source: EFFIS_BA_SOURCE_ID,
        paint: { 'line-color': EFFIS_BA_LINE_COLOR, 'line-width': 1.25 },
      },
      below(host, EFFIS_BA_LINE_LAYER_ID),
    );
  }
}

/** Make the map show exactly the overlays in `state`. Safe to call repeatedly. */
export function applyEffisOverlays(host: LayerHost, state: EffisOverlayState): void {
  const last = applied.get(host);
  applyFwi(host, state.fwiImageUrl, last !== undefined && last.fwi === state.fwiImageUrl);
  applyBurntAreas(
    host,
    state.burntAreas,
    state.attribution,
    last !== undefined && last.attribution === state.attribution && last.ba === state.burntAreas,
  );
  applied.set(host, {
    fwi: state.fwiImageUrl,
    ba: state.burntAreas,
    attribution: state.attribution,
  });
}
