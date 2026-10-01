/**
 * The filter bar through the real component: one labelled control per filter (each a
 * single tab stop), live per-sensor counts, and the fail-open notes that say what the
 * client does not know.
 */

import { afterEach, describe, expect, it } from 'vitest';
import prerender from 'preact-iso/prerender';

import { DEFAULT_CONFIG } from '../core/config.js';
import type { FamilyCounts } from '../core/filter/event-filter.js';
import bg from '../core/i18n/bg.js';
import en from '../core/i18n/en.js';
import type { Messages } from '../core/i18n/messages.js';
import type { FireEventStore, Locale } from '../core/types.js';
import { AppContext } from './context.js';
import type { AppServices } from './context.js';
import { FilterBar } from './filter-bar.js';
import { regionFilter, regionIndexState, sourceFamily } from './filters.js';

function services(messages: Messages, locale: Locale): AppServices {
  return {
    store: {} as FireEventStore,
    clock: { epochNow: () => 0, monotonicNow: () => 0 },
    serverNow: () => 0,
    config: DEFAULT_CONFIG,
    geolocator: { locate: () => Promise.reject(new Error('not asked')) },
    locale,
    messages,
    setLocale: () => {},
  };
}

const COUNTS: FamilyCounts = { byFamily: { v: 7, m: 3, s: 0, g: 1 }, unreported: 2, total: 9 };

async function render(messages: Messages = en, locale: Locale = 'en'): Promise<string> {
  const { html } = await prerender(
    <AppContext.Provider value={services(messages, locale)}>
      <FilterBar counts={COUNTS} />
    </AppContext.Provider>,
  );
  return html.replace(/<script[\s\S]*?<\/script>/g, '');
}

afterEach(() => {
  sourceFamily.value = null;
  regionFilter.value = null;
  regionIndexState.value = 'idle';
});

describe('FilterBar', () => {
  it('labels every control and offers every window, sensor and oblast', async () => {
    const html = await render();
    for (const id of ['place-search-input', 'filter-window', 'filter-source', 'filter-region']) {
      expect(html).toContain(`for="${id}"`);
      expect(html).toContain(`id="${id}"`);
    }
    expect(html.match(/<option /g)).toHaveLength(7 + 5 + 29);
    expect(html).toContain('All sensors (9)');
    expect(html).toContain('VIIRS (7)');
    expect(html).toContain('Meteosat SEVIRI/FCI (1)');
    expect(html).toContain('role="combobox"');
  });

  it('says how many fires carry no sensor data once a sensor is chosen', async () => {
    expect(await render()).not.toContain(en.filters.sourceUnreported(2));
    sourceFamily.value = 'v';
    expect(await render()).toContain(en.filters.sourceUnreported(2));
  });

  it('says a region is not applied yet while its borders load, or failed to', async () => {
    regionFilter.value = 22;
    regionIndexState.value = 'loading';
    expect(await render()).toContain(en.filters.regionLoading);
    regionIndexState.value = 'failed';
    expect(await render(bg, 'bg')).toContain(bg.filters.regionFailed);
  });

  it('names the oblasts in the reader language', async () => {
    expect(await render(bg, 'bg')).toContain('София (столица)');
    expect(await render()).toContain('Sofia City');
  });
});
