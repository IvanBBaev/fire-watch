/**
 * G6 done-when, web half: the toggle exists only while client-config carries an `imagery`
 * block, and a withdrawn block both removes the toggle and drops the layer back to the
 * basemap. Rendered through the real component and the real document reader — the
 * "config says so" below is a client-config body, not a flag poked into the signals.
 */

import { afterEach, describe, expect, it } from 'vitest';
import prerender from 'preact-iso/prerender';

import { DEFAULT_CONFIG } from '../core/config.js';
import bg from '../core/i18n/bg.js';
import en from '../core/i18n/en.js';
import type { Messages } from '../core/i18n/messages.js';
import { parseImageryHandles } from '../core/imagery/index.js';
import type { FireEventStore } from '../core/types.js';
import { AppContext } from './context.js';
import type { AppServices } from './context.js';
import { imageryTilesUrl, setImageryHandles, toggleImagery } from './imagery.js';
import { ImageryToggle } from './imagery-toggle.js';

const TEMPLATE = 'https://tiles.example.test/imagery/tile/{z}/{y}/{x}';
const OFFERED = {
  transport: 'poll',
  poll_interval_ms: 60_000,
  static_snapshot_url: null,
  imagery: { tile_url_template: TEMPLATE, api_key: 'AAPK-test' },
};
const TRIPPED = { ...OFFERED, imagery: undefined };

const store = {} as FireEventStore;

function services(messages: Messages): AppServices {
  return {
    store,
    clock: { epochNow: () => 0, monotonicNow: () => 0 },
    serverNow: () => 0,
    config: DEFAULT_CONFIG,
    geolocator: { locate: () => Promise.reject(new Error('not asked')) },
    locale: 'en',
    messages,
    setLocale: () => {},
  };
}

async function renderToggle(messages: Messages = en): Promise<string> {
  const { html } = await prerender(
    <AppContext.Provider value={services(messages)}>
      <ImageryToggle />
    </AppContext.Provider>,
  );
  // preact-iso appends its hydration data; only the component's own markup matters here.
  return html.replace(/<script[\s\S]*?<\/script>/g, '');
}

/** What the refresher does with a client-config answer. */
const receive = (document: unknown): void => {
  setImageryHandles(parseImageryHandles(document));
};

afterEach(() => {
  setImageryHandles(null);
});

describe('ImageryToggle', () => {
  it('is rendered only while client-config offers imagery', async () => {
    expect(await renderToggle()).toBe('');

    receive(OFFERED);
    const offered = await renderToggle();
    expect(offered).toContain('Satellite imagery');
    expect(offered).toContain('aria-pressed="false"');

    // Simulated quota exhaustion: the server drops the block, the toggle disappears.
    receive(TRIPPED);
    expect(await renderToggle()).toBe('');
  });

  it('drops an active imagery layer back to the basemap when the block goes', async () => {
    receive(OFFERED);
    toggleImagery();
    expect(imageryTilesUrl.value).toBe(`${TEMPLATE}?token=AAPK-test`);
    expect(await renderToggle()).toContain('aria-pressed="true"');

    receive(TRIPPED);
    expect(imageryTilesUrl.value).toBeNull();

    // A later re-enable (next quota period, ops override) offers the toggle switched off.
    receive(OFFERED);
    expect(imageryTilesUrl.value).toBeNull();
    expect(await renderToggle()).toContain('aria-pressed="false"');
  });

  it('labels the toggle from the catalog in each locale', async () => {
    receive(OFFERED);
    expect(await renderToggle(en)).toContain('>Satellite imagery</button>');
    expect(await renderToggle(bg)).toContain('>Сателитни изображения</button>');
  });
});
