import { SOURCE_IDS } from '@fire-watch/contracts';
import { describe, expect, it } from 'vitest';

import { FAMILY_OF_SOURCE, familyOfSource, parseSourceFamily } from './source-families.js';

describe('source families', () => {
  it('files every contract source id under exactly one family', () => {
    for (const id of SOURCE_IDS) expect(FAMILY_OF_SOURCE[id], id).toMatch(/^[vmsg]$/);
  });

  it('is null for an id the contract does not know', () => {
    expect(familyOfSource('nope')).toBeNull();
    expect(familyOfSource('toString')).toBeNull();
  });

  it('parses only the four URL codes', () => {
    expect(parseSourceFamily('v')).toBe('v');
    expect(parseSourceFamily('g')).toBe('g');
    expect(parseSourceFamily('x')).toBeNull();
    expect(parseSourceFamily(null)).toBeNull();
    expect(parseSourceFamily('')).toBeNull();
  });
});
