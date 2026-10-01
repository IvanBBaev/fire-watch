import { describe, expect, it } from 'vitest';

import { parseCoordinates } from './coordinates.js';

describe('parseCoordinates', () => {
  it('reads decimal pairs with the separators people paste', () => {
    expect(parseCoordinates('42.6977, 23.3219')).toStrictEqual({ lat: 42.6977, lon: 23.3219 });
    expect(parseCoordinates('42.6977 23.3219')).toStrictEqual({ lat: 42.6977, lon: 23.3219 });
    expect(parseCoordinates('42.6977;23.3219')).toStrictEqual({ lat: 42.6977, lon: 23.3219 });
    expect(parseCoordinates('-12.5, -45')).toStrictEqual({ lat: -12.5, lon: -45 });
  });

  it('reads the Bulgarian decimal comma', () => {
    expect(parseCoordinates('42,6977 23,3219')).toStrictEqual({ lat: 42.6977, lon: 23.3219 });
    expect(parseCoordinates('42,6977; 23,3219')).toStrictEqual({ lat: 42.6977, lon: 23.3219 });
  });

  it('swaps a GeoJSON-order pair only when the swap is unambiguous', () => {
    expect(parseCoordinates('123.5, 42.1')).toStrictEqual({ lat: 42.1, lon: 123.5 });
    // Both readings valid: latitude first, as written.
    expect(parseCoordinates('23.32, 42.69')).toStrictEqual({ lat: 23.32, lon: 42.69 });
    expect(parseCoordinates('123, 123')).toBeNull();
  });

  it('reads degrees-minutes-seconds in either alphabet', () => {
    const latin = parseCoordinates('42°41\'49"N 23°19\'18"E');
    expect(latin?.lat).toBeCloseTo(42.6969, 3);
    expect(latin?.lon).toBeCloseTo(23.3217, 3);
    const cyrillic = parseCoordinates('42°41′49″ С, 23°19′18″ И');
    expect(cyrillic?.lat).toBeCloseTo(42.6969, 3);
    expect(cyrillic?.lon).toBeCloseTo(23.3217, 3);
    const west = parseCoordinates("10°30'S 20°15'W");
    expect(west?.lat).toBeCloseTo(-10.5, 5);
    expect(west?.lon).toBeCloseTo(-20.25, 5);
  });

  it('is null for names and junk, so search falls through to places', () => {
    for (const input of ['София', 'Sofia', '42', '42.1', '42.1, 23.2, 1', '', 'N 42 E']) {
      expect(parseCoordinates(input), input).toBeNull();
    }
  });
});
