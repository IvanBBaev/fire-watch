/**
 * The event page with no event to show, rendered through the real page, the real store
 * and the real catalogs: "not found" is said only from a fresh snapshot that lacks the id.
 * Before the first snapshot the page is loading, and a failing or stale feed makes it
 * "could not load" — the browser half (no "not found" flash on a cold permalink open with
 * a slow snapshot) is the cold-load e2e (`web/e2e/cold-load.e2e.ts`).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LocationProvider, Route, Router } from 'preact-iso';
import prerender from 'preact-iso/prerender';

import { DEFAULT_CONFIG } from '../../core/config.js';
import bg from '../../core/i18n/bg.js';
import en from '../../core/i18n/en.js';
import type { Messages } from '../../core/i18n/messages.js';
import { createFireEventStore } from '../../core/store/index.js';
import type { FireEvent, FireEventStore, Locale, Snapshot } from '../../core/types.js';
import { AppContext } from '../context.js';
import type { AppServices } from '../context.js';
import { EventPage } from './event.js';

const NOW_MS = Date.parse('2026-08-09T12:00:00Z');
const EVENT_ID = 'fw-2026-q7f3d';
const ORIGIN = 'https://fire.example.test';

const EVENT: FireEvent = {
  id: EVENT_ID,
  seq: 4,
  status: 'active',
  scoreBucket: 'confirmed',
  mergedInto: null,
  lon: 23.3219,
  lat: 42.6977,
  firstObservedAt: '2026-08-09T09:30:00Z',
  lastObservedAt: '2026-08-09T11:45:00Z',
  detectionCount: 4,
  placeNameBg: 'София',
  placeNameEn: 'Sofia',
  areaHa: null,
  nextPassWindow: null,
};

function snapshot(events: readonly FireEvent[], generatedAt = '2026-08-09T11:59:00Z'): Snapshot {
  return {
    schemaVersion: 2,
    generatedAt,
    maxSeq: Math.max(0, ...events.map((event) => event.seq)),
    partial: false,
    events: [...events],
    sources: [],
  };
}

function services(store: FireEventStore, messages: Messages, locale: Locale): AppServices {
  return {
    store,
    clock: { epochNow: () => NOW_MS, monotonicNow: () => 0 },
    serverNow: () => NOW_MS,
    config: DEFAULT_CONFIG,
    geolocator: { locate: () => Promise.reject(new Error('not asked')) },
    locale,
    messages,
    setLocale: () => {},
  };
}

async function renderPage(
  store: FireEventStore,
  messages: Messages = en,
  locale: Locale = 'en',
): Promise<string> {
  const { html } = await prerender(
    <AppContext.Provider value={services(store, messages, locale)}>
      <LocationProvider>
        <Router>{[<Route key="event" path="/event/:id" component={EventPage} />]}</Router>
      </LocationProvider>
    </AppContext.Provider>,
  );
  return html.replace(/<script[\s\S]*?<\/script>/g, '');
}

const newStore = (): FireEventStore => createFireEventStore({ serverNow: () => NOW_MS });

describe('EventPage before and without its event', () => {
  beforeEach(() => {
    const location = { pathname: `/event/${EVENT_ID}`, search: '', hash: '', origin: ORIGIN };
    vi.stubGlobal('location', location);
    vi.stubGlobal('window', { location });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('is loading, not "not found", while a cold permalink open waits for its first snapshot', async () => {
    const html = await renderPage(newStore());

    expect(html).toContain('data-state="loading"');
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain(en.loading);
    expect(html).not.toContain(en.eventNotFound);
    expect(html).not.toContain(en.eventUnavailable);
    // The way out is there from the first frame.
    expect(html).toContain(en.backToMap);
  });

  it('shows the event once the snapshot that carries it is applied', async () => {
    const store = newStore();
    store.setFeedStatus('live');
    store.dispatch({ kind: 'snapshot', snapshot: snapshot([EVENT]) });

    const html = await renderPage(store);

    expect(html).toContain('data-state="found"');
    expect(html).toContain('<h1>');
    expect(html).not.toContain(en.loading);
  });

  it('says "not found" from a fresh, live snapshot that lacks the id', async () => {
    const store = newStore();
    store.setFeedStatus('live');
    store.dispatch({ kind: 'snapshot', snapshot: snapshot([]) });

    const html = await renderPage(store, bg, 'bg');

    expect(html).toContain('data-state="not-found"');
    expect(html).toContain(bg.eventNotFound);
    expect(html).not.toContain('aria-busy="true"');
  });

  it('could not load, never "not found", when the first snapshot failed', async () => {
    const store = newStore();
    store.setFeedStatus('degraded');

    const html = await renderPage(store);

    expect(html).toContain('data-state="unavailable"');
    expect(html).toContain(en.eventUnavailable);
    expect(html).not.toContain(en.eventNotFound);
  });

  it('could not load, never "not found", from a snapshot under the stale banner', async () => {
    const store = newStore();
    store.setFeedStatus('live');
    // An hour old: well past twice the snapshot-push warn budget, so the banner is up.
    store.dispatch({ kind: 'snapshot', snapshot: snapshot([], '2026-08-09T11:00:00Z') });

    const html = await renderPage(store, bg, 'bg');

    expect(html).toContain('data-state="unavailable"');
    expect(html).toContain(bg.eventUnavailable);
    expect(html).not.toContain(bg.eventNotFound);
  });
});
