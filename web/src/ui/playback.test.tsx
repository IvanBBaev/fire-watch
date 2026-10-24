/**
 * V2-A1, the shell half: loading a window (committed fixtures, the server route's shape),
 * the scrubber's state machine, the `pb=` member in the fragment, and the panel as a
 * reader and a screen reader meet it. Live mode is the default everywhere and comes back
 * whole: the replay never touches the store or the SSE reconciler, only these signals.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import prerender from 'preact-iso/prerender';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import { DEFAULT_CONFIG, LIVE_HISTORY_URL_TEMPLATE } from '../core/config.js';
import { PLAYBACK_AGE_CLASSES, parseHistoryBody } from '../core/history-body.js';
import bg from '../core/i18n/bg.js';
import en from '../core/i18n/en.js';
import { DEFAULT_SENSITIVITY } from '../core/filter/sensitivity.js';
import type { Messages } from '../core/i18n/messages.js';
import {
  HISTORY_RANGES,
  HISTORY_RANGE_MINUTES,
  cursorInstantMs,
  type HistoryRange,
} from '../core/playback.js';
import type { FireEventStore } from '../core/types.js';
import { AppContext, type AppServices } from './context.js';
import { layersPanelOpen, resetOverlaysForTest, setLayersPanelOpen } from './layers.js';
import { PLAYBACK_PANEL_ID, PlaybackPanel, setPlaybackPanelOpen } from './playback-panel.js';
import {
  playbackActive,
  playbackBody,
  playbackCursor,
  playbackLink,
  playbackPanelOpen,
  playbackParam,
  playbackPlaying,
  playbackRange,
  playbackStatus,
  resetPlaybackForTest,
  startPlayback,
  stopPlayback,
} from './playback.js';
import {
  loadPlayback,
  loadReplayModule,
  startPlaybackSync,
  type PlaybackLoaderDeps,
} from './playback-loader.js';
import {
  firmsCreditText,
  setPlaybackCursor,
  stepPlayback,
  tickPlayback,
  togglePlaying,
} from './playback-replay.js';
import {
  appFragmentMembers,
  repairAppFragment,
  startPlaybackUrlSync,
  type FragmentHistory,
  type FragmentLocation,
} from './url-state.js';

function fixtureText(range: HistoryRange): string {
  return readFileSync(
    fileURLToPath(new URL(`../../public/fixtures/history/${range}.json`, import.meta.url)),
    'utf8',
  );
}

const NOW = Date.parse('2026-08-09T10:00:00.000Z');
const clock = { epochNow: () => NOW, monotonicNow: () => 0 };

function deps(
  answer: (url: string) => Promise<Response> | Response,
  requested: string[] = [],
): PlaybackLoaderDeps {
  return {
    fetch: (url) => {
      requested.push(url);
      return Promise.resolve(answer(url));
    },
    urlTemplate: '/fixtures/history/{range}.json',
  };
}

const fixtureDeps = (requested: string[] = []) =>
  deps((url) => {
    const range = /history\/(\w+)\.json/.exec(url)?.[1] as HistoryRange;
    return new Response(fixtureText(range), { status: 200 });
  }, requested);

/** Let the loader's fetch and `json()` settle. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

// The loader imports the scrubber's lazy chunk on the first replay; load it once up front
// so one macrotask is enough for every test's fetch to land.
beforeAll(async () => {
  await loadReplayModule();
});

function services(messages: Messages): AppServices {
  return {
    store: {} as FireEventStore,
    clock,
    serverNow: () => NOW,
    config: DEFAULT_CONFIG,
    geolocator: { locate: () => Promise.reject(new Error('not asked')) },
    locale: messages === bg ? 'bg' : 'en',
    messages,
    setLocale: () => {},
  };
}

async function renderPanel(messages: Messages = en): Promise<string> {
  const { html } = await prerender(
    <AppContext.Provider value={services(messages)}>
      <PlaybackPanel />
    </AppContext.Provider>,
  );
  return html.replace(/<script[\s\S]*?<\/script>/g, '');
}

/** A same-document URL bar, as in `url-state.test.ts`. */
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
    push: (href: string) => {
      url = new URL(href, url);
    },
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

/** Every sync a test starts is stopped after it, even when an assertion threw first. */
const disposers: (() => void)[] = [];
function sync(loaderDeps: PlaybackLoaderDeps): () => void {
  const stop = startPlaybackSync(loaderDeps);
  disposers.push(stop);
  return stop;
}
function urlSync(...args: Parameters<typeof startPlaybackUrlSync>): () => void {
  const stop = startPlaybackUrlSync(...args);
  disposers.push(stop);
  return stop;
}

afterEach(() => {
  for (const stop of disposers.splice(0)) stop();
  resetPlaybackForTest();
  resetOverlaysForTest();
});

describe('the committed fixtures', () => {
  it.each(HISTORY_RANGES)('%s parses as the server route answers it', (range) => {
    const body = parseHistoryBody(JSON.parse(fixtureText(range)));
    expect(body?.range).toBe(range);
    expect(body?.count).toBeGreaterThan(0);
    expect(body?.attribution.map((entry) => entry.id)).toEqual(['firms-acknowledgement']);
  });

  it('points live mode at the API route', () => {
    expect(DEFAULT_CONFIG.historyUrlTemplate).toBe('/fixtures/history/{range}.json');
    expect(LIVE_HISTORY_URL_TEMPLATE).toBe('/api/v1/history?range={range}');
  });
});

describe('loading a window', () => {
  it('is live by default and draws nothing', () => {
    expect(playbackRange.value).toBeNull();
    expect(playbackActive.value).toBe(false);
    expect(playbackLink.value).toBeNull();
  });

  it('fetches the chosen window once and opens it at the window’s end', async () => {
    const requested: string[] = [];
    const stop = sync(fixtureDeps(requested));
    startPlayback('24h');
    expect(playbackStatus.value.kind).toBe('loading');
    expect(playbackActive.value).toBe(false); // the map stays live while it loads
    await settle();
    expect(requested).toEqual(['/fixtures/history/24h.json']);
    expect(playbackStatus.value.kind).toBe('ready');
    expect(playbackActive.value).toBe(true);
    expect(playbackCursor.value).toBe(HISTORY_RANGE_MINUTES['24h']);
    stop();
  });

  it('ends in `unavailable` on a failure, leaves the map live, and retries on a re-pick', async () => {
    let fail = true;
    const requested: string[] = [];
    const stop = sync(
      deps(() => {
        if (fail) return new Response('nope', { status: 503 });
        return new Response(fixtureText('3d'), { status: 200 });
      }, requested),
    );
    startPlayback('3d');
    await settle();
    expect(playbackStatus.value.kind).toBe('unavailable');
    expect(playbackActive.value).toBe(false);

    fail = false;
    startPlayback('3d');
    await settle();
    expect(requested).toHaveLength(2);
    expect(playbackStatus.value.kind).toBe('ready');
    stop();
  });

  it('refuses a body for another window, and drops an answer nobody waits for', async () => {
    await (async () => {
      playbackRange.value = '7d';
      await loadPlayback(
        '7d',
        deps(() => new Response(fixtureText('3d'), { status: 200 })),
      );
      expect(playbackStatus.value.kind).toBe('unavailable');
    })();

    stopPlayback();
    playbackRange.value = '24h';
    const pending = loadPlayback(
      '24h',
      deps(() => new Response(fixtureText('24h'), { status: 200 })),
    );
    stopPlayback();
    await pending;
    expect(playbackStatus.value.kind).toBe('idle');
    expect(playbackActive.value).toBe(false);
  });

  it('opens a pinned link at its instant', async () => {
    const body = parseHistoryBody(JSON.parse(fixtureText('3d')));
    if (body === null) throw new Error('fixture');
    const at = cursorInstantMs(body, 1200);
    const stop = sync(fixtureDeps());
    startPlayback('3d', at);
    expect(playbackLink.value).toEqual({ range: '3d', atMs: at }); // held while loading
    await settle();
    expect(playbackCursor.value).toBe(1200);
    expect(playbackLink.value).toEqual({ range: '3d', atMs: at });
    stop();
  });
});

describe('the scrubber', () => {
  async function ready(range: HistoryRange): Promise<() => void> {
    const stop = sync(fixtureDeps());
    startPlayback(range);
    await settle();
    return stop;
  }

  it('steps, clamps and pauses', async () => {
    const stop = await ready('24h');
    playbackPlaying.value = true;
    stepPlayback(-1);
    expect(playbackPlaying.value).toBe(false);
    expect(playbackCursor.value).toBe(1425);
    setPlaybackCursor(-40);
    expect(playbackCursor.value).toBe(0);
    setPlaybackCursor(99_999);
    expect(playbackCursor.value).toBe(1440);
    stop();
  });

  it('plays from the start when at the end, and pauses at the end', async () => {
    const stop = await ready('24h');
    togglePlaying();
    expect(playbackPlaying.value).toBe(true);
    expect(playbackCursor.value).toBe(0);
    expect(playbackParam.value).toBe('24h'); // a playing scrubber does not churn the URL
    for (let tick = 0; tick < 200 && playbackPlaying.value; tick += 1) tickPlayback();
    expect(playbackCursor.value).toBe(1440);
    expect(playbackPlaying.value).toBe(false);
    stop();
  });

  it('links a paused cursor by its instant, and the end as the bare window', async () => {
    const stop = await ready('7d');
    expect(playbackParam.value).toBe('7d');
    setPlaybackCursor(600);
    const body = playbackBody.value;
    if (body === null) throw new Error('not ready');
    expect(playbackLink.value).toEqual({ range: '7d', atMs: cursorInstantMs(body, 600) });
    expect(playbackParam.value).toMatch(/^7d@\d{12}$/);
    stop();
  });

  it('goes back to live whole', async () => {
    const stop = await ready('3d');
    stopPlayback();
    expect(playbackRange.value).toBeNull();
    expect(playbackActive.value).toBe(false);
    expect(playbackParam.value).toBeNull();
    stop();
  });
});

describe('the `pb=` member', () => {
  it('leaves a live link untouched — old permalinks keep their spelling', () => {
    const browser = fakeBrowser('/#map=7.0/42.0000/25.0000&t=6h');
    const stop = urlSync(browser.loc, browser.hist, browser.events);
    expect(browser.writes).toEqual([]);
    expect(playbackRange.value).toBeNull();
    expect(playbackPanelOpen.value).toBe(false);
    stop();
  });

  it('opens a replay link with the scrubber, and follows the choice into the URL', async () => {
    const browser = fakeBrowser('/#map=7.0/42.0000/25.0000&pb=3d@202608080000');
    const stopLoad = sync(fixtureDeps());
    const stop = urlSync(browser.loc, browser.hist, browser.events);
    expect(playbackRange.value).toBe('3d');
    expect(playbackPanelOpen.value).toBe(true);
    await settle();
    expect(browser.loc.hash).toBe('#map=7.0/42.0000/25.0000&pb=3d@202608080000');

    startPlayback('24h');
    await settle();
    expect(browser.loc.hash).toBe('#map=7.0/42.0000/25.0000&pb=24h');
    stopPlayback();
    expect(browser.loc.hash).toBe('#map=7.0/42.0000/25.0000');
    stop();
    stopLoad();
  });

  it('a Back step to a fragment without `pb=` is live again; a malformed one is ignored', async () => {
    const browser = fakeBrowser('/#pb=24h');
    const stopLoad = sync(fixtureDeps());
    const stop = urlSync(browser.loc, browser.hist, browser.events);
    await settle();
    browser.editHash('#pb=30d');
    expect(playbackRange.value).toBe('24h');
    browser.editHash('#map=7.0/42.0000/25.0000');
    expect(playbackRange.value).toBeNull();
    stop();
    stopLoad();
  });

  it('survives an in-app navigation through the shell’s repair', async () => {
    const stopLoad = sync(fixtureDeps());
    startPlayback('7d');
    await settle();
    const state = {
      camera: null,
      filters: { window: null, family: null, oblast: null, sensitivity: DEFAULT_SENSITIVITY },
      overlays: [],
      playback: playbackParam.value,
    } as unknown as Parameters<typeof appFragmentMembers>[0];
    expect(appFragmentMembers(state)['pb']).toBe('7d');
    const browser = fakeBrowser('/');
    browser.push('/event/fw-2026-x4k6m');
    repairAppFragment(browser.loc, browser.hist, state);
    expect(browser.loc.hash).toContain('pb=7d');
    stopLoad();
  });
});

describe('the panel', () => {
  it('is in the DOM but hidden until opened, and opening it closes the Layers panel', async () => {
    const closed = await renderPanel();
    expect(closed).toContain(`id="${PLAYBACK_PANEL_ID}"`);
    expect(closed).toMatch(/<section[^>]*hidden/);

    setLayersPanelOpen(true);
    setPlaybackPanelOpen(true);
    expect(layersPanelOpen.value).toBe(false);
    expect(await renderPanel()).not.toMatch(/<section[^>]*hidden/);
  });

  it('says what the dots are before anything else is chosen', async () => {
    setPlaybackPanelOpen(true);
    const html = await renderPanel();
    expect(html).toContain('not a confirmed fire');
    expect(html).toContain('does not predict');
    expect(html).not.toContain('type="range"');
    expect(html).not.toContain(en.playback.backToLive);
  });

  it.each([
    ['en', en],
    ['bg', bg],
  ] as const)(
    'in %s, a ready window has the slider, its controls, the legend and the credit',
    async (_locale, messages) => {
      const stop = sync(fixtureDeps());
      setPlaybackPanelOpen(true);
      startPlayback('24h');
      await settle();
      const html = await renderPanel(messages);
      expect(html).toContain('type="range"');
      expect(html).toContain(`aria-label="${messages.playback.scrubberLabel}"`);
      expect(html).toMatch(/aria-valuetext="[^"]+"/);
      expect(html).toContain('aria-pressed="false"');
      expect(html).toContain(messages.playback.play);
      expect(html).toContain(messages.playback.stepBack);
      expect(html).toContain(messages.playback.stepForward);
      expect(html).toContain(messages.playback.speed(1).replace('×', ''));
      expect(html).toContain(messages.playback.backToLive);
      expect(html).toContain(messages.playback.legendTitle);
      for (const entry of PLAYBACK_AGE_CLASSES) expect(html).toContain(entry.color);
      const credit = firmsCreditText(clock, messages);
      expect(credit).not.toBe('');
      expect(html).toContain(credit.slice(0, 40).replace(/'/g, '&#39;'));
      stop();
    },
  );

  it('shows the honest line for an unavailable window', async () => {
    const stop = sync(deps(() => new Response('', { status: 500 })));
    setPlaybackPanelOpen(true);
    startPlayback('3d');
    await settle();
    const html = await renderPanel();
    expect(html).toContain(en.playback.unavailable);
    expect(html).toContain(en.playback.backToLive);
    stop();
  });
});
