/**
 * Composition root (review 08 §5.2.1): the only module that constructs adapters and
 * wires store ↔ feeds ↔ supervisor ↔ UI. Everything downstream receives its dependencies —
 * nothing below this file touches the real clock, randomness, `fetch`, `EventSource` or
 * the document's lifecycle events.
 */

import './styles.css';

import { h, render } from 'preact';

import { createBrowserGeolocator } from './adapters/browser-geolocation.js';
import { createEventSourceStreamSource } from './adapters/event-source.js';
import { createBrowserPageLifecycle } from './adapters/page-lifecycle.js';
import { createMulberry32, entropySeed } from './adapters/seeded-rng.js';
import { createSystemClock } from './adapters/system-clock.js';
import { createAuthClient, takeSignInToken } from './core/auth/sign-in.js';
import { DEFAULT_CONFIG } from './core/config.js';
import {
  createFeedCoordinator,
  createPollingFeed,
  createServerTimeTracker,
  createSseFeed,
  createTransportSupervisor,
  fetchClientConfig,
} from './core/feed/index.js';
import { detectLocale, loadMessages } from './core/i18n/locale.js';
import { createImageryRefresh } from './core/imagery/index.js';
import { createFireEventStore } from './core/store/index.js';
import { App } from './ui/app.js';
import { holdSignInToken, setAuthClient } from './ui/auth.js';
import { setImageryHandles } from './ui/imagery.js';
import { initTheme } from './ui/theme.js';

async function boot(): Promise<void> {
  // First, before any await, request or render (TASKS I1): a sign-in link's token leaves
  // the URL here, synchronously, so no later request, Referer, history entry or
  // third-party script can see it. The page reads it once, from the holder.
  holdSignInToken(takeSignInToken(window.location, window.history));
  setAuthClient(createAuthClient({ fetchFn: (input, init) => fetch(input, init) }));

  const clock = createSystemClock();
  const rng = createMulberry32(entropySeed());
  // One server-time tracker for the whole app (A1.6): the poller feeds it, the store's
  // tombstone ageing, the supervisor's staleness test and the UI's age copy all read it.
  const serverTime = createServerTimeTracker(clock);

  initTheme();
  const locale = detectLocale();
  document.documentElement.lang = locale;

  // Fleet control (ADR-003 D1): a tiny cached document that may switch the stream on or
  // stretch the poll interval; unreachable ⇒ the build-time defaults (A1.2).
  const [config, messages] = await Promise.all([
    fetchClientConfig((input, init) => fetch(input, init), DEFAULT_CONFIG),
    loadMessages(locale),
  ]);

  const store = createFireEventStore({ serverNow: serverTime.serverNow });
  const polling = createPollingFeed({ config, clock, rng, serverTime });
  const stream = createSseFeed({ config, clock, streamSource: createEventSourceStreamSource() });
  const supervisor = createTransportSupervisor({
    clock,
    serverNow: serverTime.serverNow,
    config: {
      pollIntervalMs: config.pollIntervalMs,
      staticFlipStaleMs: config.staticFlipStaleMs,
      hysteresisMs: config.sseReofferHysteresisMs,
      sseEnabled: config.sseEnabled,
    },
  });
  const coordinator = createFeedCoordinator({
    store,
    polling,
    stream,
    supervisor,
    lifecycle: createBrowserPageLifecycle(),
  });
  coordinator.start();

  // Imagery handles (ADR-001 A2.3): the same document, re-read on every wake and reconnect
  // so a quota trip reaches open tabs. Its first read lands on the HTTP cache warmed above.
  createImageryRefresh({
    fetchFn: (input, init) => fetch(input, init),
    url: config.clientConfigUrl,
    lifecycle: createBrowserPageLifecycle(),
    onChange: setImageryHandles,
  }).start();

  const container = document.getElementById('app');
  if (container === null) {
    throw new Error('boot: #app container not found');
  }
  render(
    h(App, {
      store,
      clock,
      // The server-corrected clock (A1.6): staleness/age copy never trusts the device
      // clock alone.
      serverNow: serverTime.serverNow,
      config,
      // Constructed eagerly, called lazily: nothing here prompts until a control does.
      geolocator: createBrowserGeolocator(),
      initialLocale: locale,
      initialMessages: messages,
    }),
    container,
  );

  // After first paint: warm the lazy map chunk so Home's dynamic import resolves from
  // cache. Fire-and-forget — a failure here costs nothing, MapPane retries on mount.
  const prefetchMapChunk = (): void => {
    void import('./map/index.js').catch(() => {
      // Offline or blocked — the list-first shell stays fully usable.
    });
  };
  requestAnimationFrame(() => {
    setTimeout(prefetchMapChunk, 0);
  });
}

void boot();
