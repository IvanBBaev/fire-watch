import { describe, expect, it } from 'vitest';

import { CREDIT_PROVENANCE, creditSource } from './credit-provenance.js';
import { CREDITS } from './credits.js';

describe('CREDIT_PROVENANCE', () => {
  it('names a source and an authority for exactly the registry ids', () => {
    expect(Object.keys(CREDIT_PROVENANCE).sort()).toStrictEqual(
      CREDITS.map((credit) => credit.id).sort(),
    );
    for (const provenance of Object.values(CREDIT_PROVENANCE)) {
      expect(provenance.source.trim()).not.toBe('');
      expect(provenance.authority.trim()).not.toBe('');
    }
  });

  it('reads a credit source by id and refuses an unknown one', () => {
    expect(creditSource('osm')).toBe(
      'OpenStreetMap (basemap, place names, static hot-source mask)',
    );
    expect(() => creditSource('no-such-credit')).toThrow(RangeError);
  });
});
