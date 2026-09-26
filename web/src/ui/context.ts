/**
 * The one context the shell provides: composition-root singletons (store, clock,
 * config) plus the live locale/messages pair. Everything user-visible reads its copy
 * from `messages` — no component owns strings of its own (CI-11).
 */

import { createContext } from 'preact';
import { useContext } from 'preact/hooks';

import type { ClientConfig } from '../core/config.js';
import type { Messages } from '../core/i18n/messages.js';
import type { Clock, GeoLocator, ServerNow } from '../core/ports.js';
import type { FireEventStore, Locale } from '../core/types.js';

export interface AppServices {
  readonly store: FireEventStore;
  readonly clock: Clock;
  /** Server-corrected "now" (ADR-003 A1.6) — every staleness/age read goes through this. */
  readonly serverNow: ServerNow;
  readonly config: ClientConfig;
  /** Device location, asked for only when a control asks — never at boot, never sent. */
  readonly geolocator: GeoLocator;
  readonly locale: Locale;
  readonly messages: Messages;
  readonly setLocale: (locale: Locale) => void;
}

export const AppContext = createContext<AppServices | null>(null);

export function useApp(): AppServices {
  const services = useContext(AppContext);
  if (services === null) {
    throw new Error('useApp: no AppContext — components must render inside <App>');
  }
  return services;
}
