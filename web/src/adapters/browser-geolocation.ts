/**
 * The browser's Geolocation API behind the {@link GeoLocator} port.
 *
 * Nothing here is requested at boot: the permission prompt fires only when the user presses
 * the locate control, so opening the site never asks a question the user did not invite.
 * The fix is coarse on purpose (`enableHighAccuracy: false`) — the camera needs a region,
 * a GPS lock would cost battery and precision we then throw away when rounding the camera.
 */

import type { GeoFixOutcome, GeoLocator } from '../core/ports.js';

/**
 * How long to wait for a fix. Longer than a warm cached read and shorter than a user's
 * patience: past this the honest answer is "couldn't get it", with the control usable again.
 */
export const GEO_TIMEOUT_MS = 8_000;

/** A fix from the last five minutes is fine — nobody outruns a viewport that fast. */
export const GEO_MAX_AGE_MS = 300_000;

export function createBrowserGeolocator(): GeoLocator {
  return {
    locate() {
      // Also false in a non-secure context and in the SSR/prerender pass, where the whole
      // API is absent rather than merely blocked.
      if (typeof navigator === 'undefined' || navigator.geolocation === undefined) {
        return Promise.resolve<GeoFixOutcome>({ kind: 'unavailable' });
      }

      return new Promise<GeoFixOutcome>((resolve) => {
        navigator.geolocation.getCurrentPosition(
          (position) =>
            resolve({
              kind: 'fix',
              lon: position.coords.longitude,
              lat: position.coords.latitude,
            }),
          (error) =>
            resolve(
              error.code === error.PERMISSION_DENIED ? { kind: 'denied' } : { kind: 'unavailable' },
            ),
          {
            enableHighAccuracy: false,
            timeout: GEO_TIMEOUT_MS,
            maximumAge: GEO_MAX_AGE_MS,
          },
        );
      });
    },
  };
}
