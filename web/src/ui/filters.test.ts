/**
 * The filter signals and their URL sync: the fragment outranks storage member by member,
 * applying it never writes storage, and the region polygons load lazily and retry on failure.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type * as AgeWindowModule from './age-window.js';
import type * as FiltersModule from './filters.js';
import { DEFAULT_SENSITIVITY, SENSITIVITY_PRESETS } from '../core/filter/sensitivity.js';
import { DEFAULT_AGE_WINDOW } from '../core/time/age-filter.js';

const ALL = DEFAULT_SENSITIVITY;

// `filters.ts` keeps a module-level load promise, so every test gets a fresh module.
let ageWindow: typeof AgeWindowModule.ageWindow;
let applyFilterHash: typeof FiltersModule.applyFilterHash;
let clearScopeFilters: typeof FiltersModule.clearScopeFilters;
let currentSelection: typeof FiltersModule.currentSelection;
let loadRegionIndex: typeof FiltersModule.loadRegionIndex;
let regionFilter: typeof FiltersModule.regionFilter;
let regionIndex: typeof FiltersModule.regionIndex;
let regionIndexState: typeof FiltersModule.regionIndexState;
let setRegionFilter: typeof FiltersModule.setRegionFilter;
let sensitivityFilter: typeof FiltersModule.sensitivityFilter;
let setSensitivity: typeof FiltersModule.setSensitivity;
let setSourceFamily: typeof FiltersModule.setSourceFamily;
let sourceFamily: typeof FiltersModule.sourceFamily;
let startFilterUrlSync: typeof FiltersModule.startFilterUrlSync;

const EMPTY_ASSET = { v: 1, scale: 1000, regions: [] };

function jsonResponse(body: unknown, ok = true): Response {
  return { ok, status: ok ? 200 : 503, json: () => Promise.resolve(body) } as Response;
}

beforeEach(async () => {
  vi.resetModules();
  ({ ageWindow } = await import('./age-window.js'));
  ({
    applyFilterHash,
    clearScopeFilters,
    currentSelection,
    loadRegionIndex,
    regionFilter,
    regionIndex,
    regionIndexState,
    sensitivityFilter,
    setRegionFilter,
    setSensitivity,
    setSourceFamily,
    sourceFamily,
    startFilterUrlSync,
  } = await import('./filters.js'));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('scope filters', () => {
  it('reads the four filters as one selection', () => {
    ageWindow.value = '6h';
    setSourceFamily('v');
    regionFilter.value = 22;
    setSensitivity(SENSITIVITY_PRESETS.balanced);
    expect(currentSelection()).toEqual({
      window: '6h',
      family: 'v',
      oblast: 22,
      sensitivity: SENSITIVITY_PRESETS.balanced,
    });
  });

  it('clearScopeFilters resets source, region and sensitivity but not the time window', () => {
    ageWindow.value = '6h';
    sourceFamily.value = 'm';
    regionFilter.value = 3;
    sensitivityFilter.value = SENSITIVITY_PRESETS.multi;
    clearScopeFilters();
    expect(currentSelection()).toEqual({
      window: '6h',
      family: null,
      oblast: null,
      sensitivity: ALL,
    });
  });
});

describe('loadRegionIndex', () => {
  it('goes loading → ready and builds the index', async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(jsonResponse(EMPTY_ASSET)));
    const pending = loadRegionIndex(fetchImpl);
    expect(regionIndexState.value).toBe('loading');
    await pending;
    expect(regionIndexState.value).toBe('ready');
    expect(regionIndex.value).not.toBeNull();
  });

  it('is idempotent once loaded', async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(jsonResponse(EMPTY_ASSET)));
    await loadRegionIndex(fetchImpl);
    await loadRegionIndex(fetchImpl);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('fails on a non-OK response and may be retried', async () => {
    const bad = vi.fn(() => Promise.resolve(jsonResponse({}, false)));
    await loadRegionIndex(bad);
    expect(regionIndexState.value).toBe('failed');
    expect(regionIndex.value).toBeNull();

    const good = vi.fn(() => Promise.resolve(jsonResponse(EMPTY_ASSET)));
    await loadRegionIndex(good);
    expect(regionIndexState.value).toBe('ready');
  });

  it('fails on a malformed asset', async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(jsonResponse({ v: 2 })));
    await loadRegionIndex(fetchImpl);
    expect(regionIndexState.value).toBe('failed');
  });

  it('fails on a network error', async () => {
    await loadRegionIndex(() => Promise.reject(new TypeError('offline')));
    expect(regionIndexState.value).toBe('failed');
  });
});

describe('applyFilterHash', () => {
  it('applies every member the fragment names', () => {
    vi.stubGlobal('fetch', () => Promise.resolve(jsonResponse(EMPTY_ASSET)));
    applyFilterHash('#map=8.0/42.6977/23.3219&t=6h&src=v&r=22');
    expect(ageWindow.value).toBe('6h');
    expect(sourceFamily.value).toBe('v');
    expect(regionFilter.value).toBe(22);
    applyFilterHash('#sens=multi');
    expect(sensitivityFilter.value).toStrictEqual(SENSITIVITY_PRESETS.multi);
  });

  it('leaves members the fragment does not mention as they are', () => {
    ageWindow.value = '12h';
    sourceFamily.value = 'm';
    applyFilterHash('#map=8.0/42.6977/23.3219');
    expect(currentSelection()).toEqual({
      window: '12h',
      family: 'm',
      oblast: null,
      sensitivity: ALL,
    });
  });

  it('ignores unparseable values', () => {
    applyFilterHash('#t=bogus&src=zz&r=99&sens=q.1.1');
    expect(currentSelection()).toEqual({
      window: DEFAULT_AGE_WINDOW,
      family: null,
      oblast: null,
      sensitivity: ALL,
    });
  });

  it('never writes storage', () => {
    const setItem = vi.fn();
    vi.stubGlobal('window', { localStorage: { getItem: () => null, setItem } });
    applyFilterHash('#t=1h');
    expect(setItem).not.toHaveBeenCalled();
  });

  it('starts loading the oblast polygons when a region arrives', () => {
    vi.stubGlobal('fetch', () => Promise.resolve(jsonResponse(EMPTY_ASSET)));
    setRegionFilter(5);
    expect(regionIndexState.value).toBe('loading');
  });
});

describe('startFilterUrlSync', () => {
  interface Env {
    location: { hash: string; pathname: string; search: string };
    listeners: Map<string, () => void>;
    replaceState: ReturnType<typeof vi.fn>;
  }

  function stubBrowser(hash: string): Env {
    const listeners = new Map<string, () => void>();
    const location = { hash, pathname: '/', search: '' };
    const replaceState = vi.fn((_state: unknown, _title: string, url: string) => {
      const at = url.indexOf('#');
      location.hash = at === -1 ? '' : url.slice(at);
    });
    vi.stubGlobal('location', location);
    vi.stubGlobal('history', { state: null, replaceState });
    vi.stubGlobal('window', {
      addEventListener: (name: string, fn: () => void) => void listeners.set(name, fn),
      removeEventListener: (name: string) => void listeners.delete(name),
    });
    return { location, listeners, replaceState };
  }

  it('applies the opening fragment and leaves an already-canonical URL alone', () => {
    const env = stubBrowser('#t=6h');
    const stop = startFilterUrlSync();
    expect(ageWindow.value).toBe('6h');
    expect(env.replaceState).not.toHaveBeenCalled();
    stop();
  });

  it('mirrors a filter change into the fragment without clobbering other members', () => {
    const env = stubBrowser('#map=8.0/42.6977/23.3219');
    const stop = startFilterUrlSync();
    setSourceFamily('v');
    expect(env.location.hash).toContain('map=8.0/42.6977/23.3219');
    expect(env.location.hash).toContain('src=v');
    stop();
  });

  it('drops the fragment when every filter returns to its default', () => {
    const env = stubBrowser('#src=v');
    const stop = startFilterUrlSync();
    expect(sourceFamily.value).toBe('v');
    clearScopeFilters();
    expect(env.location.hash).toBe('');
    expect(env.replaceState).toHaveBeenLastCalledWith(null, '', '/');
    stop();
  });

  it('picks up a hand-edited fragment on hashchange', () => {
    const env = stubBrowser('');
    const stop = startFilterUrlSync();
    env.location.hash = '#t=3h';
    env.listeners.get('hashchange')?.();
    expect(ageWindow.value).toBe('3h');
    stop();
  });

  it('stops listening and mirroring once stopped', () => {
    const env = stubBrowser('');
    const stop = startFilterUrlSync();
    stop();
    expect(env.listeners.has('hashchange')).toBe(false);
    env.replaceState.mockClear();
    setSourceFamily('m');
    expect(env.replaceState).not.toHaveBeenCalled();
  });
});
