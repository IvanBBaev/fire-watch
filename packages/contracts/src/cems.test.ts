import { describe, expect, it } from 'vitest';

import {
  CEMS_MATCH,
  cemsActivationCitation,
  cemsActivationUrl,
  matchCemsActivations,
  parseCemsOverlay,
  type CemsActivation,
} from './cems.js';

/** EMSR822's real shape (three AOIs far apart in Bulgaria), boxes as the server stores them. */
const EMSR822: CemsActivation = {
  code: 'EMSR822',
  name: 'Wildfire in Bulgaria and Republic of Serbia',
  event_time: '2025-07-26T08:00:00Z',
  activation_time: '2025-07-26T20:04:00Z',
  last_update: '2025-08-05T15:29:32.927Z',
  closed: true,
  countries: ['Bulgaria'],
  centroid: [23.416672, 41.721618],
  aois: [
    [22.4428, 42.7605, 22.6219, 42.8822],
    [23.1987, 41.6323, 23.3816, 41.75],
    [26.0708, 41.8839, 26.6951, 42.148],
  ],
  aois_status: 'public',
};

const LESOVO = { lon: 26.62, lat: 42.05 };

function event(lon: number, lat: number, first: string, last: string) {
  return { lon, lat, firstObservedAt: first, lastObservedAt: last };
}

describe('parseCemsOverlay', () => {
  const body = {
    schema_version: 1,
    available_at: '2026-10-24T09:00:00Z',
    activations: [EMSR822],
  };

  it('accepts the stored document and the served one with attribution', () => {
    expect(parseCemsOverlay(JSON.parse(JSON.stringify(body)))).toEqual(body);
    const served = {
      ...body,
      attribution: [
        { id: 'copernicus-ems', source: 's', text: 'x', href: 'https://example.test/' },
      ],
    };
    expect(parseCemsOverlay(served)).toEqual(served);
  });

  it.each([
    ['a wrong schema', { ...body, schema_version: 2 }],
    ['a naive instant', { ...body, available_at: '2026-10-24T09:00:00' }],
    ['a foreign code', { ...body, activations: [{ ...EMSR822, code: 'EMSN123' }] }],
    ['an inverted box', { ...body, activations: [{ ...EMSR822, aois: [[23, 42, 22, 43]] }] }],
    ['an unknown status', { ...body, activations: [{ ...EMSR822, aois_status: 'secret' }] }],
    ['a broken attribution', { ...body, attribution: [{ text: 1 }] }],
  ])('refuses %s', (_label, value) => {
    expect(parseCemsOverlay(value)).toBeNull();
  });

  it('refuses non-objects without throwing', () => {
    for (const value of [null, 1, 'x', [], undefined]) expect(parseCemsOverlay(value)).toBeNull();
  });
});

describe('citation and link', () => {
  it('follows the Copernicus activation citation pattern with the activation year', () => {
    expect(cemsActivationCitation('EMSR822', EMSR822.activation_time)).toBe(
      'Copernicus Emergency Management Service (© 2025 European Union), EMSR822',
    );
  });

  it('links to the public activation page', () => {
    expect(cemsActivationUrl('EMSR822')).toBe(
      'https://mapping.emergency.copernicus.eu/activations/EMSR822/',
    );
  });
});

describe('matchCemsActivations', () => {
  const during = ['2025-07-25T11:00:00Z', '2025-07-28T02:00:00Z'] as const;

  it('matches an event inside an AOI far from the activation centroid', () => {
    expect(matchCemsActivations(event(LESOVO.lon, LESOVO.lat, ...during), [EMSR822])).toEqual([
      EMSR822,
    ]);
  });

  it('matches just outside an AOI within the margin, not beyond it', () => {
    // Lesovo's east edge is 26.6951; at 42° a degree of longitude is about 82 km.
    const inMargin = event(26.6951 + 4 / 82, 42.05, ...during);
    const beyond = event(26.6951 + 7 / 82, 42.05, ...during);
    expect(matchCemsActivations(inMargin, [EMSR822])).toHaveLength(1);
    expect(matchCemsActivations(beyond, [EMSR822])).toHaveLength(0);
  });

  it('does not match the centroid when AOIs are known and the event is outside them', () => {
    expect(matchCemsActivations(event(23.45, 41.75, ...during), [EMSR822])).toHaveLength(0);
  });

  it('falls back to the centroid radius when no AOI is known', () => {
    const restricted: CemsActivation = { ...EMSR822, aois: [], aois_status: 'restricted' };
    expect(matchCemsActivations(event(23.45, 41.75, ...during), [restricted])).toHaveLength(1);
    expect(matchCemsActivations(event(23.65, 41.75, ...during), [restricted])).toHaveLength(0);
  });

  it('matches only events whose observed span meets the activation window', () => {
    const at = (first: string, last: string) =>
      matchCemsActivations(event(LESOVO.lon, LESOVO.lat, first, last), [EMSR822]).length;
    // event_time 2025-07-26T08:00Z; window [07-23T08:00, 08-09T08:00].
    expect(at('2025-07-20T00:00:00Z', '2025-07-23T07:59:00Z')).toBe(0);
    expect(at('2025-07-20T00:00:00Z', '2025-07-23T08:00:00Z')).toBe(1);
    expect(at('2025-08-09T08:00:00Z', '2025-08-10T00:00:00Z')).toBe(1);
    expect(at('2025-08-09T08:01:00Z', '2025-08-10T00:00:00Z')).toBe(0);
    expect(at('2024-07-26T08:00:00Z', '2024-07-27T08:00:00Z')).toBe(0);
  });

  it('keeps input order and ignores unparseable instants', () => {
    const other = { ...EMSR822, code: 'EMSR999' };
    const result = matchCemsActivations(event(LESOVO.lon, LESOVO.lat, ...during), [other, EMSR822]);
    expect(result.map((a) => a.code)).toEqual(['EMSR999', 'EMSR822']);
    expect(matchCemsActivations(event(LESOVO.lon, LESOVO.lat, 'x', 'y'), [EMSR822])).toEqual([]);
  });

  it('is versioned', () => {
    expect(CEMS_MATCH.version).toBe('cems_match_v1');
  });
});
