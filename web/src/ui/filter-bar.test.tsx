/**
 * The filter bar through the real component: one labelled control per filter (each a
 * single tab stop), live per-sensor counts, and the fail-open notes that say what the
 * client does not know.
 */

import { afterEach, describe, expect, it } from 'vitest';
import prerender from 'preact-iso/prerender';

import { DEFAULT_CONFIG } from '../core/config.js';
import type { FamilyCounts, SensitivityCounts } from '../core/filter/event-filter.js';
import { DEFAULT_SENSITIVITY, SENSITIVITY_PRESETS } from '../core/filter/sensitivity.js';
import bg from '../core/i18n/bg.js';
import en from '../core/i18n/en.js';
import type { Messages } from '../core/i18n/messages.js';
import type { FireEventStore, Locale } from '../core/types.js';
import { AppContext } from './context.js';
import type { AppServices } from './context.js';
import { FilterBar } from './filter-bar.js';
import { regionFilter, regionIndexState, sensitivityFilter, sourceFamily } from './filters.js';

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
const SENSITIVITY: SensitivityCounts = {
  byPreset: { all: 9, balanced: 5, multi: 2 },
  current: 9,
  sensorsUnreported: 0,
};

async function render(
  messages: Messages = en,
  locale: Locale = 'en',
  sensitivityCounts: SensitivityCounts = SENSITIVITY,
): Promise<string> {
  const { html } = await prerender(
    <AppContext.Provider value={services(messages, locale)}>
      <FilterBar counts={COUNTS} sensitivityCounts={sensitivityCounts} />
    </AppContext.Provider>,
  );
  return html.replace(/<script[\s\S]*?<\/script>/g, '');
}

afterEach(() => {
  sourceFamily.value = null;
  regionFilter.value = null;
  regionIndexState.value = 'idle';
  sensitivityFilter.value = DEFAULT_SENSITIVITY;
});

describe('FilterBar', () => {
  it('labels every control and offers every window, sensor and oblast', async () => {
    const html = await render();
    for (const id of [
      'place-search-input',
      'filter-window',
      'filter-source',
      'filter-region',
      'filter-sensitivity',
      'filter-min-band',
      'filter-min-detections',
      'filter-min-sensors',
    ]) {
      expect(html).toContain(`for="${id}"`);
      expect(html).toContain(`id="${id}"`);
    }
    // Window, sensor, region, sensitivity presets, then the band/detections/sensors criteria.
    expect(html.match(/<option /g)).toHaveLength(7 + 5 + 29 + 3 + 3 + 4 + 3);
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

  it('counts each sensitivity preset and says hidden signals may still be fires', async () => {
    const html = await render();
    expect(html).toContain('All signals (9)');
    expect(html).toContain('Balanced (5)');
    expect(html).toContain('Seen several times (2)');
    expect(html).not.toContain(en.filters.sensitivityHint);
    sensitivityFilter.value = SENSITIVITY_PRESETS.balanced;
    expect(await render()).toContain(en.filters.sensitivityHint);
  });

  it('shows a custom combination as its own option, and the fail-open sensor note', async () => {
    sensitivityFilter.value = { minBand: 'confirmed', minDetections: 4, minSensors: 2 };
    const html = await render(bg, 'bg', { ...SENSITIVITY, current: 1, sensorsUnreported: 3 });
    expect(html).toContain('Персонализирано (1)');
    expect(html).toContain('Поне 4');
    expect(html).toContain(bg.filters.sensitivityUnreported(3));
  });
});
