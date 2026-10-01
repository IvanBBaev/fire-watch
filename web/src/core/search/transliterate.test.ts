import { describe, expect, it } from 'vitest';

import { foldName, transliterate } from './transliterate.js';

describe('transliterate', () => {
  it('follows the Streamlined System, including word-final ия', () => {
    expect(transliterate('София')).toBe('Sofia');
    expect(transliterate('Велико Търново')).toBe('Veliko Tarnovo');
    expect(transliterate('Кърджали')).toBe('Kardzhali');
    expect(transliterate('Щипско')).toBe('Shtipsko');
    expect(transliterate('Ямбол')).toBe('Yambol');
  });

  it('capitalises only the first letter of a digraph', () => {
    expect(transliterate('Шумен')).toBe('Shumen');
    expect(transliterate('ЖИВ')).toMatch(/^Zh/);
  });

  it('leaves non-Cyrillic text alone', () => {
    expect(transliterate('Sofia 42')).toBe('Sofia 42');
  });
});

describe('foldName', () => {
  it('meets Cyrillic and the common romanisations on one key', () => {
    expect(foldName('София')).toBe('sofia');
    expect(foldName('Sofiya')).toBe('sofia');
    expect(foldName('SOFIA')).toBe('sofia');
    expect(foldName('Велико Търново')).toBe(foldName('Veliko Tŭrnovo'));
    expect(foldName('Елхово')).toBe(foldName('Elkhovo'));
    expect(foldName('Алеко-Константиново')).toBe('aleko konstantinovo');
  });
});
