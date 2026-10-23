/**
 * The fragment survives in-app navigation: a pushed route arrives with no fragment, the
 * shell's repair puts back exactly what the reader was looking at, and a permalink written
 * before the filters existed still opens untouched.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_FILTERS, parseFilterHash } from '../core/filter/filter-hash.js';
import { DEFAULT_SENSITIVITY } from '../core/filter/sensitivity.js';
import { readFragmentMember } from '../core/url-fragment.js';
import { parseMapHash } from '../map/hash.js';
import { chosenOverlays } from './layers.js';
import { resetStaticSourcesForTest, staticSourcesChosen } from './static-sources.js';
import type { AppFragmentState, FragmentHistory, FragmentLocation } from './url-state.js';
import {
  appFragmentMembers,
  applyOverlayHash,
  parseOverlayHash,
  repairAppFragment,
  startOverlayUrlSync,
} from './url-state.js';

/** A same-document URL bar: `pushState` drops the fragment exactly as preact-iso does. */
function fakeBrowser(initial: string) {
  let url = new URL(initial, 'https://fire.test');
  const listeners = new Set<() => void>();
  const loc: FragmentLocation = {
    get pathname() {
      return url.pathname;
    },
    get search() {
      return url.search;
    },
    get hash() {
      return url.hash;
    },
  };
  const writes: string[] = [];
  const hist: FragmentHistory = {
    state: null,
    replaceState(_data, _unused, next) {
      if (next === undefined || next === null) return;
      writes.push(next);
      url = new URL(next, url);
    },
  };
  return {
    loc,
    hist,
    writes,
    href: () => url.pathname + url.search + url.hash,
    push: (href: string) => {
      url = new URL(href, url);
    },
    /** A hand-edited fragment: the URL changes and `hashchange` fires. */
    editHash: (hash: string) => {
      url = new URL(hash, url);
      for (const listener of listeners) listener();
    },
    events: {
      addEventListener: (_type: string, listener: () => void) => listeners.add(listener),
      removeEventListener: (_type: string, listener: () => void) => listeners.delete(listener),
    } as unknown as Pick<Window, 'addEventListener' | 'removeEventListener'>,
  };
}

const LOOKING_AT: AppFragmentState = {
  camera: { zoom: 8.04, lat: 42.69771, lon: 23.32194 },
  filters: { window: '6h', family: 'v', oblast: 22, sensitivity: DEFAULT_SENSITIVITY },
  overlays: ['ba', 'fwi'],
};

afterEach(() => {
  chosenOverlays.value = [];
  resetStaticSourcesForTest();
  vi.unstubAllGlobals();
});

describe('appFragmentMembers', () => {
  it('spells every owner, and nothing for defaults or an unmeasured map', () => {
    expect(appFragmentMembers(LOOKING_AT)).toEqual({
      map: '8.0/42.6977/23.3219',
      t: '6h',
      src: 'v',
      r: '22',
      sens: null,
      ov: 'fwi,ba',
    });
    expect(appFragmentMembers({ camera: null, filters: DEFAULT_FILTERS, overlays: [] })).toEqual({
      t: null,
      src: null,
      r: null,
      sens: null,
      ov: null,
    });
  });
});

describe('repairAppFragment', () => {
  it('round-trips list → /event/:id → list: every member survives both pushes', () => {
    const browser = fakeBrowser('/');
    repairAppFragment(browser.loc, browser.hist, LOOKING_AT);
    const before = browser.loc.hash;

    browser.push('/event/fw-2026-x4k6m'); // a list row's href: no fragment
    expect(browser.loc.hash).toBe('');
    repairAppFragment(browser.loc, browser.hist, LOOKING_AT);
    expect(browser.href()).toBe(`/event/fw-2026-x4k6m${before}`);

    browser.push('/');
    repairAppFragment(browser.loc, browser.hist, LOOKING_AT);
    expect(browser.loc.hash).toBe(before);

    // What the repair wrote is what the parsers read back.
    expect(parseMapHash(before)).toEqual({ zoom: 8, lat: 42.6977, lon: 23.3219 });
    expect(parseFilterHash(before)).toEqual({ window: '6h', family: 'v', oblast: 22 });
    expect(parseOverlayHash(before)).toEqual(['fwi', 'ba']);
  });

  it('leaves an old #map= permalink exactly as it was', () => {
    const browser = fakeBrowser('/event/fw-2026-x4k6m#map=7.2/42.7000/25.3000');
    repairAppFragment(browser.loc, browser.hist, {
      camera: { zoom: 3, lat: 1, lon: 1 },
      filters: DEFAULT_FILTERS,
      overlays: [],
    });
    expect(browser.writes).toEqual([]);
    expect(browser.loc.hash).toBe('#map=7.2/42.7000/25.3000');
  });

  it('never overwrites what a Back step returned to, and keeps foreign members', () => {
    const browser = fakeBrowser('/#t=1h&future=yes');
    repairAppFragment(browser.loc, browser.hist, LOOKING_AT);
    expect(readFragmentMember(browser.loc.hash, 't')).toBe('1h');
    expect(readFragmentMember(browser.loc.hash, 'future')).toBe('yes');
    expect(readFragmentMember(browser.loc.hash, 'src')).toBe('v');
  });

  it('writes nothing when there is nothing to put back', () => {
    const browser = fakeBrowser('/about?x=1');
    repairAppFragment(browser.loc, browser.hist, {
      camera: null,
      filters: DEFAULT_FILTERS,
      overlays: [],
    });
    expect(browser.writes).toEqual([]);
  });
});

describe('overlays in the fragment', () => {
  it('a link outranks the remembered choice; no member changes nothing', () => {
    chosenOverlays.value = ['ba'];
    applyOverlayHash('#map=7/42/25');
    expect(chosenOverlays.value).toEqual(['ba']);
    applyOverlayHash('#map=7/42/25&ov=fwi,gibs');
    expect(chosenOverlays.value).toEqual(['fwi']);
    applyOverlayHash('#ov=');
    expect(chosenOverlays.value).toEqual([]);
  });

  it('mirrors the choice into the fragment and picks up a hand-edited one', () => {
    const browser = fakeBrowser('/#map=7.0/42.0000/25.0000&ov=ba');
    const stop = startOverlayUrlSync(browser.loc, browser.hist, browser.events);
    expect(chosenOverlays.value).toEqual(['ba']);
    expect(browser.writes).toEqual([]); // applying the link rewrote nothing

    chosenOverlays.value = ['fwi', 'ba'];
    expect(browser.loc.hash).toBe('#map=7.0/42.0000/25.0000&ov=fwi,ba');
    chosenOverlays.value = [];
    expect(browser.loc.hash).toBe('#map=7.0/42.0000/25.0000');

    browser.editHash('#map=7.0/42.0000/25.0000&ov=fwi');
    expect(chosenOverlays.value).toEqual(['fwi']);

    stop();
    chosenOverlays.value = [];
    expect(browser.loc.hash).toBe('#map=7.0/42.0000/25.0000&ov=fwi');
  });

  it('carries the static hot-source mask as the `static` token (F16), storage untouched', () => {
    const setItem = vi.fn();
    vi.stubGlobal('localStorage', { getItem: () => null, setItem, removeItem: setItem });
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise<Response>(() => undefined)),
    );
    expect(appFragmentMembers({ ...LOOKING_AT, staticSources: true })['ov']).toBe('fwi,ba,static');
    expect(appFragmentMembers(LOOKING_AT)['ov']).toBe('fwi,ba');

    const browser = fakeBrowser('/#map=7.0/42.0000/25.0000&ov=fwi,static');
    const stop = startOverlayUrlSync(browser.loc, browser.hist, browser.events);
    expect(chosenOverlays.value).toEqual(['fwi']);
    expect(staticSourcesChosen.value).toBe(true);
    expect(browser.writes).toEqual([]);
    expect(setItem).not.toHaveBeenCalled();

    browser.editHash('#map=7.0/42.0000/25.0000&ov=fwi');
    expect(staticSourcesChosen.value).toBe(false);
    staticSourcesChosen.value = true;
    expect(browser.loc.hash).toBe('#map=7.0/42.0000/25.0000&ov=fwi,static');
    stop();
    expect(setItem).not.toHaveBeenCalled();
  });
});
