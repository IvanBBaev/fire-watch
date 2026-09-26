/**
 * The two camera controls: back to the default frame, and to wherever the user is.
 *
 * They sit over the map rather than in the header because they act on the map and nothing
 * else. Both are plain buttons with visible labels — a compass glyph would need a tooltip
 * to be understood, and this product is used by people in a hurry.
 *
 * Location handling lives here in full, including the one automatic attempt on a first
 * visit. That attempt is silent when it fails: the user did not ask for it, so a refusal or
 * a timeout leaves them on the default frame with nothing to dismiss. A press of the button
 * is a question, and every outcome of a question gets an answer.
 */

import { useCallback, useEffect, useRef, useState } from 'preact/hooks';

import { resolveLocateOutcome } from '../core/geo/locate.js';
import type { MapCamera } from '../core/geo/viewport.js';
import { useApp } from './context.js';
import { ImageryToggle } from './imagery-toggle.js';
import { HOME_CAMERA, shouldOfferLocation } from './map-camera.js';

export function MapControls({ onMove }: { readonly onMove: (camera: MapCamera) => void }) {
  const { messages, geolocator } = useApp();
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // The callback outlives any single render; the effect below must not re-run on it.
  const onMoveRef = useRef(onMove);
  onMoveRef.current = onMove;

  const locate = useCallback(
    async (announceFailure: boolean): Promise<void> => {
      setBusy(true);
      setStatus(messages.mapControls.locating);
      const outcome = resolveLocateOutcome(await geolocator.locate());
      setBusy(false);
      switch (outcome.kind) {
        case 'moved':
          setStatus(null);
          onMoveRef.current(outcome.camera);
          return;
        case 'outsideCoverage':
          setStatus(announceFailure ? messages.mapControls.locationOutsideCoverage : null);
          return;
        case 'denied':
          setStatus(announceFailure ? messages.mapControls.locationDenied : null);
          return;
        case 'unavailable':
          setStatus(announceFailure ? messages.mapControls.locationUnavailable : null);
      }
    },
    [geolocator, messages],
  );

  // Once per mount (empty deps on purpose — `locate` is not a dependency here, a second
  // permission prompt on a locale change would be a bug). The shell mounts these controls
  // with the map, so "per mount" is "per visit", not per route change.
  useEffect(() => {
    if (shouldOfferLocation(location.hash)) void locate(false);
  }, []);

  return (
    <div class="map-controls">
      <div class="map-controls-buttons">
        <button
          type="button"
          class="map-control"
          onClick={() => {
            setStatus(null);
            onMove(HOME_CAMERA);
          }}
        >
          {messages.mapControls.home}
        </button>
        <button
          type="button"
          class="map-control"
          disabled={busy}
          onClick={() => {
            void locate(true);
          }}
        >
          {messages.mapControls.locate}
        </button>
        {/* Present only while the server offers imagery (ADR-001 A2.3). */}
        <ImageryToggle />
      </div>
      {/* Always rendered so a screen reader announces into an existing region. */}
      <p class="map-controls-status" role="status" aria-live="polite">
        {status}
      </p>
    </div>
  );
}
