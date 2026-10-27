/**
 * Cross-device sync, wired to this browser (TASKS V2-C5): the glue between the sync loop
 * in `core/preferences/sync.ts` and the storage keys and signals each preference already
 * lives in.
 *
 * **Lazy and signed-in only.** Boot imports this chunk after first paint, and only when
 * `fw:account-hint` says this browser had a live session before; the sign-in page imports
 * it once a sign-in succeeds. A signed-out reader never downloads it and never sends a
 * request for it — signed-out behaviour is exactly what it was: localStorage only.
 *
 * **Never in the way.** Nothing waits for sync: the map and the list render from storage
 * as always, and a remote value lands a moment later through the same signals a click
 * would move. Every failure is silent.
 *
 * **Storage is the local copy.** Values are read from storage, not from the signals,
 * because a signal may hold what an opened link says (`#ov=…`, `#t=…`), which is someone
 * else's view and not this reader's choice. For the same reason a field the opening link
 * stated is applied to storage only, so the link keeps the view it was shared for.
 *
 * **Language** is remembered for the next load only: the live catalog swap belongs to
 * `App` and is not reachable from here.
 *
 * **Few entry imports (CI-12).** Every binding this lazy chunk imports from the entry graph
 * is an export the entry has to carry. So it imports the signals, plus the setters that do
 * more than write storage (loading a layer, setting the document theme), and keeps its own
 * copies of the rest. `preferences-sync.test.ts` pins the storage keys to the modules that
 * own them.
 */

import type { AccountPreferenceField, AccountPreferences } from '@fire-watch/contracts';
import { ACCOUNT_PREFERENCES_SCHEMA } from '@fire-watch/contracts';
import { effect } from '@preact/signals';

import { createPreferencesClient, remoteFromBody } from '../core/preferences/client.js';
import type { PreferencesSync, SyncBase } from '../core/preferences/sync.js';
import { createPreferencesSync } from '../core/preferences/sync.js';
import { parseAgeWindow } from '../core/time/age-filter.js';
import { readFragmentMember } from '../core/url-fragment.js';
import { ageWindow } from './age-window.js';
import { authSession } from './auth.js';
import type { OverlayId } from './layers.js';
import { chosenOverlays, OVERLAY_IDS } from './layers.js';
import { newSignalSound } from './new-signals.js';
import { protectedSitesChosen, setProtectedSitesChosen } from './protected-sites.js';
import { setStaticSourcesChosen, staticSourcesChosen } from './static-sources.js';
import { setThemePreference, themePreference } from './theme.js';

/** Set to `'1'` once the account's preferences answered; boot reads it to start sync. */
export const ACCOUNT_HINT_STORAGE_KEY = 'fw:account-hint';
/** The copy this browser last agreed with the server on (`SyncBase` as JSON). */
export const SYNC_BASE_STORAGE_KEY = 'fw:preferences-sync';

/** Where each synced preference is remembered; the owning modules use the same keys. */
export const PREFERENCE_STORAGE_KEYS = {
  overlays: 'fw:layers',
  static_sources: 'fw:static-sources',
  protected_sites: 'fw:protected-sites',
  theme: 'fw:theme',
  locale: 'fw:locale',
  age_window: 'fw.age-window',
  new_signal_sound: 'fw:new-signals-sound',
} as const satisfies Record<AccountPreferenceField, string>;

const KEYS = PREFERENCE_STORAGE_KEYS;
const OVERLAY_HASH_KEY = 'ov';
const WINDOW_HASH_KEY = 't';

function readStorage(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStorage(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // The choice will not survive the session: acceptable, as everywhere else.
  }
}

function removeStorage(key: string): void {
  try {
    window.localStorage.removeItem(key);
  } catch {
    // Nothing to forget, or storage is off: either way nothing stays behind.
  }
}

/** The overlays this build knows, in its canonical order; `null` for no stored value. */
function parseOverlays(raw: string | null): OverlayId[] | null {
  if (raw === null) return null;
  const tokens = new Set(raw.split(',').map((token) => token.trim()));
  return OVERLAY_IDS.filter((id) => tokens.has(id));
}

function onOff(raw: string | null): boolean | undefined {
  return raw === 'on' ? true : raw === 'off' ? false : undefined;
}

/** This browser's remembered preferences, from storage; never-chosen fields absent. */
export function readLocalPreferences(read: (key: string) => string | null): AccountPreferences {
  const local: Record<string, unknown> = {};
  const overlays = parseOverlays(read(KEYS.overlays));
  if (overlays !== null) local['overlays'] = overlays;
  const staticSources = onOff(read(KEYS.static_sources));
  if (staticSources !== undefined) local['static_sources'] = staticSources;
  const protectedSites = onOff(read(KEYS.protected_sites));
  if (protectedSites !== undefined) local['protected_sites'] = protectedSites;
  const theme = read(KEYS.theme);
  if (theme === 'auto' || theme === 'light' || theme === 'dark') local['theme'] = theme;
  const locale = read(KEYS.locale);
  if (locale === 'bg' || locale === 'en') local['locale'] = locale;
  const window = parseAgeWindow(read(KEYS.age_window));
  if (window !== null) local['age_window'] = window;
  const sound = onOff(read(KEYS.new_signal_sound));
  if (sound !== undefined) local['new_signal_sound'] = sound;
  return local;
}

/** The fields the page's opening link stated, which keep the link's view on screen. */
export function linkStatedFields(openingHash: string): ReadonlySet<AccountPreferenceField> {
  const stated = new Set<AccountPreferenceField>();
  if (readFragmentMember(openingHash, OVERLAY_HASH_KEY) !== null) {
    stated.add('overlays').add('static_sources').add('protected_sites');
  }
  if (parseAgeWindow(readFragmentMember(openingHash, WINDOW_HASH_KEY)) !== null) {
    stated.add('age_window');
  }
  return stated;
}

/** A stored base, or `null` when absent or not one this build wrote. */
export function parseSyncBase(raw: string | null): SyncBase | null {
  if (raw === null) return null;
  try {
    const stored = JSON.parse(raw) as { revision?: unknown; preferences?: unknown };
    return remoteFromBody({
      revision: stored.revision,
      document: { schema: ACCOUNT_PREFERENCES_SCHEMA, preferences: stored.preferences },
    });
  } catch {
    return null;
  }
}

function applyField(
  field: AccountPreferenceField,
  next: AccountPreferences,
  linkStated: boolean,
): void {
  switch (field) {
    case 'overlays': {
      const ids = parseOverlays((next.overlays ?? []).join(',')) ?? [];
      writeStorage(KEYS.overlays, ids.join(','));
      if (!linkStated) chosenOverlays.value = ids;
      return;
    }
    case 'static_sources': {
      const on = next.static_sources === true;
      if (linkStated) writeStorage(KEYS.static_sources, on ? 'on' : 'off');
      else setStaticSourcesChosen(on);
      return;
    }
    case 'protected_sites': {
      const on = next.protected_sites === true;
      if (linkStated) writeStorage(KEYS.protected_sites, on ? 'on' : 'off');
      else setProtectedSitesChosen(on);
      return;
    }
    case 'theme':
      if (next.theme !== undefined) setThemePreference(next.theme);
      return;
    case 'locale':
      if (next.locale !== undefined) writeStorage(KEYS.locale, next.locale);
      return;
    case 'age_window': {
      const window = parseAgeWindow(next.age_window ?? null);
      if (window === null) return;
      writeStorage(KEYS.age_window, window);
      if (!linkStated) ageWindow.value = window;
      return;
    }
    case 'new_signal_sound': {
      // Not `setNewSignalSound`: that unlocks audio, which needs the reader's own gesture.
      const on = next.new_signal_sound === true;
      writeStorage(KEYS.new_signal_sound, on ? 'on' : 'off');
      newSignalSound.value = on;
      return;
    }
  }
}

let running: { readonly sync: PreferencesSync; readonly dispose: () => void } | null = null;

/** Stop syncing and forget the agreed copy and the hint (signed out, or no route here). */
function endSync(): void {
  running?.dispose();
  running = null;
  removeStorage(SYNC_BASE_STORAGE_KEY);
  removeStorage(ACCOUNT_HINT_STORAGE_KEY);
}

/**
 * Start syncing this browser's preferences with the account. Idempotent: a second call
 * while running does nothing. `openingHash` is the fragment the page was opened with.
 */
export function startPreferencesSync(openingHash: string): void {
  if (running !== null) return;
  const linkStated = linkStatedFields(openingHash);
  let applying = false;

  const sync = createPreferencesSync({
    client: createPreferencesClient({ fetchFn: (input, init) => fetch(input, init) }),
    readLocal: () => readLocalPreferences(readStorage),
    applyLocal: (next, changed) => {
      applying = true;
      try {
        for (const field of changed) applyField(field, next, linkStated.has(field));
      } finally {
        applying = false;
      }
    },
    loadBase: () => parseSyncBase(readStorage(SYNC_BASE_STORAGE_KEY)),
    saveBase: (base) => {
      if (base === null) removeStorage(SYNC_BASE_STORAGE_KEY);
      else writeStorage(SYNC_BASE_STORAGE_KEY, JSON.stringify(base));
    },
    schedule: (run, ms) => {
      const handle = setTimeout(run, ms);
      return () => {
        clearTimeout(handle);
      };
    },
    onEnd: endSync,
    onConnected: () => {
      writeStorage(ACCOUNT_HINT_STORAGE_KEY, '1');
    },
  });

  const changed = (): void => {
    if (!applying) sync.localChanged();
  };
  let first = true;
  const stopWatching = effect(() => {
    // Subscribe to every synced choice; the first run only subscribes.
    void chosenOverlays.value;
    void staticSourcesChosen.value;
    void protectedSitesChosen.value;
    void themePreference.value;
    void ageWindow.value;
    void newSignalSound.value;
    if (first) first = false;
    else changed();
  });
  // `App.setLocale` sets `<html lang>` once the new catalog is in.
  const languageObserver = new MutationObserver(changed);
  languageObserver.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['lang'],
  });
  const stopAuthWatch = effect(() => {
    if (authSession.value === 'signed-out') endSync();
  });

  running = {
    sync,
    dispose: () => {
      sync.stop();
      stopWatching();
      stopAuthWatch();
      languageObserver.disconnect();
    },
  };
  void sync.start();
}
