import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import type { RegionsAsset } from './oblasts.js';
import {
  createOblastIndex,
  isRegionsAsset,
  oblastIso,
  oblastName,
  oblastsByName,
  parseOblast,
} from './oblasts.js';

describe('oblast names', () => {
  it('names all 28 in both languages', () => {
    expect(oblastsByName('bg')).toHaveLength(28);
    expect(oblastsByName('en')).toHaveLength(28);
    expect(oblastName(22, 'bg')).toBe('София (столица)');
    expect(oblastName(23, 'en')).toBe('Sofia Province');
    expect(oblastIso(4)).toBe('BG-04');
    expect(() => oblastName(29, 'en')).toThrow(RangeError);
  });

  it('sorts the picker by name in the reader language', () => {
    expect(oblastsByName('bg')[0]?.name).toBe('Благоевград');
    expect(oblastsByName('en').at(-1)?.name).toBe('Yambol');
  });

  it('parses only 1..28', () => {
    expect(parseOblast('1')).toBe(1);
    expect(parseOblast('28')).toBe(28);
    for (const raw of ['0', '29', '1.5', '-1', 'BG-01', '', null]) {
      expect(parseOblast(raw), String(raw)).toBeNull();
    }
  });
});

describe('createOblastIndex', () => {
  // Two unit squares, BG-01 at lon 0..1 and BG-02 at lon 1..2, lat 42..43 (delta-coded).
  const square = (x: number): number[] => [x * 1000, 42000, 1000, 0, 0, 1000, -1000, 0, 0, -1000];
  const asset: RegionsAsset = {
    v: 1,
    source: 'test',
    scale: 1000,
    regions: [
      ['BG-01', [square(0)]],
      ['BG-02', [square(1)]],
    ],
  };

  it('assigns interior points and the boundary sliver, and nothing far outside', () => {
    const index = createOblastIndex(asset);
    expect(index.numbers).toStrictEqual([1, 2]);
    expect(index.regionAt(0.5, 42.5)).toBe(1);
    expect(index.regionAt(1.5, 42.5)).toBe(2);
    expect(index.regionAt(0.5, 43.009)).toBe(1);
    expect(index.regionAt(0.5, 45)).toBeNull();
  });
});

describe('the shipped oblast asset', () => {
  const asset: unknown = JSON.parse(
    readFileSync(new URL('../../assets/geodata/oblasts.json', import.meta.url), 'utf8'),
  );

  it('carries all 28 oblasts and places the capitals correctly', () => {
    expect(isRegionsAsset(asset)).toBe(true);
    const index = createOblastIndex(asset as RegionsAsset);
    expect(index.numbers).toStrictEqual(Array.from({ length: 28 }, (_, i) => i + 1));
    expect(index.regionAt(23.32, 42.69)).toBe(22); // Sofia
    expect(index.regionAt(24.75, 42.15)).toBe(16); // Plovdiv
    expect(index.regionAt(27.91, 43.21)).toBe(3); // Varna
    expect(index.regionAt(26.57, 42.17)).toBe(28); // Elhovo, Yambol oblast
    expect(index.regionAt(10, 50)).toBeNull();
  });
});
