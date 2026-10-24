/**
 * The two camera controls — back to the default frame, and to wherever the user is — the
 * Layers disclosure (`layers-panel.tsx`) and the measure tool (`measure-panel.tsx`, V2-D3).
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

import type { FunctionComponent } from 'preact';
import { useCallback, useEffect, useRef, useState } from 'preact/hooks';

import { resolveLocateOutcome } from '../core/geo/locate.js';
import type { MapCamera } from '../core/geo/viewport.js';
import { useApp } from './context.js';
import { LayersPanel, LayersToggle } from './layers-panel.js';
import { HOME_CAMERA, mapViewport, shouldOfferLocation } from './map-camera.js';
import { MEASURE_PANEL_ID, measurePanelOpen, setMeasurePanelOpen } from './measure-state.js';

/**
 * The measure tool's button (V2-D3). Rendered only once the map has reported a frame: with
 * no map (WebGL denied, the chunk failed) there is nothing to measure on, and a dead button
 * would be one more tab stop between a keyboard reader and the list.
 */
function MeasureToggle() {
  const { messages } = useApp();
  if (mapViewport.value === null) return null;
  const open = measurePanelOpen.value;
  return (
    <button
      type="button"
      class="map-control"
      aria-expanded={open}
      aria-controls={MEASURE_PANEL_ID}
      onClick={() => {
        setMeasurePanelOpen(!open);
      }}
    >
      {messages.measure.toggle}
    </button>
  );
}

/** The panel, fetched the first time it is opened — never on the first-render path. */
function LazyMeasurePanel() {
  const open = measurePanelOpen.value;
  const [Panel, setPanel] = useState<FunctionComponent | null>(null);
  useEffect(() => {
    if (!open || Panel !== null) return;
    let live = true;
    import('./measure-panel.js').then(
      (module) => {
        if (live) setPanel(() => module.MeasurePanel);
      },
      () => {
        // A chunk that failed to load leaves the button doing nothing rather than throwing;
        // closing resets it, so the next open tries again.
        if (live) setMeasurePanelOpen(false);
      },
    );
    return () => {
      live = false;
    };
  }, [open, Panel]);
  return Panel === null ? null : <Panel />;
}

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
        {/* Third on purpose: Home and Locate keep their positions. The basemap choice
            (imagery, ADR-001 A2.3) lives inside the panel (TASKS G4). */}
        <LayersToggle />
        {/* Fourth, after Layers: the positions before it are relied on (see above). */}
        <MeasureToggle />
      </div>
      <LayersPanel />
      <LazyMeasurePanel />
      {/* Always rendered so a screen reader announces into an existing region. */}
      <p class="map-controls-status" role="status" aria-live="polite">
        {status}
      </p>
    </div>
  );
}
