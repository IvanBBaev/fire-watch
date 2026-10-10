/**
 * `static_source_verdict` (F16) is additive: a snapshot that omits it parses exactly as
 * before, and one that carries it hands the event the server's verdict for the caveat.
 */

import { describe, expect, it } from 'vitest';

import rawFixture from '../../../public/fixtures/snapshot.json?raw';
import { ParseError, parseSnapshot } from './parse-snapshot.js';

function withFirstVerdict(value: unknown): Record<string, unknown> {
  const body = JSON.parse(rawFixture) as Record<string, unknown>;
  const [feature] = body['features'] as Record<string, Record<string, unknown>>[];
  const properties = feature!['properties'] as Record<string, unknown>;
  if (value === undefined) delete properties['static_source_verdict'];
  else properties['static_source_verdict'] = value;
  return body;
}

describe('parseSnapshot static_source_verdict', () => {
  it('leaves the field off when the feed does not report it', () => {
    for (const value of [undefined, null]) {
      expect(parseSnapshot(withFirstVerdict(value)).events[0]).not.toHaveProperty(
        'staticSourceVerdict',
      );
    }
  });

  it('carries the two published verdicts through', () => {
    expect(parseSnapshot(withFirstVerdict('annotated')).events[0]?.staticSourceVerdict).toBe(
      'annotated',
    );
    expect(parseSnapshot(withFirstVerdict('clear')).events[0]?.staticSourceVerdict).toBe('clear');
  });

  it('drops a verdict this build does not know rather than failing the snapshot', () => {
    expect(parseSnapshot(withFirstVerdict('future_verdict')).events[0]).not.toHaveProperty(
      'staticSourceVerdict',
    );
  });

  it('rejects a verdict that is not a string', () => {
    expect(() => parseSnapshot(withFirstVerdict(1))).toThrow(ParseError);
  });
});
