/**
 * V2-A4: the estimated-outline body the map and the event panel read. The committed fixture
 * was drawn by the server's own outline core, so it must parse; anything this build cannot
 * draw honestly must not.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { fireOutlineFor, parseFireOutlineOverlay } from './fire-outlines.js';

const FIXTURE: unknown = JSON.parse(
  readFileSync(
    fileURLToPath(new URL('../../public/fixtures/outlines/active.json', import.meta.url)),
    'utf8',
  ),
);

/** A deep copy of the fixture with one change applied. */
function variant(change: (body: Record<string, unknown>) => void): unknown {
  const body = structuredClone(FIXTURE) as Record<string, unknown>;
  change(body);
  return body;
}

function firstProperties(body: Record<string, unknown>): Record<string, unknown> {
  const features = body['features'] as { properties: Record<string, unknown> }[];
  return features[0]!.properties;
}

describe('parseFireOutlineOverlay', () => {
  it('accepts the committed fixture, every feature an estimate with its band', () => {
    const body = parseFireOutlineOverlay(FIXTURE);
    expect(body).not.toBeNull();
    expect(body!.kind).toBe('estimated_outline');
    expect(body!.computed_at).toBe('2026-08-09T09:58:00Z');
    expect(body!.features.length).toBeGreaterThan(0);
    for (const feature of body!.features) {
      const p = feature.properties;
      expect(p.event_id).toBe(feature.id);
      expect(p.area_low_ha).toBeLessThanOrEqual(p.area_ha);
      expect(p.area_ha).toBeLessThanOrEqual(p.area_high_ha);
      expect(p.footprints).toBeGreaterThan(0);
    }
    expect(body!.attribution.map((entry) => entry.id)).toEqual(['firms-acknowledgement']);
  });

  it('refuses a body of another schema, kind or shape', () => {
    expect(parseFireOutlineOverlay(null)).toBeNull();
    expect(parseFireOutlineOverlay('x')).toBeNull();
    expect(parseFireOutlineOverlay(variant((b) => (b['schema_version'] = 2)))).toBeNull();
    expect(parseFireOutlineOverlay(variant((b) => (b['kind'] = 'perimeter')))).toBeNull();
    expect(parseFireOutlineOverlay(variant((b) => (b['computed_at'] = 'yesterday')))).toBeNull();
    expect(parseFireOutlineOverlay(variant((b) => (b['truncated'] = 'no')))).toBeNull();
    expect(parseFireOutlineOverlay(variant((b) => (b['attribution'] = null)))).toBeNull();
  });

  it('refuses a band that does not hold its own area', () => {
    expect(
      parseFireOutlineOverlay(variant((b) => (firstProperties(b)['area_high_ha'] = 1))),
    ).toBeNull();
    expect(
      parseFireOutlineOverlay(variant((b) => (firstProperties(b)['area_low_ha'] = 1e6))),
    ).toBeNull();
    expect(
      parseFireOutlineOverlay(variant((b) => (firstProperties(b)['area_ha'] = -1))),
    ).toBeNull();
    expect(
      parseFireOutlineOverlay(variant((b) => (firstProperties(b)['footprints'] = 0))),
    ).toBeNull();
    expect(
      parseFireOutlineOverlay(variant((b) => (firstProperties(b)['event_id'] = 'fw-other'))),
    ).toBeNull();
  });

  it('refuses a malformed ring', () => {
    const badRing = variant((b) => {
      const features = b['features'] as { geometry: { coordinates: unknown } }[];
      features[0]!.geometry.coordinates = [
        [
          [
            [26, 42],
            [26.1, 42],
            [26, 42],
          ],
        ],
      ];
    });
    expect(parseFireOutlineOverlay(badRing)).toBeNull();
    const offEarth = variant((b) => {
      const features = b['features'] as { geometry: { coordinates: unknown } }[];
      features[0]!.geometry.coordinates = [
        [
          [
            [200, 42],
            [26.1, 42],
            [26.1, 42.1],
            [200, 42],
          ],
        ],
      ];
    });
    expect(parseFireOutlineOverlay(offEarth)).toBeNull();
  });
});

describe('fireOutlineFor', () => {
  it("finds an event's outline, and nothing for an event without one", () => {
    const body = parseFireOutlineOverlay(FIXTURE)!;
    expect(fireOutlineFor(body, 'fw-2026-t6p4a')).toMatchObject({
      area_ha: 110.8,
      area_high_ha: 331.3,
      footprints: 4,
    });
    expect(fireOutlineFor(body, 'fw-2026-zzzzz')).toBeNull();
  });
});
