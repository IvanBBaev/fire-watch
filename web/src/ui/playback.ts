/**
 * V2-A1 playback as the shell holds it: which window is chosen (`null` is live), its body,
 * the scrubber's cursor, play/pause and speed, and the draw the map controller takes.
 *
 * Live mode is never torn down. The store, the poller and the SSE reconciler keep running
 * while a window is replayed; the map only hides the live fire layers under the replay
 * (`map/playback-layer.ts`), and "Back to live" shows them again as they now are.
 *
 * A window is drawn only once its body has arrived. While it loads, or when it cannot be
 * had, the map stays live — an empty replay beside an "unavailable" line would read as an
 * empty sky.
 *
 * Only what the first render and the `pb=` member need lives here. Fetching a window
 * (`playback-loader.ts`) and everything the scrubber does (`playback-replay.tsx`, the lazy
 * chunk) build on these signals (CI-12).
 */

import { batch, computed, signal } from '@preact/signals';
import {
  HISTORY_RANGE_MINUTES,
  cursorForInstant,
  cursorInstantMs,
  formatPlaybackParam,
  type HistoryBody,
  type HistoryRange,
  type PlaybackCollection,
  type PlaybackLink,
  type PlaybackSpeed,
} from '../core/playback.js';

export type PlaybackStatus =
  | { readonly kind: 'idle' }
  | { readonly kind: 'loading'; readonly range: HistoryRange }
  | { readonly kind: 'unavailable'; readonly range: HistoryRange }
  | {
      readonly kind: 'ready';
      readonly body: HistoryBody;
      /** Built once per body in the lazy module, so the map re-uploads only for a new window. */
      readonly collection: PlaybackCollection;
    };

const IDLE: PlaybackStatus = { kind: 'idle' };

/** The replayed window; `null` is live mode. */
export const playbackRange = signal<HistoryRange | null>(null);
export const playbackStatus = signal<PlaybackStatus>(IDLE);
/** Minutes from the window start; meaningful only while a body is ready. */
export const playbackCursor = signal(0);
export const playbackPlaying = signal(false);
export const playbackSpeed = signal<PlaybackSpeed>(1);
/** Whether the scrubber's panel is shown. */
export const playbackPanelOpen = signal(false);
/** A link's pinned instant, held until its window arrives. */
export const pendingAtMs = signal<number | null>(null);

/** The ready body, or `null`. */
export const playbackBody = computed(() => {
  const status = playbackStatus.value;
  return status.kind === 'ready' ? status.body : null;
});

/** The ready window's GeoJSON collection, or `null`. */
export const collectionFor = computed<PlaybackCollection | null>(() => {
  const status = playbackStatus.value;
  return status.kind === 'ready' ? status.collection : null;
});

/** Whether the map is showing a replay rather than now. */
export const playbackActive = computed(() => collectionFor.value !== null);

/** Replay `range`, optionally pinned at `atMs`; the sync below fetches the body. */
export function startPlayback(range: HistoryRange, atMs: number | null = null): void {
  playbackPlaying.value = false;
  pendingAtMs.value = atMs;
  if (playbackRange.peek() === range) {
    const body = playbackBody.peek();
    if (body !== null) {
      playbackCursor.value =
        atMs === null ? HISTORY_RANGE_MINUTES[range] : cursorForInstant(body, atMs);
      pendingAtMs.value = null;
    } else if (playbackStatus.peek().kind === 'unavailable') {
      // Choosing the window again is the retry.
      playbackStatus.value = IDLE;
    }
    return;
  }
  // One batch, so the loader's effect sees the new window and the idle status together
  // and fetches once.
  batch(() => {
    playbackStatus.value = IDLE;
    playbackRange.value = range;
  });
}

/** Back to live: the replay is dropped and the live layers show again. */
export function stopPlayback(): void {
  batch(() => {
    playbackPlaying.value = false;
    pendingAtMs.value = null;
    playbackStatus.value = IDLE;
    playbackRange.value = null;
  });
}

/** What the `pb=` member should say right now; `null` (no member) in live mode. */
export const playbackLink = computed<PlaybackLink | null>(() => {
  const range = playbackRange.value;
  if (range === null) return null;
  const body = playbackBody.value;
  if (body === null) return { range, atMs: pendingAtMs.value };
  const cursor = playbackCursor.value;
  // A playing scrubber, or one at the window's end, is "this range, up to now".
  if (playbackPlaying.value || cursor >= HISTORY_RANGE_MINUTES[range]) {
    return { range, atMs: null };
  }
  return { range, atMs: cursorInstantMs(body, cursor) };
});

/** The `pb=` member's spelling, or `null`. */
export const playbackParam = computed(() => {
  const link = playbackLink.value;
  return link === null ? null : formatPlaybackParam(link);
});

/** Test seam: back to live with every default. */
export function resetPlaybackForTest(): void {
  stopPlayback();
  playbackCursor.value = 0;
  playbackSpeed.value = 1;
  playbackPanelOpen.value = false;
}
