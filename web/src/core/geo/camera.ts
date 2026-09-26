/**
 * The camera as a value that survives a reload: validated, rounded, and serialised.
 *
 * Two places remember where the user was looking — the URL fragment (`#map=z/lat/lon`,
 * owned by `map/hash.ts`) and localStorage. Both need the same plausibility test and the
 * same precision, so both live here, in the DOM-free core: `map/` and `ui/` each import
 * them rather than growing a private copy that drifts.
 *
 * Precision is capped on purpose. Four decimals of latitude is ~11 m, which is all a
 * viewport means; storing a centre at full float precision would record where someone was
 * standing when they last opened the app, at a resolution nothing here needs.
 */

import type { MapCamera } from './viewport.js';

/** The `#map=` fragment member, shared with the hash codec so the literal has one home. */
export const CAMERA_HASH_MEMBER_PREFIX = 'map=';

/** localStorage key for the last camera. Namespaced — the origin may host more than us. */
export const CAMERA_STORAGE_KEY = 'fw.map-camera';

/** Decimals for a stored/serialised zoom. Exported so the hash codec matches exactly. */
export const CAMERA_ZOOM_DECIMALS = 1;

/** Decimals for a stored/serialised degree — 4 is ~11 m, the cap described above. */
export const CAMERA_DEGREE_DECIMALS = 4;

const MAX_ZOOM = 24;

/**
 * Is this a camera a map could actually be pointed at? Range checks only — "plausible"
 * is not "sensible": a camera over the Pacific parses fine, it is simply not ours to
 * refuse. Callers that care about coverage test with {@link isInsideCoverage}.
 */
export function isPlausibleCamera(camera: MapCamera): boolean {
  const { zoom, lat, lon } = camera;
  if (!Number.isFinite(zoom) || !Number.isFinite(lat) || !Number.isFinite(lon)) return false;
  if (zoom < 0 || zoom > MAX_ZOOM) return false;
  if (lat < -90 || lat > 90) return false;
  return lon >= -180 && lon <= 180;
}

/** Round to the stored/URL precision. Display and persistence only — never an identity. */
export function roundCamera(camera: MapCamera): MapCamera {
  return {
    zoom: Number(camera.zoom.toFixed(CAMERA_ZOOM_DECIMALS)),
    lat: Number(camera.lat.toFixed(CAMERA_DEGREE_DECIMALS)),
    lon: Number(camera.lon.toFixed(CAMERA_DEGREE_DECIMALS)),
  };
}

/** Does the fragment carry a camera? Distinguishes "the link says where" from "we guess". */
export function hasCameraHash(hash: string): boolean {
  const fragment = hash.startsWith('#') ? hash.slice(1) : hash;
  return fragment.split('&').some((part) => part.startsWith(CAMERA_HASH_MEMBER_PREFIX));
}

export function serializeCamera(camera: MapCamera): string {
  return JSON.stringify(roundCamera(camera));
}

/**
 * Parse a stored camera. Tolerant by contract: a hand-edited value, a key written by an
 * older build, or a quota-truncated string all answer `null` and the caller falls back to
 * the default view. A stored preference is never worth a crash on boot.
 */
export function parseCamera(raw: string | null): MapCamera | null {
  if (raw === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;

  const { zoom, lat, lon } = parsed as Record<string, unknown>;
  if (typeof zoom !== 'number' || typeof lat !== 'number' || typeof lon !== 'number') return null;

  const camera = { zoom, lat, lon };
  return isPlausibleCamera(camera) ? camera : null;
}
