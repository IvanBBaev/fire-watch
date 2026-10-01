/**
 * The new-signal controller and counter, end to end over a fake store, visibility,
 * storage and audio: a first visit is quiet, arrivals are counted and cued (only when the
 * sound is on, and never for the first data of a load or for data older than the last
 * visit), hiding the page records the visit and badges the title, and the counter renders
 * a polite live region with 44 px controls and the newest observation's age.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import prerender from 'preact-iso/prerender';
import { LocationProvider } from 'preact-iso';

import { DEFAULT_CONFIG } from '../core/config.js';
import bg from '../core/i18n/bg.js';
import en from '../core/i18n/en.js';
import type { Messages } from '../core/i18n/messages.js';
import type { FireEvent, FireEventStore, StoreState } from '../core/types.js';
import { AppContext } from './context.js';
import type { AppServices } from './context.js';
import { NewSignalsCounter } from './new-signals-counter.js';
import {
  SEEN_STORAGE_KEY,
  acknowledgeAllSignals,
  acknowledgeSignals,
  newSignalSound,
  newSignals,
  setNewSignalSound,
  startNewSignals,
} from './new-signals.js';
import type { PageVisibility } from './new-signals.js';

const T0 = Date.parse('2026-08-08T12:00:00Z');
const MIN = 60_000;

function makeEvent(key: string, observedMs: number, overrides: Partial<FireEvent> = {}): FireEvent {
  const at = new Date(observedMs).toISOString();
  return {
    id: `fw-2026-${key}`,
    seq: 1,
    status: 'active',
    scoreBucket: 'likely',
    mergedInto: null,
    lon: 24.5,
    lat: 42.1,
    firstObservedAt: at,
    lastObservedAt: at,
    detectionCount: 2,
    placeNameBg: 'Сакар',
    placeNameEn: 'Sakar',
    areaHa: null,
    nextPassWindow: null,
    ...overrides,
  };
}

function fakeStore() {
  let state: StoreState = {
    events: new Map(),
    maxSeq: 0,
    lastSnapshotAt: null,
    freshness: null,
    feedStatus: 'connecting',
    needsSnapshot: false,
    sources: [],
  } as unknown as StoreState;
  const listeners = new Set<() => void>();
  const store = {
    state: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  } as unknown as FireEventStore;
  const apply = (...events: FireEvent[]): void => {
    state = {
      ...state,
      lastSnapshotAt: '2026-08-08T12:00:00Z',
      events: new Map([...state.events, ...events.map((e) => [e.id, e] as const)]),
    };
    for (const listener of listeners) listener();
  };
  return { store, apply };
}

function fakeVisibility() {
  let hidden = false;
  let title = 'Fire Watch';
  let callback: ((hidden: boolean) => void) | null = null;
  const visibility: PageVisibility = {
    isHidden: () => hidden,
    onChange(cb) {
      callback = cb;
      return () => {
        callback = null;
      };
    },
    readTitle: () => title,
    writeTitle: (next) => {
      title = next;
    },
  };
  return {
    visibility,
    title: () => title,
    setHidden: (next: boolean): void => {
      hidden = next;
      callback?.(next);
    },
  };
}

let storage: Map<string, string>;
let now: number;
let stop: (() => void) | null = null;

beforeEach(() => {
  storage = new Map();
  now = T0;
  vi.stubGlobal('window', {
    localStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
    },
  });
  newSignalSound.value = false;
});

afterEach(() => {
  stop?.();
  stop = null;
  vi.unstubAllGlobals();
});

function start() {
  const feed = fakeStore();
  const page = fakeVisibility();
  const audio = { unlock: vi.fn(), play: vi.fn() };
  stop = startNewSignals({
    store: feed.store,
    serverNow: () => now,
    visibility: page.visibility,
    audio,
  });
  return { ...feed, ...page, audio };
}

const ids = (): readonly string[] => newSignals.value.map((signal) => signal.id);

describe('startNewSignals', () => {
  it('keeps the first visit quiet, then counts arrivals newest first', () => {
    const { apply, audio } = start();
    apply(makeEvent('a', T0 - 30 * MIN));
    expect(ids()).toEqual([]);
    expect(storage.has(SEEN_STORAGE_KEY)).toBe(true);

    apply(makeEvent('b', T0 + MIN), makeEvent('c', T0 + 2 * MIN));
    expect(ids()).toEqual(['fw-2026-c', 'fw-2026-b']);
    expect(audio.play).not.toHaveBeenCalled(); // sound is off by default
  });

  it('walks through signals as they are acknowledged, and clears them all', () => {
    const { apply } = start();
    apply();
    apply(makeEvent('b', T0 + MIN), makeEvent('c', T0 + 2 * MIN), makeEvent('d', T0 + 3 * MIN));
    acknowledgeSignals(['fw-2026-d']);
    expect(ids()).toEqual(['fw-2026-c', 'fw-2026-b']);
    acknowledgeAllSignals();
    expect(ids()).toEqual([]);
  });

  it('cues once per observation when the sound is on, never on first data', () => {
    const { apply, audio } = start();
    setNewSignalSound(true);
    expect(audio.unlock).toHaveBeenCalledTimes(1);
    apply(makeEvent('a', T0 - MIN));
    expect(audio.play).not.toHaveBeenCalled();
    apply(makeEvent('b', T0 + MIN));
    expect(audio.play).toHaveBeenCalledTimes(1);
    apply(makeEvent('c', T0 - 5 * MIN)); // not newer than the floor: no signal, no cue
    apply(makeEvent('b', T0 + MIN)); // same observation again
    expect(audio.play).toHaveBeenCalledTimes(1);
  });

  it('badges the title while hidden and records the visit', () => {
    const { apply, setHidden, title, audio } = start();
    setNewSignalSound(true);
    apply(makeEvent('a', T0 - MIN));
    apply(makeEvent('b', T0 + MIN));
    now = T0 + 10 * MIN;
    setHidden(true);
    // What was on screen is seen; the visit ends now.
    expect(ids()).toEqual([]);
    expect(title()).toBe('Fire Watch');

    // Late data observed before the visit ended is counted but never cued.
    apply(makeEvent('late', T0 + 5 * MIN), makeEvent('fresh', T0 + 12 * MIN));
    expect(ids()).toEqual(['fw-2026-fresh', 'fw-2026-late']);
    expect(title()).toBe('(2) Fire Watch');
    expect(audio.play).toHaveBeenCalledTimes(2);

    setHidden(false);
    expect(title()).toBe('Fire Watch');
    expect(ids()).toEqual(['fw-2026-fresh', 'fw-2026-late']);
  });

  it('counts what arrived since the last visit on the next load, silently', () => {
    const first = start();
    first.apply(makeEvent('a', T0 - MIN));
    now = T0 + 10 * MIN;
    first.setHidden(true);
    stop?.();

    newSignalSound.value = true;
    now = T0 + 60 * MIN;
    const second = start();
    second.apply(makeEvent('a', T0 - MIN), makeEvent('b', T0 + 30 * MIN));
    expect(ids()).toEqual(['fw-2026-b']);
    expect(second.audio.play).not.toHaveBeenCalled();
  });
});

function services(messages: Messages): AppServices {
  return {
    store: {} as FireEventStore,
    clock: { epochNow: () => 0, monotonicNow: () => 0 },
    serverNow: () => T0 + 20 * MIN,
    config: DEFAULT_CONFIG,
    geolocator: { locate: () => Promise.reject(new Error('not asked')) },
    locale: messages === bg ? 'bg' : 'en',
    messages,
    setLocale: () => {},
  };
}

async function renderCounter(messages: Messages = en): Promise<string> {
  vi.stubGlobal('location', { pathname: '/', search: '', origin: 'https://fire.example.test' });
  const { html } = await prerender(
    <AppContext.Provider value={services(messages)}>
      <LocationProvider>
        <NewSignalsCounter />
      </LocationProvider>
    </AppContext.Provider>,
  );
  return html.replace(/<script[\s\S]*?<\/script>/g, '');
}

describe('NewSignalsCounter', () => {
  it('keeps an empty polite live region when there is nothing new', async () => {
    newSignals.value = [];
    const html = await renderCounter();
    expect(html).toContain('aria-live="polite"');
    expect(html).not.toContain('assertive');
    expect(html).not.toContain('<button');
  });

  it('shows the count, the newest observation age and both actions', async () => {
    const { apply } = start();
    apply();
    apply(makeEvent('b', T0 + MIN), makeEvent('c', T0 + 5 * MIN));
    const html = await renderCounter();
    expect(html).toContain('2 fires new or with new detections');
    expect(html).toContain('Latest detection: 15 min ago');
    expect(html).toContain('Show newest');
    expect(html).toContain('Mark all seen');
    expect(html.match(/class="button-secondary/g)).toHaveLength(2);

    const bgHtml = await renderCounter(bg);
    expect(bgHtml).toContain('2 пожара са нови или с нови засичания');
  });
});
