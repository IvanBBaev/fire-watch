import { describe, expect, it } from 'vitest';

import { placeName } from './place.js';

describe('placeName', () => {
  const names = { placeNameBg: 'Харманли', placeNameEn: 'Harmanli' };

  it('picks the Bulgarian name for bg', () => {
    expect(placeName(names, 'bg')).toBe('Харманли');
  });

  it('picks the English name for en', () => {
    expect(placeName(names, 'en')).toBe('Harmanli');
  });
});
