/**
 * The measure tool's entry-chunk half (V2-D3): the button over the map, and the host that
 * fetches the panel (`measure-panel.tsx`) the first time a reader opens it and feeds it
 * everything it needs through props.
 *
 * The host does the app-facing work — which active fires the reader can see, where the map
 * centre is, where the drawing goes — so that the lazy panel imports nothing the entry
 * chunk also imports. A lazy chunk that shared modules with the entry would make the
 * bundler split those modules into chunks of their own, and every split costs the first
 * load bytes (CI-12).
 *
 * The nearest-fire question asks only the fires the reader can see: active events that
 * pass the same time window and filters as the list and the map. A fire hidden by a filter
 * is not "the nearest fire" to someone who chose to hide it.
 */

import type { FunctionComponent } from 'preact';
import { useEffect, useMemo, useState } from 'preact/hooks';

import { partitionEvents } from '../core/filter/event-filter.js';
import { sortedEvents } from '../core/store/index.js';
import { ageCutoffMs } from '../core/time/age-filter.js';
import type { MeasureOverlay } from '../core/types.js';
import { ageWindow } from './age-window.js';
import { useApp } from './context.js';
import { regionFilter, regionIndex, sensitivityFilter, sourceFamily } from './filters.js';
import { placeName } from './logic/place.js';
import { mapViewport } from './map-camera.js';
import type { MeasureCandidate, MeasurePanelProps } from './measure-panel.js';
import {
  MEASURE_PANEL_ID,
  measureOverlay,
  measurePanelOpen,
  setMeasurePanelOpen,
} from './measure-state.js';
import { useNow } from './use-now.js';
import { useStoreState } from './use-store.js';

/**
 * The measure tool's button. Rendered only once the map has reported a frame: with no map
 * (WebGL denied, the chunk failed) there is nothing to measure on, and a dead button would
 * be one more tab stop between a keyboard reader and the list.
 */
export function MeasureToggle() {
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

const setDrawing = (overlay: MeasureOverlay | null): void => {
  measureOverlay.value = overlay;
};

/** The panel, fetched the first time it is opened — never on the first-render path. */
export function MeasurePanelHost() {
  const open = measurePanelOpen.value;
  const [Panel, setPanel] = useState<FunctionComponent<MeasurePanelProps> | null>(null);
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
  return Panel === null ? null : <LoadedPanel Panel={Panel} open={open} />;
}

function LoadedPanel({
  Panel,
  open,
}: {
  readonly Panel: FunctionComponent<MeasurePanelProps>;
  readonly open: boolean;
}) {
  const { locale, store, serverNow } = useApp();
  const state = useStoreState(store);
  const nowMs = useNow(serverNow);
  const cutoffMs = ageCutoffMs(nowMs, ageWindow.value);
  const family = sourceFamily.value;
  const oblast = regionFilter.value;
  const sensitivity = sensitivityFilter.value;
  const regionAt = regionIndex.value?.regionAt ?? null;
  const candidates = useMemo(
    (): readonly MeasureCandidate[] =>
      open
        ? partitionEvents(sortedEvents(state), { cutoffMs, family, oblast, sensitivity }, regionAt)
            .visible.filter((event) => event.status === 'active')
            .map((event) => ({
              id: event.id,
              lon: event.lon,
              lat: event.lat,
              place: placeName(event, locale),
            }))
        : [],
    [open, state, cutoffMs, family, oblast, sensitivity, regionAt, locale],
  );
  const viewport = mapViewport.value;
  const centre = useMemo(
    () => (viewport === null ? null : { lon: viewport.lon, lat: viewport.lat }),
    [viewport?.lon, viewport?.lat],
  );
  return (
    <Panel
      id={MEASURE_PANEL_ID}
      open={open}
      centre={centre}
      candidates={candidates}
      onDrawing={setDrawing}
    />
  );
}
