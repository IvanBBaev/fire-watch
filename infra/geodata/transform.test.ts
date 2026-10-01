import { deflateRawSync } from 'node:zlib';

import { describe, expect, it } from 'vitest';

import {
  buildGazetteer,
  buildRegions,
  decodeRing,
  encodeRing,
  foldName,
  OBLAST_ISO_CODES,
  parseBulgarianNames,
  pointInRing,
  rankOf,
  regionOf,
} from './transform.js';
import { readZipMember } from './zip.js';

/** 28 unit squares side by side along the equator-ish row at lat 42..43, lon i..i+1. */
function syntheticOblasts(): {
  features: {
    properties: Record<string, unknown>;
    geometry: { type: string; coordinates: unknown };
  }[];
} {
  return {
    features: OBLAST_ISO_CODES.map((iso, i) => ({
      properties: { adm0_a3: 'BGR', iso_3166_2: iso },
      geometry: {
        type: 'Polygon',
        coordinates: [
          [
            [i, 42],
            [i + 1, 42],
            [i + 1, 43],
            [i, 43],
            [i, 42],
          ],
        ],
      },
    })),
  };
}

describe('foldName', () => {
  it('meets Cyrillic and the common Latin romanisations in one key', () => {
    expect(foldName('София')).toBe('sofia');
    expect(foldName('Sofiya')).toBe('sofia');
    expect(foldName('Велико Търново')).toBe(foldName('Veliko Tŭrnovo'));
    expect(foldName('Елхово')).toBe(foldName('Elkhovo'));
    expect(foldName('Алеко-Константиново')).toBe('aleko konstantinovo');
    expect(foldName('Щипско')).toBe('shtipsko');
  });
});

describe('ring coding', () => {
  it('round-trips at 1e-3 degrees and drops collapsed points', () => {
    const ring: [number, number][] = [
      [23.3241, 42.6977],
      [23.32411, 42.69771],
      [23.5, 42.8],
      [23.3241, 42.6977],
    ];
    const flat = encodeRing(ring);
    expect(flat).toHaveLength(6);
    expect(decodeRing(flat)).toStrictEqual([
      [23.324, 42.698],
      [23.5, 42.8],
      [23.324, 42.698],
    ]);
  });

  it('point-in-ring uses the even-odd rule', () => {
    const square: [number, number][] = [
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 1],
    ];
    expect(pointInRing(0.5, 0.5, square)).toBe(true);
    expect(pointInRing(1.5, 0.5, square)).toBe(false);
  });
});

describe('buildRegions', () => {
  it('emits the 28 oblasts in ISO order and assigns points, with a small tolerance', () => {
    const asset = buildRegions(syntheticOblasts(), 'test');
    expect(asset.regions.map(([iso]) => iso)).toStrictEqual(OBLAST_ISO_CODES);
    expect(regionOf(asset, 21.5, 42.5)).toBe('BG-22');
    // 1 km north of BG-01's top edge: a sliver, filed to the nearest oblast.
    expect(regionOf(asset, 0.5, 43.009)).toBe('BG-01');
    // Far outside: nobody's.
    expect(regionOf(asset, 0.5, 45)).toBeNull();
  });

  it('refuses a source that lacks an oblast or has an unknown one', () => {
    const fc = syntheticOblasts();
    expect(() => buildRegions({ features: fc.features.slice(1) }, 't')).toThrow(
      /missing oblasts: BG-01/,
    );
    const extra = { ...fc.features[0]!, properties: { adm0_a3: 'BGR', iso_3166_2: 'BG-99' } };
    expect(() => buildRegions({ features: [...fc.features, extra] }, 't')).toThrow(/BG-99/);
  });
});

describe('buildGazetteer', () => {
  const geonames = [
    // id, name, ascii, alternates, lat, lon, class, code, …, population at [14]
    [
      '727011',
      'Sofia',
      'Sofia',
      'Sofiya,София',
      '42.69751',
      '23.32415',
      'P',
      'PPLC',
      'BG',
      '',
      '42',
      '',
      '',
      '',
      '1152556',
    ],
    ['1', 'Elkhovo', 'Elkhovo', '', '42.5', '0.5', 'P', 'PPLA2', 'BG', '', '', '', '', '', '0'],
    [
      '2',
      'Zlatograd',
      'Zlatograd',
      'Златоград',
      '42.4',
      '1.5',
      'P',
      'PPL',
      'BG',
      '',
      '',
      '',
      '',
      '',
      '0',
    ],
    ['3', 'Oldtown', 'Oldtown', '', '42.4', '2.5', 'P', 'PPLH', 'BG', '', '', '', '', '', '0'],
    ['4', 'Samuilovo', 'Samuilovo', '', '42.3', '3.5', 'P', 'PPL', 'BG', '', '', '', '', '', '0'],
  ]
    .map((cols) => cols.join('\t'))
    .join('\n');
  const alternates = [
    ['10', '727011', 'bg', 'София', '1', '', '', ''],
    ['11', '1', 'bg', 'Елхово', '', '', '', ''],
    ['12', '1', 'bg', 'Elhovo', '', '', '', ''],
    ['13', '4', 'bg', 'Алексеево', '', '', '', ''],
    ['14', '4', 'bg', 'Старо име', '', '', '', '1'],
  ]
    .map((cols) => cols.join('\t'))
    .join('\n');

  it('keeps Cyrillic bg names only and drops historic ones', () => {
    const names = parseBulgarianNames(alternates);
    expect(names.get('1')).toStrictEqual(['Елхово']);
    expect(names.get('4')).toStrictEqual(['Алексеево']);
  });

  it('ranks, files into oblasts, and stores a Latin alias only when it adds a spelling', () => {
    const asset = buildGazetteer(
      geonames,
      alternates,
      buildRegions(syntheticOblasts(), 't'),
      'src',
    );
    expect(asset.places).toStrictEqual([
      ['София', 42698, 23324, 24, 0],
      // "Elkhovo" folds onto "Елхово": no alias stored.
      ['Елхово', 42500, 500, 1, 2],
      // GeoNames' Latin name is not a transliteration of the Bulgarian one: kept.
      ['Алексеево', 42300, 3500, 4, 4, 'Samuilovo'],
      // Alternate-names column fallback when the alternates table has no bg row.
      ['Златоград', 42400, 1500, 2, 4],
    ]);
  });

  it('ranks the capital, oblast seats and municipal seats first', () => {
    expect(rankOf('PPLC', 0)).toBe(0);
    expect(rankOf('PPLA', 0)).toBe(1);
    expect(rankOf('PPLA2', 0)).toBe(2);
    expect(rankOf('PPL', 12000)).toBe(3);
    expect(rankOf('PPL', 30)).toBe(4);
  });
});

describe('readZipMember', () => {
  function zipOf(name: string, body: Buffer, method: 0 | 8): Buffer {
    const data = method === 8 ? deflateRawSync(body) : body;
    const nameBytes = Buffer.from(name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(body.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(body.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(0, 42);
    const centralOffset = local.length + nameBytes.length + data.length;
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(1, 8);
    eocd.writeUInt16LE(1, 10);
    eocd.writeUInt32LE(central.length + nameBytes.length, 12);
    eocd.writeUInt32LE(centralOffset, 16);
    return Buffer.concat([local, nameBytes, data, central, nameBytes, eocd]);
  }

  it('reads stored and deflated members', () => {
    const body = Buffer.from('727011\tSofia\n'.repeat(20));
    expect(readZipMember(zipOf('BG.txt', body, 0), 'BG.txt').equals(body)).toBe(true);
    expect(readZipMember(zipOf('BG.txt', body, 8), 'BG.txt').equals(body)).toBe(true);
    expect(() => readZipMember(zipOf('BG.txt', body, 8), 'readme.txt')).toThrow(/not found/);
  });
});
