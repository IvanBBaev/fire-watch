/**
 * The shell: LocationProvider + Router (preact-iso, review 08 §5.1.4), the single
 * degraded-state banner slot at the top (one slot, strict priority — ADR-003 D2), and
 * the nav. The routes themselves are not written out here: they are the table in
 * `logic/routes.ts`, rendered in its order, and each one is resolved to a page through
 * {@link PAGES} so that a route with no component is a compile error rather than a blank
 * panel. Unknown paths fall back to Home (fail open onto the map).
 *
 * The map is mounted here rather than by a route, and the router renders into the panel
 * beside it. That is what keeps one MapLibre instance — and the user's frame — alive from
 * the list to an event permalink and back: `/event/:id` selects a fire on the map that is
 * already on screen instead of replacing the map with a page about somewhere.
 */

import type { AnyComponent } from 'preact';
import { useCallback, useEffect, useMemo, useState } from 'preact/hooks';
import { LocationProvider, Route, Router, lazy, useLocation } from 'preact-iso';

import type { ClientConfig } from '../core/config.js';
import { loadMessages, persistLocale } from '../core/i18n/locale.js';
import type { Messages } from '../core/i18n/messages.js';
import type { Clock, GeoLocator, ServerNow } from '../core/ports.js';
import type { FireEventStore, Locale } from '../core/types.js';
import { BannerSlot } from './status/index.js';
import { isMapRoute, selectedEventIdFrom } from './logic/layout.js';
import type { RouteId } from './logic/routes.js';
import { ROUTES } from './logic/routes.js';
import { AboutPage } from './pages/about.js';
import { CreditsPage } from './pages/credits.js';
import { EventPage } from './pages/event.js';
import { HomePage } from './pages/home.js';
import { PrivacyPage } from './pages/privacy.js';
import { SettingsPage } from './pages/settings.js';

// Sign-in (TASKS I1) is a page few readers ever open, so it stays out of the entry chunk:
// both routes load one lazy chunk (CI-12 lazy role `page`).
const SignInPage = lazy(() => import('./pages/sign-in.js').then((m) => m.SignInPage));
const SignInContinuePage = lazy(() =>
  import('./pages/sign-in.js').then((m) => m.SignInContinuePage),
);
import type { AppServices } from './context.js';
import { AppContext } from './context.js';
import { MapPane } from './map-pane.js';
import { useNow } from './use-now.js';
import { useStoreState } from './use-store.js';

export interface AppProps {
  readonly store: FireEventStore;
  readonly clock: Clock;
  /** The feed's server-corrected clock (ADR-003 A1.6) — staleness math ticks on this. */
  readonly serverNow: ServerNow;
  readonly config: ClientConfig;
  /** Device location, on request only — the map controls are its only caller. */
  readonly geolocator: GeoLocator;
  readonly initialLocale: Locale;
  readonly initialMessages: Messages;
}

/**
 * What each route renders. Exhaustive over `RouteId` by its type, so a row added to the
 * route table does not compile until it has a page: the shell cannot serve a route it has
 * no component for, and cannot quietly drop one either.
 */
const PAGES: Record<RouteId, AnyComponent> = {
  home: HomePage,
  event: EventPage,
  settings: SettingsPage,
  about: AboutPage,
  credits: CreditsPage,
  privacy: PrivacyPage,
  signIn: SignInPage,
  signInContinue: SignInContinuePage,
};

function NavLink({ href, label }: { readonly href: string; readonly label: string }) {
  const { path } = useLocation();
  return (
    <a href={href} {...(path === href ? { 'aria-current': 'page' } : {})}>
      {label}
    </a>
  );
}

function Shell({ services }: { readonly services: AppServices }) {
  const { store, serverNow, messages, locale } = services;
  const state = useStoreState(store);
  const nowMs = useNow(serverNow);
  const { path } = useLocation();
  const withMap = isMapRoute(path);
  const selectedId = selectedEventIdFrom(path);
  const [panelOpen, setPanelOpen] = useState(false);

  // Narrow screens keep the panel as a peeking sheet so the map stays the main surface;
  // asking for one specific fire is asking to read about it, so that opens the sheet.
  useEffect(() => {
    if (selectedId !== null) setPanelOpen(true);
  }, [selectedId]);

  return (
    <div class="shell">
      <header class="shell-header">
        <a href="/" class="brand">
          {messages.appTitle}
        </a>
        <nav class="shell-nav">
          <NavLink href="/" label={messages.nav.map} />
          <NavLink href="/settings" label={messages.nav.settings} />
          <NavLink href="/about" label={messages.nav.about} />
          <NavLink href="/credits" label={messages.nav.credits} />
        </nav>
      </header>
      {/* The one degraded-state slot — two simultaneous banners is a regression. */}
      <BannerSlot state={state} serverNowMs={nowMs} messages={messages} locale={locale} />
      <main class={`shell-main${withMap ? ' with-map' : ''}`}>
        {withMap && (
          <div class="map-pane-wrap">
            <MapPane selectedId={selectedId} />
          </div>
        )}
        <section class={`side-panel${panelOpen ? ' open' : ''}`}>
          {withMap && (
            <button
              type="button"
              class="panel-toggle"
              aria-expanded={panelOpen}
              onClick={() => {
                setPanelOpen(!panelOpen);
              }}
            >
              {messages.nav.list}
            </button>
          )}
          <div class="side-panel-body">
            <Router>
              {/* Table order is match order: preact-iso takes the first route that matches. */}
              {ROUTES.map((route) => (
                <Route key={route.id} path={route.path} component={PAGES[route.id]} />
              ))}
              <Route default component={HomePage} />
            </Router>
          </div>
        </section>
      </main>
    </div>
  );
}

export function App({
  store,
  clock,
  serverNow,
  config,
  geolocator,
  initialLocale,
  initialMessages,
}: AppProps) {
  const [locale, setLocaleState] = useState<Locale>(initialLocale);
  const [messages, setMessages] = useState<Messages>(initialMessages);

  const setLocale = useCallback((next: Locale): void => {
    persistLocale(next);
    void loadMessages(next).then((loaded) => {
      setLocaleState(next);
      setMessages(loaded);
      document.documentElement.lang = next;
    });
  }, []);

  const services = useMemo<AppServices>(
    () => ({ store, clock, serverNow, config, geolocator, locale, messages, setLocale }),
    [store, clock, serverNow, config, geolocator, locale, messages, setLocale],
  );

  return (
    <AppContext.Provider value={services}>
      <LocationProvider>
        <Shell services={services} />
      </LocationProvider>
    </AppContext.Provider>
  );
}
