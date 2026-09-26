/**
 * Map viewport state in the URL fragment: `#map=z/lat/lon` (e.g. `#map=7.2/42.7/25.3`).
 *
 * The fragment is a separate namespace from the route path (ADR-005 D2): `/event/:id`
 * routing never touches it and this module never touches anything but the fragment.
 * The parser is deliberately tolerant — a hand-edited or truncated hash returns `null`
 * and the caller falls back to `DEFAULT_VIEW`, never throws.
 *
 * This module owns only the *encoding*. What counts as a valid camera and how precise a
 * stored one may be belong to `core/geo/camera.ts`, shared with the localStorage codec so
 * a link and a remembered view can never disagree about either.
 */

import {
  CAMERA_DEGREE_DECIMALS,
  CAMERA_HASH_MEMBER_PREFIX,
  CAMERA_ZOOM_DECIMALS,
  isPlausibleCamera,
} from '../core/geo/camera.js';
import type { MapCamera } from '../core/geo/viewport.js';

export type MapViewState = MapCamera;

/** Zoom to 1 decimal, lat/lon to 4 (≈11 m at the equator — plenty for a viewport). */
export function formatMapHash(view: MapViewState): string {
  const zoom = view.zoom.toFixed(CAMERA_ZOOM_DECIMALS);
  const lat = view.lat.toFixed(CAMERA_DEGREE_DECIMALS);
  const lon = view.lon.toFixed(CAMERA_DEGREE_DECIMALS);
  return `#${CAMERA_HASH_MEMBER_PREFIX}${zoom}/${lat}/${lon}`;
}

function parseFiniteNumber(raw: string | undefined): number | null {
  if (raw === undefined || raw.trim() === '') return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

/**
 * Parse a location hash back into a viewport. Accepts the hash with or without the
 * leading `#`, and tolerates other `&`-separated fragment members around ours.
 * Returns `null` on anything malformed or out of range — garbage in, no view out.
 */
export function parseMapHash(hash: string): MapViewState | null {
  const fragment = hash.startsWith('#') ? hash.slice(1) : hash;
  const member = fragment.split('&').find((part) => part.startsWith(CAMERA_HASH_MEMBER_PREFIX));
  if (member === undefined) return null;

  const segments = member.slice(CAMERA_HASH_MEMBER_PREFIX.length).split('/');
  if (segments.length !== 3) return null;

  const zoom = parseFiniteNumber(segments[0]);
  const lat = parseFiniteNumber(segments[1]);
  const lon = parseFiniteNumber(segments[2]);
  if (zoom === null || lat === null || lon === null) return null;

  const camera = { zoom, lat, lon };
  return isPlausibleCamera(camera) ? camera : null;
}
