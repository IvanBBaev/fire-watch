/**
 * V2-A1 playback, the loading half: the lazy replay chunk (`playback-replay.tsx`), the
 * chosen window's body, and the draw the map controller takes (whose FIRMS credit comes
 * from the chunk, which is always loaded once a window is ready).
 *
 * The chunk holds the history parser, the GeoJSON builder, landing a fetched window and
 * the whole scrubber panel, so none of it is on the first-render or map path (CI-12,
 * `LAZY_ROLES`). It is imported the first time the panel opens or a window is chosen (a
 * `pb=` link), once, and every failure — the chunk, the network, a body this build cannot
 * replay — ends as `unavailable` with the map still live, never a throw.
 *
 * This module imports the chunk and the chunk imports the shell's state (`playback.ts`),
 * never this module, so the dependency stays one-way.
 */

import { effect, signal } from '@preact/signals';
import { useMemo } from 'preact/hooks';

import type { HistoryRange, PlaybackDraw } from '../core/playback.js';
import { useApp } from './context.js';
import { collectionFor, playbackCursor, playbackRange, playbackStatus } from './playback.js';
import type * as PlaybackReplay from './playback-replay.js';

type ReplayModule = typeof PlaybackReplay;

/** The lazy chunk once it has loaded; `null` before (or after a failed load). */
export const replayModule = signal<ReplayModule | null>(null);

let pending: Promise<ReplayModule | null> | null = null;

/** Import the replay chunk once; a failed import is retried by the next call. */
export function loadReplayModule(): Promise<ReplayModule | null> {
  pending ??= import('./playback-replay.js').then(
    (module) => {
      replayModule.value = module;
      return module;
    },
    () => {
      pending = null;
      return null;
    },
  );
  return pending;
}

/** The browser seams the loader uses; swapped in tests. */
export interface PlaybackLoaderDeps {
  readonly fetch: (url: string) => Promise<Response>;
  /** `{range}` is replaced with the window (`config.historyUrlTemplate`). */
  readonly urlTemplate: string;
}

export const browserPlaybackLoader = (urlTemplate: string): PlaybackLoaderDeps => ({
  fetch: (url) => fetch(url, { credentials: 'omit' }),
  urlTemplate,
});

/** Bumped by every load, so only the newest answer lands. */
let loadGeneration = 0;

/** Fetch one window and land it; a later load, or a window no longer chosen, wins. */
export async function loadPlayback(range: HistoryRange, deps: PlaybackLoaderDeps): Promise<void> {
  loadGeneration += 1;
  const generation = loadGeneration;
  playbackStatus.value = { kind: 'loading', range };
  const replay = await loadReplayModule();
  const loaded =
    replay === null ? null : await replay.fetchReplay(range, deps.fetch, deps.urlTemplate);
  // A later load wins; an answer for a window no longer chosen is dropped.
  if (generation !== loadGeneration) return;
  if (replay !== null && loaded !== null) replay.landReplay(range, loaded);
  else if (playbackRange.peek() === range) playbackStatus.value = { kind: 'unavailable', range };
}

/** Keep the chosen window loaded. Returns the disposer; the map pane runs it. */
export function startPlaybackSync(deps: PlaybackLoaderDeps): () => void {
  return effect(() => {
    const range = playbackRange.value;
    if (range === null || playbackStatus.value.kind !== 'idle') return;
    void loadPlayback(range, deps);
  });
}

/**
 * What the map draws: the window's detections up to the cursor with the FIRMS credit on
 * the source, or `null` for live mode — so the map corner carries the credit exactly while
 * replayed detections are on screen (CI-13).
 */
export function usePlaybackDraw(): PlaybackDraw | null {
  const { clock, messages } = useApp();
  const collection = collectionFor.value;
  const cursor = playbackCursor.value;
  // A collection exists only once the replay chunk has landed it, so its credit is there.
  const credit = replayModule.value?.firmsCreditText;
  const attribution = useMemo(
    () => (credit === undefined ? '' : credit(clock, messages)),
    [credit, clock, messages],
  );
  return useMemo(
    () => (collection === null ? null : { collection, attribution, cursor }),
    [collection, attribution, cursor],
  );
}
