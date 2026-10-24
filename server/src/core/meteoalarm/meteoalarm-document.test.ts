import { describe, expect, it } from 'vitest';

import { epochMsFromIso } from '../ports/clock.js';
import {
  METEOALARM_MAX_STALENESS_MS,
  METEOALARM_SCHEMA_VERSION,
  parseMeteoalarmDocument,
  selectActiveWarnings,
  type MeteoalarmDocument,
  type MeteoalarmWarning,
} from './meteoalarm-document.js';

function warning(overrides: Partial<MeteoalarmWarning>): MeteoalarmWarning {
  return {
    id: 'w',
    country: 'BG',
    region: 'Haskovo',
    emma_id: 'BG009',
    kind: 'forest-fire',
    level: 3,
    event: 'Severe forest-fire warning',
    headline: null,
    onset: '2026-08-14T09:00:00Z',
    expires: '2026-08-15T21:00:00Z',
    sent: '2026-08-14T06:00:00Z',
    source_url: 'https://meteoalarm.org?geocode=EMMA_ID:BG009',
    issuer_url: null,
    cap_confirmed: true,
    ...overrides,
  };
}

const document: MeteoalarmDocument = {
  schema_version: METEOALARM_SCHEMA_VERSION,
  generated_at: '2026-08-14T12:00:00Z',
  countries: [{ country: 'BG', checked_at: '2026-08-14T12:00:00Z', ok: true }],
  warnings: [
    warning({ id: 'heat', kind: 'high-temperature', level: 4 }),
    warning({ id: 'fire-yellow', level: 2 }),
    warning({ id: 'gone', expires: '2026-08-14T11:59:00Z' }),
    warning({ id: 'fire-orange-gr', country: 'GR', region: 'Attica' }),
    warning({ id: 'fire-orange-bg' }),
  ],
};

describe('selectActiveWarnings', () => {
  const now = epochMsFromIso('2026-08-14T12:00:00Z');

  it('drops expired warnings and orders fire first, then level, then country', () => {
    const selection = selectActiveWarnings(document, now);
    expect(selection.ok).toBe(true);
    if (!selection.ok) return;
    expect(selection.body.warnings.map((w) => w.id)).toEqual([
      'fire-orange-bg',
      'fire-orange-gr',
      'fire-yellow',
      'heat',
    ]);
    expect(selection.body.generated_at).toBe(document.generated_at);
  });

  it('is stale past the bound, not at it', () => {
    expect(selectActiveWarnings(document, now + METEOALARM_MAX_STALENESS_MS).ok).toBe(true);
    expect(selectActiveWarnings(document, now + METEOALARM_MAX_STALENESS_MS + 1)).toEqual({
      ok: false,
      reason: 'stale',
    });
  });
});

describe('parseMeteoalarmDocument', () => {
  it('round-trips a valid document', () => {
    expect(parseMeteoalarmDocument(JSON.stringify(document))).toEqual(document);
  });

  it.each([
    ['not JSON', '{'],
    ['an array', '[]'],
    ['a wrong schema', JSON.stringify({ ...document, schema_version: 2 })],
    ['a naive timestamp', JSON.stringify({ ...document, generated_at: '2026-08-14T12:00:00' })],
    [
      'an unknown kind',
      JSON.stringify({ ...document, warnings: [warning({ kind: 'fog' as never })] }),
    ],
    ['level 1', JSON.stringify({ ...document, warnings: [warning({ level: 1 as never })] })],
    [
      'a non-https link',
      JSON.stringify({ ...document, warnings: [warning({ source_url: 'http://x' })] }),
    ],
    ['a bad country row', JSON.stringify({ ...document, countries: [{ country: 'BG' }] })],
  ])('refuses %s', (_label, text) => {
    expect(parseMeteoalarmDocument(text)).toBeNull();
  });
});
