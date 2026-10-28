/**
 * The rich event panel, rendered through the real component and the real catalogs. What
 * it must never do is state more than the data carries: no sensors or FRP without a
 * detections file, no "last seen by" from a file that stops short of the snapshot, no
 * routing link, and no location prompt on render.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import prerender from 'preact-iso/prerender';

import { DEFAULT_CONFIG } from '../../core/config.js';
import bg from '../../core/i18n/bg.js';
import en from '../../core/i18n/en.js';
import type { Messages } from '../../core/i18n/messages.js';
import type { FireEvent, FireEventStore, Locale } from '../../core/types.js';
import { AppContext } from '../context.js';
import type { AppServices } from '../context.js';
import { detailStateOf } from './use-detection-summary.js';
import type { DetailState } from './use-detection-summary.js';
import { EventDetails, EventIdentity } from './event-details.js';
import { loadSections } from './sections/registry.js';

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
  detectionCount: 4,
  placeNameBg: 'София',
  placeNameEn: 'Sofia',
  areaHa: null,
  nextPassWindow: null,
};

const feature = (uid: string, observedAt: string, sourceId: string, frp?: number) => ({
  type: 'Feature',
  geometry: { type: 'Point', coordinates: [23.32, 42.7] },
  properties: {
    uid,
    observed_at: observedAt,
    source_id: sourceId,
    ...(frp === undefined ? {} : { frp_mw: frp }),
  },
});

const READY = detailStateOf({
  type: 'FeatureCollection',
  features: [
    feature('a', '2026-08-09T09:30:00Z', 'firms:viirs:snpp', 6.5),
    feature('b', '2026-08-09T09:30:00Z', 'firms:viirs:snpp', 3.5),
    feature('c', '2026-08-09T10:15:00Z', 'lsasaf:seviri:frp-pixel', 60),
    feature('d', '2026-08-09T11:45:00Z', 'eumetsat:slstr:frp', 22.4),
  ],
});

const NO_FRP = detailStateOf({
  features: [feature('a', '2026-08-09T11:45:00Z', 'firms:modis')],
});

function services(messages: Messages, locale: Locale): AppServices {
  return {
    store: {} as FireEventStore,
    clock: { epochNow: () => NOW_MS, monotonicNow: () => 0 },
    serverNow: () => NOW_MS,
    config: DEFAULT_CONFIG,
    geolocator: {
      locate: () => {
        throw new Error('the panel must never ask for a location on render');
      },
    },
    locale,
    messages,
    setLocale: () => {},
  };
}

async function render(
  detail: DetailState,
  options: { readonly messages?: Messages; readonly locale?: Locale } = {},
): Promise<string> {
  const { messages = en, locale = 'en' } = options;
  const { html } = await prerender(
    <AppContext.Provider value={services(messages, locale)}>
      <EventDetails event={EVENT} nowMs={NOW_MS} detail={detail} />
    </AppContext.Provider>,
  );
  return html.replace(/<script[\s\S]*?<\/script>/g, '');
}

describe('EventDetails', () => {
  // Server rendering runs no effects: the sections' chunks load first, as on a second visit.
  beforeAll(async () => {
    await loadSections();
  });

  it('states the timeline with honest ages and absolute times', async () => {
    const html = await render(READY);
    expect(html).toContain('Satellite timeline');
    expect(html).toContain('datetime="2026-08-09T09:30:00Z"');
    expect(html).toContain('2 h 30 min ago');
    expect(html).toContain('15 min ago');
    expect(html).toContain('<dd>4</dd>');
    expect(html).toContain('Last seen by');
    expect(html).toContain('SLSTR · Sentinel-3A/3B');
  });

  it('shows FRP per pass with a labelled sparkline and the cross-sensor warning', async () => {
    const html = await render(READY);
    expect(html).toContain('Latest pass: 22.4 MW (SLSTR · Sentinel-3A/3B');
    expect(html).toContain('Highest pass: 60 MW (SEVIRI · Meteosat');
    expect(html).toContain('role="img"');
    expect(html).toContain(
      'aria-label="FRP chart: 3 satellite passes, oldest to newest, from 10 to 60 MW"',
    );
    expect(html).toContain('It is not comparable across sensors');
  });

  it('lists the contributing sensors with orbit and nominal pixel size', async () => {
    const html = await render(READY);
    expect(html).toContain('VIIRS · Suomi NPP</strong> · polar orbit · 375 m pixel · 2 detections');
    expect(html).toContain(
      'SEVIRI · Meteosat</strong> · geostationary · ~4 km pixel · 1 detection',
    );
  });

  it('says FRP is missing rather than drawing zero', async () => {
    const html = await render(NO_FRP);
    expect(html).toContain('carry no FRP values');
    expect(html).not.toContain('<svg');
    expect(html).toContain('1 km pixel');
  });

  it('adds nothing detection-shaped when the detections file is unavailable', async () => {
    const html = await render({ kind: 'unavailable' });
    expect(html).toContain('Per-detection detail is not available');
    expect(html).not.toContain('Contributing sensors');
    expect(html).not.toContain('Last seen by');
    expect(html).not.toContain('<svg');
  });

  it('names no last sensor from a file that stops before the last observation', async () => {
    const older = detailStateOf({
      features: [feature('a', '2026-08-09T10:15:00Z', 'firms:modis', 5)],
    });
    expect(await render(older)).not.toContain('Last seen by');
  });

  it('offers an area view and a distance button, never routing', async () => {
    const html = await render({ kind: 'loading' });
    expect(html).toContain('<code>42.70, 23.32</code>');
    expect(html).toContain('href="https://www.openstreetmap.org/#map=12/42.70/23.32"');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).toContain('target="_blank"');
    const hrefs = [...html.matchAll(/href="([^"]*)"/g)].map((match) => match[1]);
    expect(hrefs).toEqual(['https://www.openstreetmap.org/#map=12/42.70/23.32']);
    expect(html).toContain('Show distance from my location');
    expect(html).toContain('For orientation only, not directions.');
  });

  it('offers the before/after comparison closed: no NASA request, no credit', async () => {
    const html = await render(READY);
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain(`>${en.beforeAfter.open}</button>`);
    expect(html).not.toContain('gibs.earthdata.nasa.gov');
    expect(html).not.toContain('NASA GIBS');
  });

  it('renders in Bulgarian from the Bulgarian catalog', async () => {
    const html = await render(READY, { messages: bg, locale: 'bg' });
    expect(html).toContain('Сателитна хронология');
    expect(html).toContain('Последно преминаване: 22,4 МВт');
    expect(html).toContain('полярна орбита · пиксел 375 м');
    expect(html).toContain('Покажи разстоянието от моето местоположение');
  });
});

describe('EventIdentity', () => {
  it('shows the public id next to the copy-link button', async () => {
    const { html } = await prerender(
      <AppContext.Provider value={services(en, 'en')}>
        <EventIdentity eventId="fw-2026-k9s2r" />
      </AppContext.Provider>,
    );
    expect(html).toContain('Event ID: <code>fw-2026-k9s2r</code>');
    expect(html).toContain('>Copy link</button>');
    expect(html).toContain('role="status"');
  });
});
