import { describe, expect, it } from 'vitest';

import { formatMapHash, parseMapHash } from './hash.js';

describe('formatMapHash', () => {
  it('formats zoom to 1 decimal and lat/lon to 4', () => {
    expect(formatMapHash({ zoom: 7.2, lat: 42.7, lon: 25.3 })).toBe('#map=7.2/42.7000/25.3000');
  });

  it('rounds instead of truncating', () => {
    expect(formatMapHash({ zoom: 11.46, lat: 41.92849, lon: 25.89701 })).toBe(
      '#map=11.5/41.9285/25.8970',
    );
  });
});

describe('parseMapHash', () => {
  it('round-trips a formatted hash', () => {
    const view = { zoom: 7.2, lat: 42.7, lon: 25.3 };
    expect(parseMapHash(formatMapHash(view))).toEqual(view);
  });

  it('round-trips within formatting precision for arbitrary views', () => {
    const view = { zoom: 11.46, lat: 41.92849, lon: 25.89701 };
    const parsed = parseMapHash(formatMapHash(view));
    expect(parsed).not.toBeNull();
    expect(parsed?.zoom).toBeCloseTo(view.zoom, 1);
    expect(parsed?.lat).toBeCloseTo(view.lat, 4);
    expect(parsed?.lon).toBeCloseTo(view.lon, 4);
  });

  it('accepts the hash without a leading #', () => {
    expect(parseMapHash('map=7.2/42.7/25.3')).toEqual({ zoom: 7.2, lat: 42.7, lon: 25.3 });
  });

  it('tolerates other fragment members around ours', () => {
    expect(parseMapHash('#foo=bar&map=7.2/42.7/25.3&baz=1')).toEqual({
      zoom: 7.2,
      lat: 42.7,
      lon: 25.3,
    });
  });

  it.each([
    ['', 'empty string'],
    ['#', 'bare hash'],
    ['#map=', 'no segments'],
    ['#map=7.2/42.7', 'too few segments'],
    ['#map=7.2/42.7/25.3/0', 'too many segments'],
    ['#map=abc/42.7/25.3', 'non-numeric zoom'],
    ['#map=7.2/abc/25.3', 'non-numeric lat'],
    ['#map=7.2/42.7/abc', 'non-numeric lon'],
    ['#map=7.2//25.3', 'empty segment'],
    ['#map=NaN/42.7/25.3', 'NaN zoom'],
    ['#map=Infinity/42.7/25.3', 'infinite zoom'],
    ['#map=-1/42.7/25.3', 'zoom below range'],
    ['#map=25/42.7/25.3', 'zoom above range'],
    ['#map=7.2/91/25.3', 'lat above range'],
    ['#map=7.2/-91/25.3', 'lat below range'],
    ['#map=7.2/42.7/181', 'lon above range'],
    ['#map=7.2/42.7/-181', 'lon below range'],
    ['#route=/event/fw-2026-q7f3d', 'unrelated fragment'],
    ['#map', 'prefix without ='],
  ])('returns null on garbage: %s (%s)', (hash) => {
    expect(parseMapHash(hash)).toBeNull();
  });

  it('accepts range boundaries exactly', () => {
    expect(parseMapHash('#map=0/90/-180')).toEqual({ zoom: 0, lat: 90, lon: -180 });
    expect(parseMapHash('#map=24/-90/180')).toEqual({ zoom: 24, lat: -90, lon: 180 });
  });
});
