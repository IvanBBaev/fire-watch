/**
 * Imagery state as signals (ADR-001 A1.3/A2.3, TASKS G6): what the server currently
 * offers, what this session chose, and the raster URL the map controller consumes.
 *
 * The choice is per session and deliberately not persisted: imagery spends a metered
 * quota, so every visit starts on the basemap and imagery is something a reader asks for.
 * When the server withdraws the handles the choice is dropped with them — a later
 * re-enable (a new quota period, an ops override) brings the toggle back switched off,
 * never the layer back on by itself.
 */

import { computed, signal } from '@preact/signals';

import type { ImageryHandles } from '../core/imagery/index.js';
import { imageryTileUrl, sameImageryHandles } from '../core/imagery/index.js';

const handles = signal<ImageryHandles | null>(null);
const chosen = signal(false);

/** Whether the toggle exists at all: the server's call, not the reader's. */
export const imageryOffered = computed(() => handles.value !== null);

/** Whether the reader has imagery switched on (only meaningful while offered). */
export const imageryOn = computed(() => handles.value !== null && chosen.value);

/** The raster tile URL to draw, or `null` for the basemap alone — feed to `setImagery`. */
export const imageryTilesUrl = computed(() => {
  const current = handles.value;
  return current !== null && chosen.value ? imageryTileUrl(current) : null;
});

/** The client-config refresher's sink (`createImageryRefresh({ onChange })`). */
export function setImageryHandles(next: ImageryHandles | null): void {
  if (sameImageryHandles(handles.peek(), next)) return;
  if (next === null) chosen.value = false;
  handles.value = next;
}

export function toggleImagery(): void {
  if (handles.peek() === null) return;
  chosen.value = !chosen.peek();
}
