/**
 * The V2-E3 Copernicus EMS badge: which activations it shows for an event, the link and
 * citation it renders, and the committed fixture (synthetic EMSR000, not a real
 * activation) that the fixture build's `fw-2026-q7f3d` page matches.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { CREDITS, renderCredit, type CemsActivation } from '@fire-watch/contracts';
import prerender from 'preact-iso/prerender';
import { describe, expect, it } from 'vitest';

import { DEFAULT_CONFIG, withDataSource } from '../../core/config.js';
import bg from '../../core/i18n/bg.js';
import en from '../../core/i18n/en.js';
import { CemsBadgeLinks, cemsBadgeActivations } from './cems-badge.js';

const fixtures = fileURLToPath(new URL('../../../public/fixtures/', import.meta.url));
const readJson = (path: string): unknown => JSON.parse(readFileSync(fixtures + path, 'utf8'));

const FIXTURE = readJson('cems/activations.json');

interface SnapshotFeature {
  readonly id: string;
  readonly geometry: { readonly coordinates: readonly [number, number] };
  readonly properties: { readonly first_observed_at: string; readonly last_observed_at: string };
}

function fixtureEvent(id: string) {
  const snapshot = readJson('snapshot.json') as { features: readonly SnapshotFeature[] };
  const feature = snapshot.features.find((f) => f.id === id);
  if (feature === undefined) throw new Error(`no fixture event ${id}`);
  const [lon, lat] = feature.geometry.coordinates;
  return {
    lon,
    lat,
    firstObservedAt: feature.properties.first_observed_at,
    lastObservedAt: feature.properties.last_observed_at,
  };
}

const ACTIVATION: CemsActivation = {
  code: 'EMSR822',
  name: 'Wildfire in Bulgaria and Republic of Serbia',
  event_time: '2025-07-26T08:00:00Z',
  activation_time: '2025-07-26T20:04:00Z',
  last_update: '2025-08-05T15:29:32.927Z',
  closed: true,
  countries: ['Bulgaria'],
  centroid: [23.416672, 41.721618],
  aois: [[23.1987, 41.6323, 23.3816, 41.75]],
  aois_status: 'public',
};

describe('cemsBadgeActivations', () => {
  it('matches the fixture activation to the fixture event it was drawn around', () => {
    const matched = cemsBadgeActivations(FIXTURE, fixtureEvent('fw-2026-q7f3d'));
    expect(matched?.map((a) => a.code)).toEqual(['EMSR000']);
  });

  it('shows nothing for an event elsewhere or at another time', () => {
    const body = {
      schema_version: 1,
      available_at: '2025-08-06T00:00:00Z',
      activations: [ACTIVATION],
    };
    const inside = {
      lon: 23.3,
      lat: 41.7,
      firstObservedAt: '2025-07-26T10:00:00Z',
      lastObservedAt: '2025-07-28T10:00:00Z',
    };
    expect(cemsBadgeActivations(body, inside)?.map((a) => a.code)).toEqual(['EMSR822']);
    expect(cemsBadgeActivations(body, { ...inside, lon: 25.9 })).toEqual([]);
    expect(
      cemsBadgeActivations(body, {
        ...inside,
        firstObservedAt: '2026-07-26T10:00:00Z',
        lastObservedAt: '2026-07-28T10:00:00Z',
      }),
    ).toEqual([]);
  });

  it('reads an unreadable body as nothing to say, not as "no activation"', () => {
    const event = fixtureEvent('fw-2026-q7f3d');
    expect(cemsBadgeActivations(null, event)).toBeNull();
    expect(cemsBadgeActivations({ schema_version: 2, activations: [] }, event)).toBeNull();
    // A 503 problem body, as the route sends when the list read is stale.
    expect(cemsBadgeActivations({ status: 503, title: 'unavailable' }, event)).toBeNull();
  });
});

describe('CemsBadgeLinks', () => {
  it('links each activation to its page, with the citation as the title', async () => {
    const { html } = await prerender(
      <CemsBadgeLinks activations={[ACTIVATION]} t={en.eventDetail} />,
    );
    expect(html).toContain('Copernicus EMS activation EMSR822');
    expect(html).toContain('href="https://mapping.emergency.copernicus.eu/activations/EMSR822/"');
    expect(html).toContain(
      'title="Copernicus Emergency Management Service (© 2025 European Union), EMSR822"',
    );
    expect(html).toContain('rel="noopener noreferrer"');
  });

  it('renders in Bulgarian, and nothing for no match', async () => {
    const { html } = await prerender(
      <CemsBadgeLinks activations={[ACTIVATION]} t={bg.eventDetail} />,
    );
    expect(html).toContain('Активиране на Copernicus EMS EMSR822');
    const none = await prerender(<CemsBadgeLinks activations={[]} t={en.eventDetail} />);
    expect(none.html).not.toContain('cems-badge');
    expect(none.html).not.toContain('<a');
  });
});

describe('the CEMS fixture and config', () => {
  it('carries the registry credit for its year', () => {
    const credit = CREDITS.find((c) => c.id === 'copernicus-ems');
    if (credit === undefined) throw new Error('copernicus-ems is not registered');
    const attribution = (FIXTURE as { attribution: readonly { id: string; text: string }[] })
      .attribution;
    expect(attribution).toEqual([
      {
        id: credit.id,
        source: credit.source,
        text: renderCredit(credit, { year: 2026, productName: 'Fire Watch' }),
        href: credit.href,
      },
    ]);
  });

  it('reads the fixture by default and the API route in live mode', () => {
    expect(DEFAULT_CONFIG.cemsActivationsUrl).toBe('/fixtures/cems/activations.json');
    expect(withDataSource(DEFAULT_CONFIG, 'live').cemsActivationsUrl).toBe(
      '/overlays/cems/activations.json',
    );
  });
});
