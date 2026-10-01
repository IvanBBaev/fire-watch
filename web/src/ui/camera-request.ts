/**
 * "Fly the map there" from anywhere in the tree — the place search lives in the list
 * panel, the map is mounted by the shell above the router. The map pane subscribes and
 * hands the camera to the controller through the same path as its own "Balkans" and
 * "my location" controls, so a search before the map chunk has loaded is held and
 * applied when it arrives, exactly like theirs.
 *
 * Each request is a new object, so asking for the same place twice flies twice.
 */

import { signal } from '@preact/signals';

import type { MapCamera } from '../core/geo/viewport.js';

export interface CameraRequest {
  readonly camera: MapCamera;
}

export const cameraRequest = signal<CameraRequest | null>(null);

export function requestCamera(camera: MapCamera): void {
  cameraRequest.value = { camera };
}
