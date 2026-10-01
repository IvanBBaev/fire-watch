import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import type { GazetteerAsset } from './gazetteer.js';
import { createGazetteer, isGazetteerAsset, zoomForPlace } from './gazetteer.js';

const ASSET: GazetteerAsset = {
  v: 1,
  source: 'test',
  scale: 1000,
  places: [
    ['София', 42698, 23324, 22, 0],
    ['Елхово', 42173, 26567, 28, 2],
    ['Софийско село', 42000, 23000, 23, 4],
    ['Долна баня', 42300, 23800, 23, 3],
    ['Алексеево', 42300, 3500, 4, 4, 'Samuilovo'],
  ],
};

describe('createGazetteer', () => {
  const gazetteer = createGazetteer(ASSET);

  it('finds a place by Cyrillic, Streamlined or older Latin spelling', () => {
    for (const q of ['София', 'софия', 'Sofia', 'Sofiya', 'sof']) {
      expect(gazetteer.search(q)[0]?.name, q).toBe('София');
    }
    expect(gazetteer.search('Elkhovo')[0]?.name).toBe('Елхово');
    expect(gazetteer.search('Elhovo')[0]?.name).toBe('Елхово');
  });

  it('searches the GeoNames Latin alias the build kept', () => {
    const [hit] = gazetteer.search('Samuilovo');
    expect(hit?.name).toBe('Алексеево');
    expect(hit?.latin).toBe('Samuilovo');
  });

  it('ranks exact before prefix before word-start before substring', () => {
    expect(gazetteer.search('sofi').map((p) => p.name)).toStrictEqual(['София', 'Софийско село']);
    expect(gazetteer.search('banya')[0]?.name).toBe('Долна баня');
    expect(gazetteer.search('ban').map((p) => p.name)).toStrictEqual(['Долна баня']);
  });

  it('decodes coordinates and the oblast, and ignores one-letter queries', () => {
    const [sofia] = gazetteer.search('София');
    expect(sofia).toMatchObject({ lat: 42.698, lon: 23.324, oblast: 22, rank: 0, latin: 'Sofia' });
    expect(gazetteer.search('с')).toStrictEqual([]);
  });

  it('zooms closer for smaller places', () => {
    const [sofia] = gazetteer.search('София');
    const [village] = gazetteer.search('Алексеево');
    expect(zoomForPlace(sofia!)).toBeLessThan(zoomForPlace(village!));
  });
});

describe('the shipped gazetteer asset', () => {
  const asset: unknown = JSON.parse(
    readFileSync(new URL('../../assets/geodata/settlements.json', import.meta.url), 'utf8'),
  );

  it('is well-formed and finds the places a reader would type', () => {
    expect(isGazetteerAsset(asset)).toBe(true);
    const gazetteer = createGazetteer(asset as GazetteerAsset);
    expect(gazetteer.size).toBeGreaterThan(5000);
    expect(gazetteer.search('Sofia')[0]).toMatchObject({ name: 'София', oblast: 22 });
    expect(gazetteer.search('Пловдив')[0]?.oblast).toBe(16);
    expect(gazetteer.search('Veliko Tarnovo')[0]?.name).toBe('Велико Търново');
    expect(gazetteer.search('Elkhovo')[0]?.name).toBe('Елхово');
  });
});
