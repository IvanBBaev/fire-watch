/**
 * The two camera controls — back to the default frame, and to wherever the user is — the
 * Layers and playback disclosures (`layers-panel.tsx`, `playback-panel.tsx`) and the measure
 * tool (`measure-control.tsx`, V2-D3).
 *
 * They sit over the map rather than in the header because they act on the map and nothing
 * else. Both are plain buttons with visible labels — a compass glyph would need a tooltip
 * to be understood, and this product is used by people in a hurry.
 *
 * Location handling lives here in full, and it starts only from a press of the button
 * (07-product-ux §5.8, §5.9.1: no permission walls, locate is on demand). Nothing asks for
 * the user's position on load — a first visit opens on the default frame or on the frame
 * the link carries, and the browser's permission prompt appears only as the answer to a
 * question the user just asked. A press is a question, and every outcome of a question
 * gets an answer.
 */

import { useCallback, useRef, useState } from 'preact/hooks';

import { resolveLocateOutcome } from '../core/geo/locate.js';
import type { MapCamera } from '../core/geo/viewport.js';
import { useApp } from './context.js';
import { LayersPanel, LayersToggle } from './layers-panel.js';
import { HOME_CAMERA } from './map-camera.js';
import { PlaybackPanel, PlaybackToggle } from './playback-panel.js';
import { MeasurePanelHost, MeasureToggle } from './measure-control.js';

export function MapControls({ onMove }: { readonly onMove: (camera: MapCamera) => void }) {
  const { messages, geolocator } = useApp();
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // A fix can land after a re-render; it must reach the current `onMove`, not the one the
  // press closed over.
  const onMoveRef = useRef(onMove);
  onMoveRef.current = onMove;

  const locate = useCallback(async (): Promise<void> => {
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
        setStatus(messages.mapControls.locationOutsideCoverage);
        return;
      case 'denied':
        setStatus(messages.mapControls.locationDenied);
        return;
      case 'unavailable':
        setStatus(messages.mapControls.locationUnavailable);
    }
  }, [geolocator, messages]);

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
            void locate();
          }}
        >
          {messages.mapControls.locate}
        </button>
        {/* Third on purpose: Home and Locate keep their positions. The basemap choice
            (imagery, ADR-001 A2.3) lives inside the panel (TASKS G4). */}
        <LayersToggle />
        {/* Fourth: the replay (V2-A1) comes after every existing control. */}
        <PlaybackToggle />
        {/* Fifth: the measure tool (V2-D3), after the replay. */}
        <MeasureToggle />
      </div>
      <LayersPanel />
      <PlaybackPanel />
      <MeasurePanelHost />
      {/* Always rendered so a screen reader announces into an existing region. */}
      <p class="map-controls-status" role="status" aria-live="polite">
        {status}
      </p>
    </div>
  );
}
