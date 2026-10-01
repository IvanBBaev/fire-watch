/**
 * The new-signal controller (TASKS F, "new since you last looked"): keeps the per-browser
 * seen record in step with the store and exposes the result as signals for the counter.
 *
 * What counts as seen:
 * - on the first visit ever, everything already on the map (so a first visit is quiet);
 * - whatever was on screen while the page was visible, recorded when it is hidden or
 *   closed — so the title badge counts exactly what arrived while the viewer was away;
 * - anything the viewer acknowledges: "Show", "Mark all seen", or opening the event.
 *
 * The sound cue is off by default. It never plays for the first data of a page load, and
 * never for an observation older than the viewer's last visit.
 *
 * Wired from boot.ts (the composition root) with the visibility and audio adapters; the
 * counter component only reads the signals and calls the actions below.
 */

import { signal } from '@preact/signals';

import type { ServerNow } from '../core/ports.js';
import {
  baselineSeenState,
  cueKey,
  diffNewSignals,
  markAllSeen,
  markSeen,
  parseSeenState,
  pruneSeen,
  serializeSeenState,
  soundEligible,
  titleWithBadge,
  withLastVisit,
} from '../core/store/new-signals.js';
import type { NewSignal, SeenState } from '../core/store/new-signals.js';
import type { FireEventStore } from '../core/types.js';
import { readStorage, writeStorage } from './storage.js';

export const SEEN_STORAGE_KEY = 'fw:new-signals';
export const SOUND_STORAGE_KEY = 'fw:new-signals-sound';

/** Page visibility and the document title (adapters/page-visibility.ts). */
export interface PageVisibility {
  isHidden(): boolean;
  /** Called with `true` when the page is hidden or being closed, `false` when shown. */
  onChange(callback: (hidden: boolean) => void): () => void;
  readTitle(): string;
  writeTitle(title: string): void;
}

/** The optional chime (adapters/audio-cue.ts). */
export interface AudioCue {
  /** Must be called from inside a user gesture; browsers block audio otherwise. */
  unlock(): void;
  /** Plays only when already unlocked; otherwise does nothing. */
  play(): void;
}

export interface NewSignalsDeps {
  readonly store: FireEventStore;
  readonly serverNow: ServerNow;
  readonly visibility: PageVisibility;
  readonly audio: AudioCue;
}

/** Current signals, newest observation first. */
export const newSignals = signal<readonly NewSignal[]>([]);

export const newSignalSound = signal<boolean>(readStorage(SOUND_STORAGE_KEY) === 'on');

interface Controller {
  acknowledge(ids: readonly string[]): void;
  acknowledgeAll(): void;
  unlockAudio(): void;
}

let controller: Controller | null = null;

/** Mark events seen (the counter's "Show", or an opened event page). */
export function acknowledgeSignals(ids: readonly string[]): void {
  controller?.acknowledge(ids);
}

export function acknowledgeAllSignals(): void {
  controller?.acknowledgeAll();
}

/** Call from the Settings click handler: the click is the gesture that unlocks audio. */
export function setNewSignalSound(on: boolean): void {
  newSignalSound.value = on;
  writeStorage(SOUND_STORAGE_KEY, on ? 'on' : 'off');
  if (on) controller?.unlockAudio();
}

export function startNewSignals({
  store,
  serverNow,
  visibility,
  audio,
}: NewSignalsDeps): () => void {
  const baseTitle = visibility.readTitle();
  let seen: SeenState | null = parseSeenState(readStorage(SEEN_STORAGE_KEY));
  if (seen !== null) seen = pruneSeen(seen, serverNow());
  const cued = new Set<string>();
  /** The first data of this page load never makes a sound. */
  let firstData = true;

  const persist = (): void => {
    if (seen !== null) writeStorage(SEEN_STORAGE_KEY, serializeSeenState(seen));
  };

  const publish = (current: SeenState): void => {
    const signals = diffNewSignals(store.state().events, current);
    newSignals.value = signals;
    visibility.writeTitle(
      visibility.isHidden() ? titleWithBadge(baseTitle, signals.length) : baseTitle,
    );
  };

  const evaluate = (): void => {
    const state = store.state();
    // Nothing to compare against until the first full snapshot: baselining an empty
    // store would count the whole map as new once it arrives.
    if (state.lastSnapshotAt === null) return;
    if (seen === null) {
      seen = baselineSeenState(state.events, serverNow());
      persist();
    }
    const current = seen;
    const signals = diffNewSignals(state.events, current);
    const eligible = soundEligible(signals, current, cued);
    for (const signal of eligible) cued.add(cueKey(signal.id, signal.lastObservedMs));
    if (!firstData && eligible.length > 0 && newSignalSound.peek()) audio.play();
    firstData = false;
    publish(current);
  };

  const update = (next: SeenState): void => {
    if (next === seen) return;
    seen = next;
    persist();
    publish(next);
  };

  const stopStore = store.subscribe(evaluate);
  const stopVisibility = visibility.onChange((hidden) => {
    if (seen === null) return;
    if (hidden) {
      // What was on screen while visible counts as seen; the visit ends now.
      update(
        pruneSeen(withLastVisit(markAllSeen(seen, store.state().events), serverNow()), serverNow()),
      );
    } else {
      publish(seen);
    }
  });

  controller = {
    acknowledge(ids) {
      if (seen !== null) update(markSeen(seen, store.state().events, ids));
    },
    acknowledgeAll() {
      if (seen !== null) update(markAllSeen(seen, store.state().events));
    },
    unlockAudio() {
      audio.unlock();
    },
  };
  evaluate();

  return () => {
    stopStore();
    stopVisibility();
    controller = null;
    newSignals.value = [];
    visibility.writeTitle(baseTitle);
  };
}
