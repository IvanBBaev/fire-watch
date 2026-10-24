/**
 * V2-A1 playback, the drawing half: the replayed detections of one history window, revealed
 * up to the scrubber's cursor, coloured by their age at the cursor and sized by FRP
 * (`core/playback.ts`).
 *
 * {@link applyPlaybackLayer} has the same contract as the other overlay layers: idempotent
 * and total over its input, called on every change and on every `style.load`.
 *
 * - The source is re-added only when the collection changes (a new window). A cursor move
 *   is a `setFilter` plus `setPaintProperty` on the one layer — no re-upload of the points.
 * - While a draw is active, the live fire layers are hidden (`visibility: none`), so the
 *   map shows one time at once: the replay, or now. They are hidden, not removed, so the
 *   store, the SSE reconciler and the live data push carry on untouched underneath, and
 *   `null` makes them visible again exactly as they were.
 * - The layer is fire-owned (`fire-` prefix) and paints only the fire registry's colours
 *   (CI-14). It sits on top of everything: it is the only fire on screen while it is on.
 * - The FIRMS credit rides on the source's `attribution`, so the map corner shows it
 *   exactly while replayed detections are drawn (CI-13).
 */

import type { AddLayerObject, ExpressionSpecification, FilterSpecification } from 'maplibre-gl';

import { PLAYBACK_AGE_CLASSES, PLAYBACK_FRP_RADIUS } from '../core/history-body.js';
import type { PlaybackDraw } from '../core/playback.js';

import type { FeatureCollectionOf } from './geojson.js';
import type { LayerHost } from './layer-host.js';
import { FIRE_LAYER_IDS } from './layer-registry.js';

export const PLAYBACK_SOURCE_ID = 'fire-playback';
export const PLAYBACK_LAYER_ID = 'fire-playback';

/** The slice of `maplibregl.Map` the cursor needs beyond adding and removing. */
export interface PlaybackHost extends LayerHost {
  setFilter(layerId: string, filter: FilterSpecification | null): unknown;
  setPaintProperty(layerId: string, name: string, value: unknown): unknown;
  getLayoutProperty(layerId: string, name: string): unknown;
  setLayoutProperty(layerId: string, name: string, value: unknown): unknown;
}

/** `cursor - t`: a detection's age in minutes at the cursor. */
const age = (cursor: number): ExpressionSpecification => ['-', cursor, ['get', 't']];

function byAge(cursor: number, pick: (index: number) => string | number): ExpressionSpecification {
  const stops: (string | number)[] = [];
  PLAYBACK_AGE_CLASSES.forEach((entry, index) => {
    if (index > 0) stops.push(PLAYBACK_AGE_CLASSES[index - 1]?.upperMinutes ?? 0);
    stops.push(pick(index));
  });
  const [first, ...rest] = stops;
  return ['step', age(cursor), first ?? 0, ...rest] as ExpressionSpecification;
}

export function playbackFilter(cursor: number): FilterSpecification {
  return ['<=', ['get', 't'], cursor];
}

export function playbackColor(cursor: number): ExpressionSpecification {
  return byAge(cursor, (index) => PLAYBACK_AGE_CLASSES[index]?.color ?? '');
}

export function playbackOpacity(cursor: number): ExpressionSpecification {
  return byAge(cursor, (index) => PLAYBACK_AGE_CLASSES[index]?.opacity ?? 1);
}

function frpRadius(scale: number): ExpressionSpecification {
  return [
    'interpolate',
    ['linear'],
    ['coalesce', ['get', 'frp'], 0],
    ...PLAYBACK_FRP_RADIUS.flatMap(([frp, radius]) => [frp, radius * scale]),
  ] as ExpressionSpecification;
}

/** The layer as first added, at the window's end. Exported for the style-spec validator. */
export function playbackLayer(cursor: number): AddLayerObject {
  return {
    id: PLAYBACK_LAYER_ID,
    type: 'circle',
    source: PLAYBACK_SOURCE_ID,
    filter: playbackFilter(cursor),
    paint: {
      'circle-color': playbackColor(cursor),
      'circle-opacity': playbackOpacity(cursor),
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 5, frpRadius(0.8), 10, frpRadius(1.6)],
      'circle-stroke-color': '#ffffff',
      'circle-stroke-width': 0.6,
      'circle-stroke-opacity': 0.6,
    },
  };
}

/** What each host last received, so an unchanged body is not re-uploaded. */
const applied = new WeakMap<object, PlaybackDraw>();

function setLiveVisible(host: PlaybackHost, visible: boolean): void {
  const wanted = visible ? 'visible' : 'none';
  for (const id of FIRE_LAYER_IDS) {
    if (host.getLayer(id) === undefined) continue;
    // An unset visibility reads as `undefined` and means visible.
    const current = host.getLayoutProperty(id, 'visibility') ?? 'visible';
    if (current !== wanted) host.setLayoutProperty(id, 'visibility', wanted);
  }
}

function remove(host: PlaybackHost): void {
  if (host.getLayer(PLAYBACK_LAYER_ID) !== undefined) host.removeLayer(PLAYBACK_LAYER_ID);
  if (host.getSource(PLAYBACK_SOURCE_ID) !== undefined) host.removeSource(PLAYBACK_SOURCE_ID);
}

/**
 * Make the map replay exactly `draw` up to its cursor, or show the live layers again for
 * `null`. Safe to call repeatedly and after a style rebuild.
 */
export function applyPlaybackLayer(host: PlaybackHost, draw: PlaybackDraw | null): void {
  if (draw === null) {
    remove(host);
    applied.delete(host);
    setLiveVisible(host, true);
    return;
  }
  setLiveVisible(host, false);
  const previous = applied.get(host);
  const sameBody =
    previous !== undefined &&
    previous.collection === draw.collection &&
    previous.attribution === draw.attribution &&
    host.getSource(PLAYBACK_SOURCE_ID) !== undefined;
  if (!sameBody) {
    remove(host);
    // The cast only drops the readonly markers.
    const data = draw.collection as unknown as FeatureCollectionOf<unknown>;
    host.addSource(PLAYBACK_SOURCE_ID, { type: 'geojson', data, attribution: draw.attribution });
  }
  if (host.getLayer(PLAYBACK_LAYER_ID) === undefined) {
    host.addLayer(playbackLayer(draw.cursor));
  } else if (previous?.cursor !== draw.cursor) {
    host.setFilter(PLAYBACK_LAYER_ID, playbackFilter(draw.cursor));
    host.setPaintProperty(PLAYBACK_LAYER_ID, 'circle-color', playbackColor(draw.cursor));
    host.setPaintProperty(PLAYBACK_LAYER_ID, 'circle-opacity', playbackOpacity(draw.cursor));
  }
  applied.set(host, draw);
}
