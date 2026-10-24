/**
 * V2-B3, web half: the MeteoAlarm document parser. The body is validated whole, links are
 * kept only when they are https, and the live build points at the server's overlay route.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { DEFAULT_CONFIG, LIVE_METEOALARM_URL, withDataSource } from './config.js';
import {
  officialLinkOf,
  parseMeteoalarmDocument,
  uncheckedCountries,
  type MeteoalarmDoc,
} from './meteoalarm.js';

const FIXTURE = JSON.parse(
  readFileSync(
    fileURLToPath(new URL('../../public/fixtures/meteoalarm/warnings.json', import.meta.url)),
    'utf8',
  ),
) as Record<string, unknown>;

const warningsOf = (body: Record<string, unknown>) => body['warnings'] as Record<string, unknown>[];

function withWarning(patch: Record<string, unknown>): Record<string, unknown> {
  const [first, ...rest] = warningsOf(FIXTURE);
  return { ...FIXTURE, warnings: [{ ...first, ...patch }, ...rest] };
}

describe('parseMeteoalarmDocument', () => {
  it('reads the fixture: three warnings, five countries, one attribution', () => {
    const doc = parseMeteoalarmDocument(FIXTURE) as MeteoalarmDoc;
    expect(doc).not.toBeNull();
    expect(doc.warnings.map((w) => [w.country, w.kind, w.level])).toEqual([
      ['GR', 'forest-fire', 4],
      ['BG', 'forest-fire', 3],
      ['BG', 'high-temperature', 2],
    ]);
    expect(doc.countries).toHaveLength(5);
    expect(doc.attribution[0]?.href).toBe('https://meteoalarm.org');
  });

  it('names the countries whose last read failed', () => {
    const doc = parseMeteoalarmDocument(FIXTURE) as MeteoalarmDoc;
    expect(uncheckedCountries(doc)).toEqual(['MK']);
  });

  it('links to the MeteoAlarm page, else to the issuer', () => {
    const doc = parseMeteoalarmDocument(FIXTURE) as MeteoalarmDoc;
    expect(doc.warnings.map(officialLinkOf)).toEqual([
      'https://meteoalarm.org?region=GR',
      'https://meteoalarm.org?region=BG',
      'https://www.meteo.bg/',
    ]);
  });

  it('drops a link that is not https instead of offering it', () => {
    const doc = parseMeteoalarmDocument(
      withWarning({ source_url: 'javascript:alert(1)', issuer_url: 'http://example.org/' }),
    ) as MeteoalarmDoc;
    expect(doc.warnings[0]?.source_url).toBeNull();
    expect(doc.warnings[0]?.issuer_url).toBeNull();
    expect(officialLinkOf(doc.warnings[0] as MeteoalarmDoc['warnings'][number])).toBeNull();
  });

  it('accepts a body without attribution', () => {
    const { attribution: _dropped, ...rest } = FIXTURE;
    expect(parseMeteoalarmDocument(rest)?.attribution).toEqual([]);
  });

  it.each([
    ['another schema', { ...FIXTURE, schema_version: 2 }],
    ['no generated_at', { ...FIXTURE, generated_at: 'yesterday' }],
    ['an unknown country', withWarning({ country: 'TR' })],
    ['an unknown kind', withWarning({ kind: 'flood' })],
    ['a level outside 2–4', withWarning({ level: 1 })],
    ['a warning without an end', withWarning({ expires: null })],
    ['a missing link field', withWarning({ source_url: undefined })],
    ['an empty region', withWarning({ region: '' })],
    ['a non-array list', { ...FIXTURE, warnings: {} }],
  ])('rejects the whole body on %s', (_label, body) => {
    expect(parseMeteoalarmDocument(JSON.parse(JSON.stringify(body)))).toBeNull();
  });

  it('rejects a non-object', () => {
    expect(parseMeteoalarmDocument(null)).toBeNull();
    expect(parseMeteoalarmDocument('[]')).toBeNull();
  });
});

describe('meteoalarm config', () => {
  it('reads the fixture by default and the overlay route when live', () => {
    expect(DEFAULT_CONFIG.meteoalarmUrl).toBe('/fixtures/meteoalarm/warnings.json');
    expect(withDataSource(DEFAULT_CONFIG, 'live').meteoalarmUrl).toBe(LIVE_METEOALARM_URL);
    expect(LIVE_METEOALARM_URL).toBe('/overlays/meteoalarm/warnings.json');
  });
});
