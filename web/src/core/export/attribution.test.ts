import { creditsFor } from '@fire-watch/contracts';
import { describe, expect, it } from 'vitest';

import { CREDIT_SOURCE_PREFIXES, exportAttribution } from './attribution.js';

const CONTEXT = { year: 2026, productName: 'Fire Watch' };
const ALL_API = creditsFor('api', []).map((credit) => credit.id);
const ids = (sets: readonly (readonly string[] | null)[]): string[] =>
  exportAttribution(sets, CONTEXT).map((line) => line.id);

describe('exportAttribution', () => {
  it('only narrows credits that exist on the api surface', () => {
    for (const id of Object.keys(CREDIT_SOURCE_PREFIXES)) expect(ALL_API).toContain(id);
  });

  it('keeps FIRMS credits and drops the EUMETSAT ones for a FIRMS-only file', () => {
    const lines = ids([['firms:viirs:snpp'], ['firms:modis', 'firms:viirs:noaa20']]);
    expect(lines).toContain('firms-acknowledgement');
    expect(lines).toContain('lance-as-is');
    expect(lines).not.toContain('eumetsat-meteosat');
    expect(lines).not.toContain('lsa-saf-long');
    expect(lines).not.toContain('sentinel-modified');
  });

  it('always keeps the credits not tied to one source', () => {
    const always = ALL_API.filter((id) => !(id in CREDIT_SOURCE_PREFIXES));
    expect(always.length).toBeGreaterThan(0);
    for (const id of always) expect(ids([['lsasaf:fci:frp-pixel']])).toContain(id);
  });

  it('keeps the Sentinel credit for an SLSTR source', () => {
    const lines = ids([['eumetsat:slstr:frp']]);
    expect(lines).toContain('sentinel-modified');
    expect(lines).not.toContain('firms-acknowledgement');
  });

  it.each([
    ['a record without sources', [['firms:modis'], null]],
    ['a record with an empty source list', [['firms:modis'], []]],
    ['an unknown source id', [['firms:modis'], ['newsat:frp']]],
    ['an empty file', []],
  ] as const)('fails open to the full api set for %s', (_label, sets) => {
    expect(ids(sets)).toEqual(ALL_API);
  });

  it('resolves placeholders and keeps registry order and links', () => {
    const lines = exportAttribution([null], CONTEXT);
    for (const line of lines) {
      expect(line.text).not.toMatch(/\{[a-zA-Z]+\}/u);
      expect(line.text.length).toBeGreaterThan(0);
    }
    expect(lines.some((line) => line.href?.startsWith('https://') === true)).toBe(true);
  });
});
