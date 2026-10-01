/**
 * `source_ids` (Track F) is additive: a snapshot that omits it parses exactly as before,
 * and one that carries it hands the event its sensor ids for the source filter.
 */

import { describe, expect, it } from 'vitest';

import rawFixture from '../../../public/fixtures/snapshot.json?raw';
import { ParseError, parseSnapshot } from './parse-snapshot.js';

function withFirstSourceIds(value: unknown): Record<string, unknown> {
  const body = JSON.parse(rawFixture) as Record<string, unknown>;
  const [feature] = body['features'] as Record<string, Record<string, unknown>>[];
  const properties = feature!['properties'] as Record<string, unknown>;
  if (value === undefined) delete properties['source_ids'];
  else properties['source_ids'] = value;
  return body;
}

describe('parseSnapshot source_ids', () => {
  it('leaves the field off when the feed does not report it', () => {
    expect(parseSnapshot(withFirstSourceIds(undefined)).events[0]).not.toHaveProperty('sourceIds');
    expect(parseSnapshot(withFirstSourceIds(null)).events[0]).not.toHaveProperty('sourceIds');
  });

  it('carries reported ids through', () => {
    const ids = ['firms:viirs:noaa20', 'firms:modis'];
    expect(parseSnapshot(withFirstSourceIds(ids)).events[0]?.sourceIds).toStrictEqual(ids);
  });

  it('keeps ids this build does not know, rather than failing the snapshot', () => {
    // The registry is append-only: an unknown id is a newer server, not a defect.
    const ids = ['firms:viirs:snpp', 'future:sensor:x'];
    expect(parseSnapshot(withFirstSourceIds(ids)).events[0]?.sourceIds).toStrictEqual(ids);
    expect(parseSnapshot(withFirstSourceIds([])).events[0]?.sourceIds).toStrictEqual([]);
  });

  it('reads the sensors the shipped fixture reports for every event', () => {
    const events = parseSnapshot(JSON.parse(rawFixture) as unknown).events;
    expect(events.length).toBeGreaterThan(0);
    for (const event of events) expect(event.sourceIds?.length).toBeGreaterThan(0);
  });

  it('rejects a malformed list as a wire defect', () => {
    expect(() => parseSnapshot(withFirstSourceIds('firms:modis'))).toThrow(ParseError);
    expect(() => parseSnapshot(withFirstSourceIds([1]))).toThrow(ParseError);
  });
});
