/**
 * The time window, shared between the list that offers it and the map that obeys it.
 *
 * A signal for the same reason the camera is one: the picker lives inside the router, the
 * map is mounted by the shell above it, and lifting the value through the shell would
 * re-render the map container on every change. Both sides subscribe to the same value, so
 * neither can show a set of fires the other denies.
 *
 * Persisted: a reader who narrowed the window to six hours meant it, and re-widening it on
 * every visit would quietly put the noise back.
 */

import { signal } from '@preact/signals';

import type { AgeWindowId } from '../core/time/age-filter.js';
import {
  AGE_WINDOW_STORAGE_KEY,
  DEFAULT_AGE_WINDOW,
  parseAgeWindow,
} from '../core/time/age-filter.js';
import { readStorage, writeStorage } from './storage.js';

export const ageWindow = signal<AgeWindowId>(
  parseAgeWindow(readStorage(AGE_WINDOW_STORAGE_KEY)) ?? DEFAULT_AGE_WINDOW,
);

export function setAgeWindow(next: AgeWindowId): void {
  ageWindow.value = next;
  writeStorage(AGE_WINDOW_STORAGE_KEY, next);
}
