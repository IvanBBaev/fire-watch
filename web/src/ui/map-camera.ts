/**
 * The camera, shared between the map and everything that reacts to it.
 *
 * The map owns the camera; the list only watches it. A signal rather than context or props
 * because the map reports a new frame after every gesture and only the list subscribes —
 * routing it through the shell would re-render the whole tree, including the map's own
 * container, once per pan.
 *
 * `mapViewport` starts `null` and stays null until the map has laid out and reported a real
 * frame. That is not the same as "an empty frame": until it arrives the list shows
 * everything, because filtering by a viewport nobody has measured yet would blank the list
 * on a slow map load — the surface that exists precisely for when the map is slow.
 */

import { signal } from '@preact/signals';

import { DEFAULT_VIEW } from '../core/config.js';
import {
  CAMERA_STORAGE_KEY,
  hasCameraHash,
  parseCamera,
  serializeCamera,
} from '../core/geo/camera.js';
import type { MapCamera, MapViewport } from '../core/geo/viewport.js';
import { readStorage, writeStorage } from './storage.js';

/** The last frame the map reported, or `null` before it has reported one. */
export const mapViewport = signal<MapViewport | null>(null);

/** Where the "Balkans" control goes back to — the same frame a first-time visitor gets. */
export const HOME_CAMERA: MapCamera = DEFAULT_VIEW;

/** The remembered camera, or the default. The `#map=` fragment outranks both (map/hash). */
export function initialCamera(): MapCamera {
  return parseCamera(readStorage(CAMERA_STORAGE_KEY)) ?? HOME_CAMERA;
}

/**
 * Offer to locate the user only when nothing else has already decided where to look — no
 * `#map=` in the link, no camera from a previous visit. A returning user's own last frame
 * is a stronger signal of intent than their coordinates, and re-prompting someone who has
 * already positioned the map is noise.
 */
export function shouldOfferLocation(hash: string): boolean {
  return !hasCameraHash(hash) && parseCamera(readStorage(CAMERA_STORAGE_KEY)) === null;
}

/** Record a settled frame: the list reads the signal, the next visit reads the storage. */
export function publishViewport(viewport: MapViewport): void {
  mapViewport.value = viewport;
  writeStorage(CAMERA_STORAGE_KEY, serializeCamera(viewport));
}
