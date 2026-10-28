/**
 * V3-P2: the section registry finds every section file, orders it by its slot, and a new
 * file at a new slot lands exactly where its number says — between the sections on either
 * side, with nothing else edited.
 */

import { describe, expect, it } from 'vitest';
import prerender from 'preact-iso/prerender';

import { DEFAULT_CONFIG } from '../../../core/config.js';
import en from '../../../core/i18n/en.js';
import type { FireEvent, FireEventStore } from '../../../core/types.js';
import { AppContext } from '../../context.js';
import type { AppServices } from '../../context.js';
import { EventDetails } from '../event-details.js';
import { detailStateOf } from '../use-detection-summary.js';
import {
  EVENT_SECTIONS,
  loadSections,
  loadedSections,
  orderSections,
  type EventSectionModule,
} from './registry.js';

const NOW_MS = Date.parse('2026-08-09T12:00:00Z');

const EVENT: FireEvent = {
  id: 'fw-2026-k9s2r',
  seq: 7,
  status: 'active',
  scoreBucket: 'confirmed',
  mergedInto: null,
  lon: 23.3219,
  lat: 42.6977,
  firstObservedAt: '2026-08-09T09:30:00Z',
  lastObservedAt: '2026-08-09T11:45:00Z',
  detectionCount: 1,
  placeNameBg: 'София',
  placeNameEn: 'Sofia',
  areaHa: null,
  nextPassWindow: null,
};

const READY = detailStateOf({
  features: [
    {
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [23.32, 42.7] },
      properties: {
        uid: 'a',
        observed_at: '2026-08-09T11:45:00Z',
        source_id: 'firms:viirs:snpp',
        frp_mw: 6.5,
      },
    },
  ],
});

const SERVICES: AppServices = {
  store: {} as FireEventStore,
  clock: { epochNow: () => NOW_MS, monotonicNow: () => 0 },
  serverNow: () => NOW_MS,
  config: DEFAULT_CONFIG,
  geolocator: {
    locate: () => {
      throw new Error('the panel must never ask for a location on render');
    },
  },
  locale: 'en',
  messages: en,
  setLocale: () => {},
};

const noop = (): Promise<EventSectionModule> => Promise.resolve({ default: () => null });

describe('event section registry', () => {
  it('finds the existing sections at their slots, in order', () => {
    expect(EVENT_SECTIONS.map(({ slot, name }) => `${String(slot)}-${name}`)).toEqual([
      '100-static-source',
      '200-protected-site',
      '300-land-cover',
      '400-lightning',
      '500-fire-outline',
      '600-cems',
      '700-detections',
      '800-before-after',
      '900-where',
    ]);
  });

  it('orders by slot number, not by the glob record order', () => {
    const order = orderSections({
      './900-z.section.tsx': noop,
      './050-a.section.tsx': noop,
      './450-m.section.tsx': noop,
    }).map(({ slot }) => slot);
    expect(order).toEqual([50, 450, 900]);
  });

  it('refuses a file name without a slot and two files at one slot', () => {
    expect(() => orderSections({ './where.section.tsx': noop })).toThrow(/<slot>-<name>/);
    expect(() => orderSections({ './10-short.section.tsx': noop })).toThrow(/<slot>-<name>/);
    expect(() =>
      orderSections({ './400-a.section.tsx': noop, './400-b.section.tsx': noop }),
    ).toThrow(/share slot 400/);
  });

  it('loads every chunk once and keeps the components', async () => {
    const first = await loadSections();
    expect(first.map(({ slot }) => slot)).toEqual(EVENT_SECTIONS.map(({ slot }) => slot));
    expect(loadedSections()).toBe(first);
    expect(await loadSections()).toBe(first);
  });

  it('does not cache a failed load', async () => {
    let calls = 0;
    const flaky = orderSections({
      './100-flaky.section.tsx': () => {
        calls += 1;
        return calls === 1 ? Promise.reject(new Error('chunk')) : noop();
      },
    });
    await expect(loadSections(flaky)).rejects.toThrow('chunk');
    expect(loadedSections(flaky)).toBeNull();
    expect((await loadSections(flaky)).map(({ slot }) => slot)).toEqual([100]);
  });

  it('renders a new section file at its slot, between its neighbours', async () => {
    const files: Record<string, () => Promise<EventSectionModule>> = {
      './750-probe.section.tsx': () =>
        Promise.resolve({ default: () => <p data-probe="750">probe</p> }),
    };
    for (const entry of EVENT_SECTIONS) {
      files[`./${String(entry.slot)}-${entry.name}.section.tsx`] = entry.load;
    }
    const sections = orderSections(files);
    await loadSections(sections);
    const { html } = await prerender(
      <AppContext.Provider value={SERVICES}>
        <EventDetails event={EVENT} nowMs={NOW_MS} detail={READY} sections={sections} />
      </AppContext.Provider>,
    );
    const sensors = html.indexOf('Contributing sensors');
    const probe = html.indexOf('data-probe="750"');
    const beforeAfter = html.indexOf(`>${en.beforeAfter.open}</button>`);
    const timeline = html.indexOf('Satellite timeline');
    expect(timeline).toBeGreaterThanOrEqual(0);
    expect(sensors).toBeGreaterThan(timeline);
    expect(probe).toBeGreaterThan(sensors);
    expect(beforeAfter).toBeGreaterThan(probe);
  });

  it('renders the timeline alone until the sections have loaded', async () => {
    const unloaded = orderSections({ './100-later.section.tsx': noop });
    const { html } = await prerender(
      <AppContext.Provider value={SERVICES}>
        <EventDetails event={EVENT} nowMs={NOW_MS} detail={READY} sections={unloaded} />
      </AppContext.Provider>,
    );
    expect(html).toContain('Satellite timeline');
    expect(html).not.toContain('Contributing sensors');
  });
});
