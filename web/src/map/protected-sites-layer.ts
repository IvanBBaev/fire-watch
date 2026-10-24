/**
 * The Natura 2000 protected-site layer (V2-F1), the drawing half: every SPA and SCI in
 * the served box as a faint green fill with a darker outline, so a reader can see whether
 * a fire sits in or beside a protected site.
 *
 * {@link applyProtectedSitesLayer} has the same contract as `applyStaticSourcesLayer`:
 * idempotent and total over its input, called on every change and on every `style.load`
 * (a theme swap drops runtime sources).
 *
 * Stacking: above the EFFIS overlays, below the static hot-source mask, the wind arrows
 * and every fire layer — context, never louder than fire (06 §5.4, CI-14). Green, no red,
 * no orange: a protected site is not a hazard.
 *
 * It takes the GeoJSON ready-made (`protectedSitesGeoJson`, computed in the UI's state
 * module) so the geometry code stays out of the map chunk: it arrives with the asset, in a
 * lazy chunk (CI-12).
 *
 * No attribution rides on the source: the map corner line is fixed (`MAP_CORNER_LINE`),
 * so the EEA credit is on `/credits` always (the event note reads the sites whether or not
 * the layer is drawn) and in the Layers panel beside the layer while it is on.
 */

import type { AddLayerObject } from 'maplibre-gl';

import type { ProtectedSitesGeoJson } from '../core/geo/protected-sites.js';
import type { LayerHost } from './layer-host.js';
import { FIRE_LAYER_IDS } from './layer-registry.js';
import { STATIC_SOURCES_LAYER_IDS } from './static-sources-layer.js';
import { WIND_LAYER_ID } from './wind-layer.js';

export const PROTECTED_SITES_SOURCE_ID = 'protected-sites';
export const PROTECTED_SITES_FILL_LAYER_ID = 'protected-sites-fill';
export const PROTECTED_SITES_LINE_LAYER_ID = 'protected-sites-line';

/** Every protected-site layer, bottom to top. */
export const PROTECTED_SITES_LAYER_IDS = [
  PROTECTED_SITES_FILL_LAYER_ID,
  PROTECTED_SITES_LINE_LAYER_ID,
] as const;

/** Green: far from fire's red–orange band (CI-14). */
export const PROTECTED_SITES_COLOR = '#16a34a';
export const PROTECTED_SITES_LINE_COLOR = '#15803d';
/** Faint, so the basemap and every fire layer read through a site that covers a range. */
export const PROTECTED_SITES_FILL_OPACITY = 0.12;

/** What each host last received, so unchanged sites are not re-added. */
const applied = new WeakMap<object, ProtectedSitesGeoJson | null>();

function below(host: LayerHost, layerId: (typeof PROTECTED_SITES_LAYER_IDS)[number]) {
  const above = [
    ...PROTECTED_SITES_LAYER_IDS.slice(PROTECTED_SITES_LAYER_IDS.indexOf(layerId) + 1),
    ...STATIC_SOURCES_LAYER_IDS,
    WIND_LAYER_ID,
    ...FIRE_LAYER_IDS,
  ];
  return above.find((id) => host.getLayer(id) !== undefined);
}

function remove(host: LayerHost) {
  for (const id of PROTECTED_SITES_LAYER_IDS)
    if (host.getLayer(id) !== undefined) host.removeLayer(id);
  if (host.getSource(PROTECTED_SITES_SOURCE_ID) !== undefined)
    host.removeSource(PROTECTED_SITES_SOURCE_ID);
}

const LAYERS: Readonly<Record<(typeof PROTECTED_SITES_LAYER_IDS)[number], AddLayerObject>> = {
  [PROTECTED_SITES_FILL_LAYER_ID]: {
    id: PROTECTED_SITES_FILL_LAYER_ID,
    type: 'fill',
    source: PROTECTED_SITES_SOURCE_ID,
    paint: { 'fill-color': PROTECTED_SITES_COLOR, 'fill-opacity': PROTECTED_SITES_FILL_OPACITY },
  },
  [PROTECTED_SITES_LINE_LAYER_ID]: {
    id: PROTECTED_SITES_LINE_LAYER_ID,
    type: 'line',
    source: PROTECTED_SITES_SOURCE_ID,
    paint: { 'line-color': PROTECTED_SITES_LINE_COLOR, 'line-width': 1, 'line-opacity': 0.7 },
  },
};

/** Make the map show exactly these sites, or none for `null`. Safe to call repeatedly. */
export function applyProtectedSitesLayer(
  host: LayerHost,
  sites: ProtectedSitesGeoJson | null,
): void {
  const fresh = applied.has(host) && applied.get(host) === sites;
  applied.set(host, sites);
  if (sites === null) {
    remove(host);
    return;
  }
  if (!fresh || host.getSource(PROTECTED_SITES_SOURCE_ID) === undefined) {
    remove(host);
    host.addSource(PROTECTED_SITES_SOURCE_ID, {
      type: 'geojson',
      data: sites,
    });
  }
  for (const id of PROTECTED_SITES_LAYER_IDS) {
    if (host.getLayer(id) === undefined) host.addLayer(LAYERS[id], below(host, id));
  }
}
