import { describe, expect, it } from 'vitest';

// Raw (string) import so the test exercises the same JSON bytes the app will serve;
// resolved by vite/vitest, typed by vite/client — no node builtins in the web package.
import rawFixture from '../../../public/fixtures/snapshot.json?raw';
import { ParseError, parseSnapshot } from './parse-snapshot.js';

/** A fresh, mutation-safe copy of the on-disk wire fixture. */
function wireFixture(): Record<string, unknown> {
  return JSON.parse(rawFixture) as Record<string, unknown>;
}

function firstFeature(body: Record<string, unknown>): Record<string, unknown> {
  const features = body['features'] as Record<string, unknown>[];
  const feature = features[0];
  if (feature === undefined) throw new Error('fixture has no features');
  return feature;
}

function firstProperties(body: Record<string, unknown>): Record<string, unknown> {
  return firstFeature(body)['properties'] as Record<string, unknown>;
}

describe('parseSnapshot', () => {
  it('parses the on-disk fixture into the domain shape', () => {
    const snapshot = parseSnapshot(wireFixture());

    expect(snapshot.schemaVersion).toBe(2);
    expect(snapshot.generatedAt).toBe('2026-08-09T09:58:00Z');
    expect(snapshot.maxSeq).toBe(1042);
    expect(snapshot.partial).toBe(false);
    expect(snapshot.events).toHaveLength(14);
    expect(snapshot.sources).toHaveLength(6);
  });

  it('maps snake_case wire properties to the camelCase FireEvent', () => {
    const snapshot = parseSnapshot(wireFixture());
    const event = snapshot.events[0];

    expect(event).toEqual({
      id: 'fw-2026-q7f3d',
      seq: 1042,
      status: 'active',
      scoreBucket: 'confirmed',
      mergedInto: null,
      lon: 25.9,
      lat: 41.93,
      firstObservedAt: '2026-08-07T11:14:00Z',
      lastObservedAt: '2026-08-09T09:47:00Z',
      detectionCount: 14,
      placeNameBg: 'Харманли',
      placeNameEn: 'Harmanli',
      areaHa: 320,
      nextPassWindow: null,
    });
  });

  it('carries merge tombstones through (mergedInto is the survivor public id)', () => {
    const snapshot = parseSnapshot(wireFixture());
    const tombstone = snapshot.events.find((event) => event.id === 'fw-2026-z7c3f');

    expect(tombstone?.mergedInto).toBe('fw-2026-q7f3d');
    expect(tombstone?.areaHa).toBeNull();
  });

  it('maps source rows with nullable last_observed_at', () => {
    const body = wireFixture();
    (body['sources'] as Record<string, unknown>[]).push({
      source_id: 'lsasaf:fci:frp-pixel',
      last_observed_at: null,
    });

    const snapshot = parseSnapshot(body);
    expect(snapshot.sources.at(-1)).toEqual({
      sourceId: 'lsasaf:fci:frp-pixel',
      lastObservedAt: null,
    });
  });

  it('parses a present next_pass_window', () => {
    const body = wireFixture();
    firstProperties(body)['next_pass_window'] = {
      start: '2026-08-09T11:40:00Z',
      end: '2026-08-09T11:55:00Z',
    };

    const snapshot = parseSnapshot(body);
    expect(snapshot.events[0]?.nextPassWindow).toEqual({
      start: '2026-08-09T11:40:00Z',
      end: '2026-08-09T11:55:00Z',
    });
  });

  it('rejects non-object input', () => {
    expect(() => parseSnapshot(null)).toThrow(ParseError);
    expect(() => parseSnapshot('[]')).toThrow(ParseError);
    expect(() => parseSnapshot([])).toThrow(ParseError);
  });

  it('rejects a wrong top-level type', () => {
    const body = wireFixture();
    body['type'] = 'Feature';
    expect(() => parseSnapshot(body)).toThrow(ParseError);
  });

  it.each(['schema_version', 'generated_at', 'max_seq', 'partial', 'sources', 'features'])(
    'rejects a body missing the foreign member %s',
    (member) => {
      const body = wireFixture();
      delete body[member];
      expect(() => parseSnapshot(body)).toThrow(ParseError);
    },
  );

  it('rejects a status outside LIFECYCLE_STATES — "out" is not a state', () => {
    const body = wireFixture();
    firstProperties(body)['status'] = 'out';
    expect(() => parseSnapshot(body)).toThrow(ParseError);
  });

  it('rejects a score_bucket outside SCORE_BUCKETS', () => {
    const body = wireFixture();
    firstProperties(body)['score_bucket'] = 'certain';
    expect(() => parseSnapshot(body)).toThrow(ParseError);
  });

  it('rejects a non-numeric seq', () => {
    const body = wireFixture();
    firstProperties(body)['seq'] = '1042';
    expect(() => parseSnapshot(body)).toThrow(ParseError);
  });

  it.each([
    'id',
    'seq',
    'status',
    'score_bucket',
    'merged_into',
    'first_observed_at',
    'last_observed_at',
    'detection_count',
    'place_name_bg',
    'place_name_en',
    'area_ha',
    'next_pass_window',
  ])('rejects a feature missing the property %s', (property) => {
    const body = wireFixture();
    delete firstProperties(body)[property];
    expect(() => parseSnapshot(body)).toThrow(ParseError);
  });

  it('rejects a feature missing the GeoJSON feature id', () => {
    const body = wireFixture();
    delete firstFeature(body)['id'];
    expect(() => parseSnapshot(body)).toThrow(ParseError);
  });

  it('rejects a feature whose id and properties.id disagree', () => {
    const body = wireFixture();
    firstFeature(body)['id'] = 'fw-2026-other';
    expect(() => parseSnapshot(body)).toThrow(ParseError);
  });

  it('needs no uuid: the fixture carries none and the event has no such field (schema v2)', () => {
    expect(rawFixture).not.toContain('"uuid"');
    const event = parseSnapshot(wireFixture()).events[0];
    expect(event?.id).toBe('fw-2026-q7f3d');
    expect(Object.keys(event ?? {})).not.toContain('uuid');
  });

  it('ignores a stray uuid on the wire rather than reading it', () => {
    const body = wireFixture();
    firstProperties(body)['uuid'] = '5b1f6f0a-8a34-4bfa-9a1e-4dfe2b0c7a11';
    const event = parseSnapshot(body).events[0];
    expect(Object.keys(event ?? {})).not.toContain('uuid');
  });

  it('rejects a non-Point geometry', () => {
    const body = wireFixture();
    firstFeature(body)['geometry'] = {
      type: 'LineString',
      coordinates: [
        [25.9, 41.93],
        [26.0, 42.0],
      ],
    };
    expect(() => parseSnapshot(body)).toThrow(ParseError);
  });

  it('rejects coordinates that are not exactly [lon, lat]', () => {
    const body = wireFixture();
    firstFeature(body)['geometry'] = { type: 'Point', coordinates: [25.9, 41.93, 810] };
    expect(() => parseSnapshot(body)).toThrow(ParseError);
  });

  it('rejects non-finite coordinates', () => {
    const body = wireFixture();
    firstFeature(body)['geometry'] = { type: 'Point', coordinates: [Number.NaN, 41.93] };
    expect(() => parseSnapshot(body)).toThrow(ParseError);
  });

  it('rejects a half-formed next_pass_window', () => {
    const body = wireFixture();
    firstProperties(body)['next_pass_window'] = { start: '2026-08-09T11:40:00Z' };
    expect(() => parseSnapshot(body)).toThrow(ParseError);
  });

  it('rejects a source row missing source_id', () => {
    const body = wireFixture();
    (body['sources'] as Record<string, unknown>[])[0] = {
      last_observed_at: '2026-08-09T00:52:00Z',
    };
    expect(() => parseSnapshot(body)).toThrow(ParseError);
  });

  it('names the failing path in the error message', () => {
    const body = wireFixture();
    firstProperties(body)['detection_count'] = 'many';
    expect(() => parseSnapshot(body)).toThrow(/features\[0\]\.properties\.detection_count/);
  });
});
