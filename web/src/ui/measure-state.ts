/**
 * The measure tool's state (V2-D3), kept in the entry chunk because it is tiny: whether the
 * panel is open, and the drawing the map pane hands the controller. The panel itself and
 * its maths load lazily (`measure-panel.tsx`), only when a reader opens it.
 *
 * The measure panel and the Layers panel share the space under the map controls, so
 * opening one closes the other. Nothing here is persisted: a measurement is a question of
 * the moment, and a page reload that re-drew last week's outline would be a stale answer.
 */

import { effect, signal } from '@preact/signals';

import type { MeasureOverlay } from '../core/types.js';
import { layersPanelOpen, setLayersPanelOpen } from './layers.js';

export const MEASURE_PANEL_ID = 'fw-measure-panel';

export const measurePanelOpen = signal(false);

/** What the map draws and where its taps go; `null` while the tool is closed. */
export const measureOverlay = signal<MeasureOverlay | null>(null);

export function setMeasurePanelOpen(open: boolean): void {
  if (open && layersPanelOpen.peek()) setLayersPanelOpen(false);
  measurePanelOpen.value = open;
  if (!open) measureOverlay.value = null;
}

// The Layers toggle knows nothing of this panel; this is where the two meet.
effect(() => {
  if (layersPanelOpen.value && measurePanelOpen.peek()) setMeasurePanelOpen(false);
});

/** Test seam. */
export function resetMeasureForTest(): void {
  measurePanelOpen.value = false;
  measureOverlay.value = null;
}
