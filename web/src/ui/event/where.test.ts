import { describe, expect, it } from 'vitest';

import { approximateCentre, coordinatesText, openStreetMapAreaUrl } from './where.js';

describe('where', () => {
  it('rounds the centroid to two decimals, lat first', () => {
    const centre = approximateCentre(25.8974, 41.9281);
    expect(centre).toEqual({ lat: '41.93', lon: '25.90' });
    expect(coordinatesText(centre)).toBe('41.93, 25.90');
  });

  it('links an OpenStreetMap area view without a marker', () => {
    const url = openStreetMapAreaUrl(approximateCentre(25.8974, 41.9281));
    expect(url).toBe('https://www.openstreetmap.org/#map=12/41.93/25.90');
    expect(url).not.toMatch(/mlat|mlon|route|directions/);
  });
});
